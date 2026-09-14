// Exercises the hooks the extension actually registers, through the real `joinSession` call, with
// advice produced by the real review pipeline.
//
// `test.mjs` covers `lib.mjs`, which is pure and importable. It cannot reach `extension.mjs` at
// all: that file has no exports and ends in a top-level `await joinSession(...)`. Everything the
// delivery fix changed lives there, so until now it was verified by reading the source — which
// cannot tell whether a guard is wired to the callback the host will actually invoke.
//
// The harness swaps only the SDK specifier. The file under test is the shipped one, loaded from
// its own path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootExtension } from "./harness/host.mjs";

const CONCERN = { severity: "concern", note: "The retry loop drops the last attempt's error." };
const NIT = { severity: "nit", note: "Prefer a named constant over the literal 3600." };
const BLOCKER = { severity: "blocker", note: "Deleting the index makes this migration one-way." };

const edit = { toolName: "edit", toolArgs: '{"path":"a.mjs"}' };
const view = { toolName: "view", toolArgs: '{"path":"b.mjs"}' };

/** A distinct sub-agent id per call; measured ids on this host are bare uuids, not `bg-` prefixed. */
let subAgentSeq = 0;
const subAgent = () => ({ agentId: `9f2c0a1e-sub-${++subAgentSeq}` });

async function withAdvice(verdict, config) {
    const host = await bootExtension({ config });
    await host.runCheck(verdict);
    return host;
}

test("registers the three delivery hooks on the real session", async () => {
    const host = await bootExtension();
    const hooks = host.registered.hooks;
    for (const name of ["onPreToolUse", "onPostToolUse", "onAgentStop"]) {
        assert.equal(typeof hooks[name], "function", `${name} must be registered`);
    }
    // The prompt hook was removed in favour of classifying `user.message`; if it comes back the
    // sub-agent prompt guard it cannot implement comes back with it.
    assert.equal(hooks.onUserPromptSubmitted, undefined);
});

test("the harness overrides actually reach the extension's config", async () => {
    // Guards the harness itself. Every override below travels the real `loadConfig` path, and a
    // value the validator rejects is replaced by the default without failing — so a test that
    // believes it disabled blocking could quietly be exercising the opposite.
    const host = await bootExtension({ config: { blockOnBlocker: false } });
    const status = await host.status();
    assert.ok(status.includes(host.configPath), "config file must be the one in use");
    assert.match(status, /block on:\s+nothing/, "an override must survive validation");
});

test("the review pipeline really produces pending advice", async () => {
    const host = await withAdvice(CONCERN);
    assert.match(await host.status(), /pending advice: concern/);
    assert.equal(host.startedAgents.length, 1);
});

test("a concern is delivered once, by the post-tool hook, and never again", async () => {
    const host = await withAdvice(CONCERN);

    const first = await host.postToolUse(edit);
    assert.ok(first?.additionalContext?.includes(CONCERN.note), "first call must carry the advice");

    assert.equal(await host.postToolUse(edit), undefined, "second post-tool call gets nothing");
    assert.equal(await host.preToolUse(view), undefined, "later pre-tool call gets nothing");
    assert.match(await host.status(), /pending advice: none/);
});

test("a nit is delivered the same way", async () => {
    const host = await withAdvice(NIT);
    const out = await host.postToolUse(edit);
    assert.ok(out?.additionalContext?.includes(NIT.note));
});

test("advice is attributed to the advisor, not to the user", async () => {
    const host = await withAdvice(CONCERN);
    const out = await host.postToolUse(edit);
    assert.match(out.additionalContext, /^<advisor severity="concern">/);
    assert.match(out.additionalContext, /independent reviewer/);
});

test("a sub-agent's post-tool call does not consume advice meant for the main agent", async () => {
    const host = await withAdvice(CONCERN);

    assert.equal(await host.postToolUse(edit, subAgent()), undefined, "sub-agent gets nothing");
    assert.match(await host.status(), /pending advice: concern/, "advice must still be pending");

    const out = await host.postToolUse(edit);
    assert.ok(out?.additionalContext?.includes(CONCERN.note), "main agent still receives it");
});

test("a sub-agent's pre-tool call does not consume advice either", async () => {
    const host = await withAdvice(CONCERN);

    assert.equal(await host.preToolUse(edit, subAgent()), undefined);
    assert.match(await host.status(), /pending advice: concern/);

    const out = await host.preToolUse(edit);
    assert.ok(out?.additionalContext?.includes(CONCERN.note));
});

