// Tests for what the extension registers with the host, driven through the real registration
// surface: `bootExtension` loads the shipped `extension.mjs` byte for byte and captures the
// options object it passes to `joinSession`. Nothing here asserts against a copy of the
// declaration made by the test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootExtension } from "./harness/host.mjs";

const SUB_AGENT_ID = "e7a9c1b3-5d2f-4b8e-a04c-9f1b3d5e7a20";

// --- registration ----------------------------------------------------------------------------

test("the extension registers its control tool", async () => {
    const host = await bootExtension();
    const tool = host.registered.tools?.find((t) => t.name === "advisor_control");

    assert.ok(tool, "advisor_control not registered");
    assert.equal(typeof tool.handler, "function");
    assert.deepEqual(tool.parameters.required, ["operation"]);
    assert.equal(tool.parameters.additionalProperties, false);
});

test("the tool description does not invite an agent to call it on finishing work", async () => {
    // This is the bug class the sub-agent guard was written for: a tool whose description says to
    // call it when work is done gets called by every `task` sub-agent that finishes.
    const host = await bootExtension();
    const { description } = host.registered.tools.find((t) => t.name === "advisor_control");

    assert.match(description, /Do not call it to announce that you have finished work/);
    assert.ok(!/when you (are )?(finish|done|complete)/i.test(description));
});

test("the extension registers the activity canvas with a wire-safe declaration", async () => {
    const host = await bootExtension();
    const canvas = host.canvas();

    assert.equal(canvas.declaration.id, "advisor-activity");
    assert.ok(canvas.declaration.displayName);
    assert.ok(canvas.declaration.description);
    assert.equal(typeof canvas.open, "function");
    assert.equal(typeof canvas.onClose, "function");

    // The handler closure is stripped before the declaration goes over the wire.
    for (const action of canvas.declaration.actions) {
        assert.equal(action.handler, undefined, `${action.name} leaked its handler into the declaration`);
        assert.ok(!action.name.startsWith("canvas."), "reserved prefix");
    }
    assert.ok(JSON.stringify(canvas.declaration).length > 0, "declaration must be serialisable");
});

test("registering the canvas does not disturb the existing hooks and commands", async () => {
    const host = await bootExtension();
    assert.equal(typeof host.registered.hooks.onPreToolUse, "function");
    assert.equal(typeof host.registered.hooks.onPostToolUse, "function");
    assert.equal(typeof host.registered.hooks.onAgentStop, "function");
    for (const name of ["advisor", "advisor-check", "advisor-on", "advisor-off", "advisor-log"]) {
        assert.ok(
            host.registered.commands.some((c) => c.name === name),
            `command ${name} disappeared`,
        );
    }
});

// --- read operations -------------------------------------------------------------------------

test("status through the tool reports the same state as the slash command", async () => {
    // The tool and the command must not drift into two different answers, which is the whole
    // reason they share a control layer.
    const host = await bootExtension();
    const viaTool = await host.callTool("advisor_control", { operation: "status" });
    const viaCommand = await host.status();

    assert.match(viaTool, /^advisor status\n/);
    assert.equal(viaTool.trim(), viaCommand.trim());
});

test("status is available to a sub-agent", async () => {
    const host = await bootExtension();
    const result = await host.callTool("advisor_control", { operation: "status" }, { agentId: SUB_AGENT_ID });
    assert.match(result, /^advisor status\n/);
});

test("an unknown operation is refused rather than silently ignored", async () => {
    const host = await bootExtension();
    const result = await host.callTool("advisor_control", { operation: "destroy_everything" });
    assert.match(result, /unknown operation/);
    assert.match(result, /status/, "the refusal lists what is actually available");
});

test("log reports the advice log is disabled when it is", async () => {
    const host = await bootExtension({ config: { adviceLog: "" } });
    const result = await host.callTool("advisor_control", { operation: "log" });
    assert.match(result, /adviceLog is disabled/);
});

// --- confirmation ------------------------------------------------------------------------------

