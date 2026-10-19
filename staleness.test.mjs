// Advice must describe what the agent is doing now, not what it was doing when the review began.
// These drive the boundaries that make a verdict stale — a new user message, a new agentic loop, a
// HydraFusion commit — and the fusion gate that keeps reviews from firing into a commit burst,
// through the real extension and the real review pipeline.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootExtension } from "./harness/host.mjs";

const CONCERN = { severity: "concern", note: "The retry loop drops the last attempt's error." };
const QUIET = { severity: "none", note: "" };
const edit = { toolName: "edit", toolArgs: '{"path":"a.mjs"}' };

// Every main-agent tool call is due a review, so a review that does not start was gated.
const EVERY_CALL = { everyNToolCalls: 1, immuneToolCalls: 0, backoff: false };

let callSeq = 0;
const toolStart = (host, data = {}) =>
    host.emit({
        type: "tool.execution_start",
        data: { toolCallId: `call-${++callSeq}`, toolName: "view", arguments: { path: "x" }, ...data },
    });

const FUSION = "fusion-test-1";
const fusionResolved = (host, fusionId = FUSION) =>
    host.emit({ type: "session.fusion_resolved", data: { fusionId, pattern: "single" } });
const fusionCommit = (host, fusionId = FUSION) =>
    host.emit({ type: "session.fusion_commit_started", data: { fusionId, kind: "text", toolCallId: null } });
const fusionCompleted = (host, fusionId = FUSION) =>
    host.emit({ type: "session.fusion_completed", data: { fusionId, outcome: "completed" } });
const turnStart = (host, turnId, extra = {}) =>
    host.emit({ type: "assistant.turn_start", data: { turnId }, ...extra });

/**
 * Starts a review and crosses `boundary` while its agent is running — after the snapshot is taken
 * and before the verdict is read, which is the window a real review spends tens of seconds in.
 */
async function crossDuringReview(host, verdict, boundary) {
    const before = host.startedAgents.length;
    const check = host.runCheck(verdict);
    await host.waitFor(() => host.startedAgents.length > before, "review agent to start");
    boundary();
    await check;
}

test("a verdict that outlives a new user message is not delivered", async () => {
    const host = await bootExtension();
    await crossDuringReview(host, CONCERN, () =>
        host.emit({ type: "user.message", data: { content: "Stop, do something else." } }),
    );

    assert.match(await host.status(), /pending advice: none/);
    assert.equal(await host.postToolUse(edit), undefined);
    // Never silently lost: the agent will not see it, so the user must — even with
    // `logToTimeline` off, as the harness has it.
    const shown = host.logs.find((l) => l.includes(CONCERN.note));
    assert.ok(shown?.includes("UNDELIVERED"), `expected an UNDELIVERED timeline entry, got ${shown}`);
});

test("a verdict that outlives a new agent loop is not delivered", async () => {
    const host = await bootExtension();
    await crossDuringReview(host, CONCERN, () => turnStart(host, "0"));
    assert.match(await host.status(), /pending advice: none/);
});

test("a new agent loop drops advice still waiting for a tool call", async () => {
    const host = await bootExtension();
    await host.runCheck(CONCERN);
    // The commonest wake: the review's verdict is read before the "agent finished" notification
    // starts the woken turn, so the advice is already pending when the boundary arrives.
    turnStart(host, "0");
    assert.match(await host.status(), /pending advice: none/);
    const shown = host.logs.find((l) => l.includes(CONCERN.note));
    assert.ok(shown?.includes("UNDELIVERED"), `expected an UNDELIVERED timeline entry, got ${shown}`);
});

test("later turns of the same loop keep pending advice", async () => {
    const host = await bootExtension();
    await host.runCheck(CONCERN);
    turnStart(host, "4");
    assert.match(await host.status(), /pending advice: concern/);
});

test("a sub-agent's new loop is not the main agent's", async () => {
    const host = await bootExtension();
    await host.runCheck(CONCERN);
    turnStart(host, "0", { agentId: "9f2c0a1e-sub-1" });
    assert.match(await host.status(), /pending advice: concern/);
});

test("a fusion commit drops pending advice, and its replayed loops do not", async () => {
    const host = await bootExtension();
    fusionResolved(host);
    await host.runCheck(CONCERN);
    // Resolving a fusion is not a boundary: it arrives before the turn's own user message.
    assert.match(await host.status(), /pending advice: concern/);

    fusionCommit(host);
    assert.match(await host.status(), /pending advice: none/);

    // A forced review during the commit still produces advice — the same finding, which must not
    // be suppressed as a repeat of advice the agent never received. The commit's loops restart at
    // "0" and must not drop it as though the agent had begun something new.
    await host.runCheck(CONCERN);
    turnStart(host, "0");
    assert.match(await host.status(), /pending advice: concern/);

    fusionCompleted(host);
    turnStart(host, "0");
    assert.match(await host.status(), /pending advice: none/);
});

test("reviews pause while a fusion is open and resume when it completes", async () => {
    const host = await bootExtension({ config: EVERY_CALL });
    host.verdict = QUIET;

    fusionResolved(host);
    toolStart(host);
    fusionCommit(host);
    toolStart(host, { fusion: { fusionId: FUSION, pattern: "single", phaseKind: "commit" } });
    toolStart(host);
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0, "no review may start inside a fusion");

    fusionCompleted(host);
    toolStart(host);
    await host.waitFor(() => host.startedAgents.length === 1, "review after the fusion");
});

test("a fusion-tagged call is never reviewed, even when the fusion's start was missed", async () => {
    const host = await bootExtension({ config: EVERY_CALL });
    host.verdict = QUIET;
    toolStart(host, { fusion: { fusionId: FUSION, pattern: "single" } });
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0);
});

test("a steering message mid-fusion does not reopen reviews", async () => {
    const host = await bootExtension({ config: EVERY_CALL });
    host.verdict = QUIET;
    fusionResolved(host);
    host.emit({ type: "user.message", data: { content: "Also handle the empty case." } });
    toolStart(host);
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0);
});

// An aborted fusion was observed ending with a cancelled phase and no `fusion_completed`. Left
// open, it would silence the advisor for the rest of the session.
for (const [name, close] of [
    ["an abort", (host) => host.emit({ type: "abort", data: { reason: "user_initiated" } })],
    ["the session going idle", (host) => host.emit({ type: "session.idle", data: {} })],
    [
        "the next fusion resolving",
        (host) => {
            fusionResolved(host, "fusion-test-2");
            fusionCompleted(host, "fusion-test-2");
        },
    ],
]) {
    test(`a fusion that never completes is closed by ${name}`, async () => {
        const host = await bootExtension({ config: EVERY_CALL });
        host.verdict = QUIET;
        fusionResolved(host);
        close(host);
        toolStart(host);
        await host.waitFor(() => host.startedAgents.length === 1, "review after the fusion closed");
    });
}