test("a sub-agent call on a different tool does not shadow the main agent's", async () => {
    const host = await withAdvice(CONCERN);

    // Sub-agent bracket left open across the main agent's dispatch: both are in `postToolUse` at
    // once, which is the situation the tool name has to discriminate.
    host.emit({
        type: "hook.start",
        agentId: "9f2c0a1e-concurrent",
        data: { hookInvocationId: "open-sub", hookType: "postToolUse", input: { toolName: "view" } },
    });

    const out = await host.postToolUse(edit);
    assert.ok(out?.additionalContext?.includes(CONCERN.note));
});

test("an ambiguous overlap fails open to the main agent", async () => {
    const host = await withAdvice(CONCERN);

    // Same tool name on both sides, so the payload cannot discriminate. The documented choice is
    // to treat that as the main agent's: a missing or ambiguous bracket must cost no more than
    // the behaviour that existed before attribution was added.
    host.emit({
        type: "hook.start",
        agentId: "9f2c0a1e-ambiguous",
        data: { hookInvocationId: "open-amb", hookType: "postToolUse", input: { toolName: "edit" } },
    });

    const out = await host.postToolUse(edit);
    assert.ok(out?.additionalContext?.includes(CONCERN.note), "must not be silently swallowed");
});

test("the post-tool hook refuses a blocker while blocking is on", async () => {
    const host = await withAdvice(BLOCKER);

    assert.equal(await host.postToolUse(edit), undefined, "a blocker is not commentary");
    assert.match(await host.status(), /pending advice: blocker/, "it must survive for enforcement");

    const denial = await host.preToolUse(edit);
    assert.equal(denial?.permissionDecision, "deny");
    assert.match(denial.permissionDecisionReason, /Advisor blocker/);
    assert.ok(denial.additionalContext.includes(BLOCKER.note));
});

test("a blocker no tool call carried still blocks the stop", async () => {
    const host = await withAdvice(BLOCKER);

    const stop = await host.agentStop();
    assert.equal(stop?.decision, "block");
    assert.ok(stop.reason.includes(BLOCKER.note));
    assert.match(await host.status(), /pending advice: none/);
});

test("a post-tool delivery leaves nothing for the stop hook to block on", async () => {
    const host = await withAdvice(CONCERN);

    await host.postToolUse(edit);
    assert.equal(await host.agentStop(), undefined, "no double delivery at the boundary");
});

test("with blocking disabled a blocker travels as ordinary context", async () => {
    const host = await withAdvice(BLOCKER, { blockOnBlocker: false });

    const out = await host.postToolUse(edit);
    assert.ok(out?.additionalContext?.includes(BLOCKER.note), "nothing left to preserve");
    assert.equal(out.permissionDecision, undefined);
    assert.equal(await host.agentStop(), undefined);
});

test("a sub-agent's stop is not the session's stop", async () => {
    const host = await withAdvice(BLOCKER);

    assert.equal(await host.agentStop({ sessionId: "some-other-session" }), undefined);
    assert.match(await host.status(), /pending advice: blocker/);
});

test("a re-entrant stop does not spend the block budget twice", async () => {
    const host = await withAdvice(BLOCKER);

    assert.equal(await host.agentStop({ stopHookActive: true }), undefined);
    assert.match(await host.status(), /pending advice: blocker/);
});

test("an interrupted turn is never reopened", async () => {
    const host = await withAdvice(BLOCKER);

    assert.equal(await host.agentStop({ stopReason: "max_tokens" }), undefined);
    assert.match(await host.status(), /pending advice: blocker/);
});

test("advice is never injected into a question the user is answering", async () => {
    const host = await withAdvice(CONCERN);

    assert.equal(await host.postToolUse({ toolName: "ask_user", toolArgs: "{}" }), undefined);
    assert.equal(await host.preToolUse({ toolName: "ask_user", toolArgs: "{}" }), undefined);
    assert.match(await host.status(), /pending advice: concern/);
});

test("advice that has gone stale is dropped rather than delivered late", async () => {
    const host = await withAdvice(CONCERN, { maxAdviceAgeMs: 1 });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await host.postToolUse(edit), undefined);
    assert.match(await host.status(), /pending advice: none/);
});