/** Installs a `session.ui.confirm` that records what it was asked and answers as told. */
function withConfirm(host, answer) {
    const asked = [];
    host.session.ui = {
        async confirm(message) {
            asked.push(message);
            if (typeof answer === "function") return answer(message);
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    return asked;
}

test("a mutating operation applies only after the user confirms", async () => {
    const host = await bootExtension();
    const asked = withConfirm(host, true);

    const result = await host.callTool("advisor_control", { operation: "disable" });
    assert.match(result, /disabled for this session/);
    assert.equal(asked.length, 1);
    assert.match(await host.status(), /enabled:\s+false/);
});

test("the confirmation names the exact change proposed", async () => {
    const host = await bootExtension({ config: { model: "gpt-5.6-terra", everyNToolCalls: 12 } });
    const asked = withConfirm(host, false);

    await host.callTool("advisor_control", { operation: "set_model", model: "gpt-5.4" });
    await host.callTool("advisor_control", { operation: "set_cadence", everyNToolCalls: 40 });

    assert.match(asked[0], /gpt-5\.6-terra/);
    assert.match(asked[0], /gpt-5\.4/);
    assert.match(asked[1], /every 12 tool calls/);
    assert.match(asked[1], /every 40/);
});

test("declining leaves state untouched and says so", async () => {
    const host = await bootExtension();
    withConfirm(host, false);

    const result = await host.callTool("advisor_control", { operation: "disable" });
    assert.match(result, /was NOT applied/);
    assert.match(result, /declined/);
    assert.match(await host.status(), /enabled:\s+true/, "state changed despite the user declining");
});

test("a host that cannot ask is treated as a decline, not as permission", async () => {
    // `session.ui.confirm` throws outright where the host has no elicitation support. A host that
    // cannot ask cannot have been answered.
    const host = await bootExtension();
    withConfirm(host, new Error("elicitation not supported"));

    const result = await host.callTool("advisor_control", { operation: "disable" });
    assert.match(result, /was NOT applied/);
    assert.match(result, /cannot show a confirmation dialog/);
    assert.match(await host.status(), /enabled:\s+true/);
});

test("a host with no ui api at all is treated as a decline", async () => {
    const host = await bootExtension();
    delete host.session.ui;

    const result = await host.callTool("advisor_control", { operation: "disable" });
    assert.match(result, /was NOT applied/);
    assert.match(await host.status(), /enabled:\s+true/);
});

test("every mutating operation is gated by confirmation", async () => {
    for (const args of [
        { operation: "enable" },
        { operation: "disable" },
        { operation: "set_model", model: "some-model" },
        { operation: "set_cadence", everyNToolCalls: 7 },
        { operation: "reload_config" },
    ]) {
        const host = await bootExtension();
        const asked = withConfirm(host, false);
        const result = await host.callTool("advisor_control", args);
        assert.equal(asked.length, 1, `${args.operation} did not ask`);
        assert.match(result, /was NOT applied/, `${args.operation} applied without confirmation`);
    }
});

test("read operations never prompt", async () => {
    const host = await bootExtension();
    const asked = withConfirm(host, true);

    await host.callTool("advisor_control", { operation: "status" });
    await host.callTool("advisor_control", { operation: "log" });

    assert.deepEqual(asked, [], "a read asked the user to confirm something");
});

test("a missing argument is reported without prompting", async () => {
    const host = await bootExtension();
    const asked = withConfirm(host, true);

    assert.match(await host.callTool("advisor_control", { operation: "set_model" }), /advisor model:/);
    assert.match(await host.callTool("advisor_control", { operation: "set_cadence" }), /advisor cadence:/);
    assert.deepEqual(asked, [], "asked the user to confirm a change that was never proposed");
});

// --- sub-agent gating ---------------------------------------------------------------------------

test("a sub-agent cannot change the advisor, and is not even offered the dialog", async () => {
    // Advisor spawns its own review sub-agent, which can see this tool. Without the gate the
    // reviewer could switch off the review it is running.
    const host = await bootExtension();
    const asked = withConfirm(host, true);

    const result = await host.callTool("advisor_control", { operation: "disable" }, { agentId: SUB_AGENT_ID });
    assert.match(result, /main agent only/);
    assert.deepEqual(asked, [], "a sub-agent got to raise a dialog in the user's face");
    assert.match(await host.status(), /enabled:\s+true/);
});

test("the main agent is not mistaken for a sub-agent", async () => {
    // The main agent's `external_tool.requested` carries no agentId. This is the other half of
    // the guard: over-blocking would make the tool useless where it is supposed to work.
    const host = await bootExtension();
    withConfirm(host, true);

    const result = await host.callTool("advisor_control", { operation: "disable" }, { agentId: null });
    assert.match(result, /disabled for this session/);
});

test("a sub-agent call is identified even though the event arrives after the handler starts", async () => {
    // The SDK invokes the handler from inside its own dispatch of `external_tool.requested`,
    // before that event reaches `session.on`. `host.callTool` reproduces that order deliberately,
    // so this asserts the yield works rather than that a lookup happened to be populated.
    const host = await bootExtension();
    const pending = host.callTool("advisor_control", { operation: "enable" }, { agentId: SUB_AGENT_ID });
    assert.match(await pending, /main agent only/);
});

test("one sub-agent's tool call does not taint the main agent's next one", async () => {
    const host = await bootExtension();
    withConfirm(host, true);

    await host.callTool("advisor_control", { operation: "disable" }, { agentId: SUB_AGENT_ID, toolCallId: "sub-1" });
    const result = await host.callTool("advisor_control", { operation: "disable" }, { toolCallId: "main-1" });
    assert.match(result, /disabled for this session/);
});

// --- review --------------------------------------------------------------------------------------

test("review is queued, not awaited inside the open tool call", async () => {
    // Starting a sub-agent and waiting for it from inside an open tool call nests one host
    // round-trip inside another, and the review would be reading a transcript that does not yet
    // contain the call that asked for it. The request is released by this call's own completion.
    const host = await bootExtension({ config: { minSeverityToInject: "nit" } });
    host.verdict = { severity: "concern", note: "SECRET-ADVICE-BODY" };
    host.emit({ type: "tool.execution_start", data: { toolName: "edit", arguments: { path: "a.mjs" } } });

    const result = await host.callTool("advisor_control", { operation: "review" }, { toolCallId: "manual-1" });
    assert.match(result, /review queued/);
    assert.ok(!result.includes("SECRET-ADVICE-BODY"), "the advice text leaked through the tool");
    assert.equal(host.startedAgents.length, 0, "a reviewer was started while the tool call was still open");
});

test("the queued review starts when the tool call completes", async () => {
    const host = await bootExtension({ config: { minSeverityToInject: "nit" } });
    host.verdict = { severity: "blocker", note: "do not ship" };
    host.emit({ type: "tool.execution_start", data: { toolName: "edit", arguments: { path: "a.mjs" } } });
    await host.callTool("advisor_control", { operation: "review" }, { toolCallId: "manual-1" });

    host.emit({ type: "tool.execution_complete", data: { toolCallId: "manual-1" } });

    await host.waitFor(
        async () => /pending advice: blocker/.test(await host.status()),
        "the queued review to raise its blocker",
    );
    assert.equal(host.startedAgents.length, 1, "completion did not release exactly one review");
});

test("an unrelated tool call completing does not release the queued review", async () => {
    const host = await bootExtension();
    host.verdict = { severity: "none", note: "" };
    await host.callTool("advisor_control", { operation: "review" }, { toolCallId: "manual-1" });

    host.emit({ type: "tool.execution_complete", data: { toolCallId: "something-else" } });
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0);
});

test("a queued review fires once, not on every later completion", async () => {
    const host = await bootExtension({ config: { minSeverityToInject: "nit" } });
    host.verdict = { severity: "nit", note: "small" };
    host.emit({ type: "tool.execution_start", data: { toolName: "edit", arguments: { path: "a.mjs" } } });
    await host.callTool("advisor_control", { operation: "review" }, { toolCallId: "manual-1" });

    // The first review must be finished before the repeat, or an in-flight guard would make this
    // pass without the queue entry ever having been consumed.
    host.emit({ type: "tool.execution_complete", data: { toolCallId: "manual-1" } });
    await host.waitFor(
        async () => /pending advice: nit/.test(await host.status()),
        "the first queued review to finish",
    );

    host.emit({ type: "tool.execution_complete", data: { toolCallId: "manual-1" } });
    await host.quiesce();
    assert.equal(host.startedAgents.length, 1, "the queued review fired more than once");
});

test("a sub-agent cannot ask for a review", async () => {
    // The advisor's own reviewer can see this tool. Left open, it could start a second review of
    // itself and disturb the cadence and pending state of the review already running.
    const host = await bootExtension();
    const result = await host.callTool(
        "advisor_control",
        { operation: "review" },
        { agentId: SUB_AGENT_ID, toolCallId: "sub-review" },
    );

    assert.match(result, /main agent only/);
    host.emit({ type: "tool.execution_complete", data: { toolCallId: "sub-review" } });
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0, "a sub-agent got a review queued anyway");
});

test("review on a disabled advisor starts nothing", async () => {
    const host = await bootExtension({ config: { enabled: false } });
    const result = await host.callTool("advisor_control", { operation: "review" }, { toolCallId: "manual-1" });
    assert.match(result, /disabled for this session/);

    host.emit({ type: "tool.execution_complete", data: { toolCallId: "manual-1" } });
    await host.quiesce();
    assert.equal(host.startedAgents.length, 0);
});

// --- canvas lifecycle -------------------------------------------------------------------------

test("opening the canvas returns a loopback url the host can frame", async () => {
    const host = await bootExtension();
    const result = await host.openCanvas("panel-1");
    try {
        assert.ok(result.url.startsWith("http://127.0.0.1:"), `not loopback: ${result.url}`);
        assert.ok(result.title);
        assert.equal(result.status, "watching");
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("re-opening the same instance focuses the same panel rather than starting a second server", async () => {
    // Re-opening an existing instanceId is how the host focuses a panel and how it rehydrates
    // after a renderer reload. A second server here would leak a port per reload.
    const host = await bootExtension();
    try {
        const first = await host.openCanvas("panel-1");
        const second = await host.openCanvas("panel-1");
        assert.equal(first.url, second.url);
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("two instances get two panels", async () => {
    const host = await bootExtension();
    try {
        const first = await host.openCanvas("panel-1");
        const second = await host.openCanvas("panel-2");
        assert.notEqual(first.url, second.url);
    } finally {
        await host.closeCanvas("panel-1");
        await host.closeCanvas("panel-2");
    }
});

test("open reports the advisor's actual state rather than a fixed ready label", async () => {
    const host = await bootExtension({ config: { enabled: false } });
    try {
        assert.equal((await host.openCanvas("panel-1")).status, "disabled");
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("closing a panel releases it, and closing twice is harmless", async () => {
    const host = await bootExtension();
    const { url } = await host.openCanvas("panel-1");
    await host.closeCanvas("panel-1");
    await host.closeCanvas("panel-1");

    const port = Number.parseInt(new URL(url).port, 10);
    const reopened = await host.openCanvas("panel-1");
    try {
        assert.notEqual(Number.parseInt(new URL(reopened.url).port, 10), port, "closed panel kept its port");
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("the refresh action reaches an open panel and reports how many renderers it told", async () => {
    const host = await bootExtension();
    try {
        await host.openCanvas("panel-1");
        const result = await host.canvasAction("refresh", "panel-1");
        assert.equal(result.refreshed, true);
        assert.equal(result.renderers, 0, "no renderer is attached in a headless test");
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("the refresh action on an unknown instance says so instead of throwing", async () => {
    const host = await bootExtension();
    const result = await host.canvasAction("refresh", "never-opened");
    assert.equal(result.refreshed, false);
    assert.match(result.reason, /no open advisor panel/);
});

// --- activity feed ----------------------------------------------------------------------------

test("raised advice reaches the panel snapshot", async () => {
    const host = await bootExtension({ config: { minSeverityToInject: "nit" } });
    await host.runCheck({ severity: "concern", note: "a real concern" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const res = await fetch(`${url}state`);
        const body = await res.json();
        const concern = body.entries.find((e) => e.tag === "concern");
        assert.ok(concern, `no concern entry in ${JSON.stringify(body.entries)}`);
        assert.match(concern.detail, /a real concern/);
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("advice dropped below the severity threshold is still shown, with why", async () => {
    // The panel exists to show what happened. Wiring it to the delivery path instead would hide
    // every outcome that was dropped, which is the most diagnostic data there is.
    const host = await bootExtension({ config: { minSeverityToInject: "blocker" } });
    await host.runCheck({ severity: "nit", note: "trivial thing" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const body = await (await fetch(`${url}state`)).json();
        const nit = body.entries.find((e) => e.tag === "nit");
        assert.ok(nit, "a dropped nit vanished from the panel");
        assert.match(nit.title, /below minSeverityToInject/);
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("reading the panel state does not add to it", async () => {
    // The audit records control invocations, not calls to the shared helpers those invocations
    // happen to use. If the snapshot logged its own read, an open panel — which re-reads on every
    // status tick and every refresh — would grow its own feed without end.
    const host = await bootExtension();
    await host.runCheck({ severity: "concern", note: "one real entry" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const first = await (await fetch(`${url}state`)).json();
        for (let i = 0; i < 5; i++) {
            await (await fetch(`${url}state`)).json();
            await host.canvasAction("refresh", "panel-1");
        }
        const last = await (await fetch(`${url}state`)).json();

        assert.equal(last.entries.length, first.entries.length, "reading the panel added entries");
        assert.deepEqual(
            last.entries.map((e) => e.seq),
            first.entries.map((e) => e.seq),
            "reading the panel changed its entries",
        );
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("reading advisor status through the tool is not itself audited", async () => {
    const host = await bootExtension();
    await host.callTool("advisor_control", { operation: "status" });
    await host.callTool("advisor_control", { operation: "log" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const body = await (await fetch(`${url}state`)).json();
        assert.equal(
            body.entries.filter((e) => e.tag === "control").length,
            0,
            "a read was recorded as a control action",
        );
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("a confirmed control change is recorded as an audit entry", async () => {
    const host = await bootExtension();
    withConfirm(host, true);
    await host.callTool("advisor_control", { operation: "disable" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const body = await (await fetch(`${url}state`)).json();
        const control = body.entries.find((e) => e.tag === "control");
        assert.ok(control, "the advisor going quiet left no visible cause");
        assert.match(control.title, /disabled/);
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("a declined control change is recorded too", async () => {
    const host = await bootExtension();
    withConfirm(host, false);
    await host.callTool("advisor_control", { operation: "disable" });

    const { url } = await host.openCanvas("panel-1");
    try {
        const body = await (await fetch(`${url}state`)).json();
        const control = body.entries.find((e) => e.tag === "control");
        assert.ok(control, "an attempt to silence the reviewer left no trace");
        assert.match(control.title, /not applied/);
    } finally {
        await host.closeCanvas("panel-1");
    }
});

test("the panel reports live status, not a cached ready state", async () => {
    const host = await bootExtension({ config: { enabled: false } });
    const { url } = await host.openCanvas("panel-1");
    try {
        const body = await (await fetch(`${url}state`)).json();
        assert.equal(body.status.enabled, false);
        assert.equal(body.status.checksRun, 0);
    } finally {
        await host.closeCanvas("panel-1");
    }
});
