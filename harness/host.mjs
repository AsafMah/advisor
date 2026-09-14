// A minimal stand-in for the parts of the host session the extension actually uses, plus the
// machinery to drive its registered hooks the way the runtime does — including the
// `hook.start`/`hook.end` brackets that are the only thing carrying agent identity.
//
// Nothing here reimplements extension logic. The advice these tests deliver is produced by the
// real review pipeline: `advisor-check` -> `buildTranscriptDelta` -> `runAdvisorAgent` ->
// `parseVerdict` -> `state.pendingAdvice`. That matters because `state` is not exported, so the
// alternative would be asserting against advice the test injected itself, which proves the test
// can set a variable and nothing about the extension.

import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_URL = new URL("../extension.mjs", import.meta.url).href;
const SDK_SPECIFIER = "@github/copilot-sdk/extension";
const STUB_URL = new URL("./sdk-stub.mjs", import.meta.url).href;

// The extension imports the real SDK specifier, which does not resolve outside the host. Rather
// than copy the source or edit the import, redirect that one specifier and leave every other
// import — notably `./lib.mjs` — resolving normally, so the module under test is the shipped file
// byte for byte. `registerHooks` runs synchronously on this thread, so the stub can hand the
// session over through a module-scoped global; the older `module.register` runs hooks on a
// separate thread where that is impossible.
let registered = false;
function ensureLoader() {
    if (registered) return;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === SDK_SPECIFIER) return { url: STUB_URL, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
    registered = true;
}

// Each scenario needs its own `state`, and the extension keeps state in module scope. A distinct
// query string is the supported way to ask for a fresh module instance.
let instance = 0;

export const VERDICT_AGENT_ID = "adv-agent-internal";
export const VERDICT_TOOL_CALL_ID = "bg-advisor-task";

/**
 * Boots the real extension against a fake host.
 *
 * `config` is written to a temp file and pointed at with COPILOT_ADVISOR_CONFIG, which is the
 * extension's own first-choice config source — so the overrides travel the real `loadConfig`
 * path rather than being patched in.
 */
export async function bootExtension({ config = {}, sessionId = "main-session-id" } = {}) {
    ensureLoader();

    const dir = mkdtempSync(join(tmpdir(), "advisor-harness-"));
    const configPath = join(dir, "advisor.json");
    writeFileSync(
        configPath,
        JSON.stringify({
            // 250 is the validator's floor for this key, not an arbitrary small number: anything
            // below it is rejected and silently replaced by the default, which cost this harness
            // 2s a review until the status line was checked rather than assumed.
            pollIntervalMs: 250,
            timeoutMs: 5000,
            // The harness asserts on hook return values, not on side files.
            adviceLog: "",
            debugLog: "",
            logToTimeline: false,
            ...config,
        }),
    );

    const previousConfig = process.env.COPILOT_ADVISOR_CONFIG;
    const previousDir = process.env.COPILOT_CONFIG_DIR;
    process.env.COPILOT_ADVISOR_CONFIG = configPath;
    process.env.COPILOT_CONFIG_DIR = dir;

    const host = createHost(sessionId);
    host.configPath = configPath;
    globalThis.__ADVISOR_JOIN_SESSION__ = (options) => {
        host.registered = options;
        return host.session;
    };

    try {
        await import(`${EXTENSION_URL}?harness=${++instance}`);
    } finally {
        delete globalThis.__ADVISOR_JOIN_SESSION__;
        if (previousConfig === undefined) delete process.env.COPILOT_ADVISOR_CONFIG;
        else process.env.COPILOT_ADVISOR_CONFIG = previousConfig;
        if (previousDir === undefined) delete process.env.COPILOT_CONFIG_DIR;
        else process.env.COPILOT_CONFIG_DIR = previousDir;
    }

    if (!host.registered) throw new Error("extension did not call joinSession");
    return host;
}

function createHost(sessionId) {
    const events = [];
    const anyListeners = [];
    const namedListeners = new Map();
    const cancelled = [];
    const removed = [];
    const startedAgents = [];

    // What the fake advisor sub-agent will answer. Tests set this before running a check.
    const host = {
        sessionId,
        events,
        cancelled,
        removed,
        startedAgents,
        logs: [],
        verdict: null,
        registered: null,
    };

    const emit = (event) => {
        events.push(event);
        for (const fn of anyListeners) fn(event);
        for (const fn of namedListeners.get(event.type) ?? []) fn(event);
    };
    host.emit = emit;

    host.session = {
        sessionId,
        on(a, b) {
            if (typeof a === "function") anyListeners.push(a);
            else namedListeners.set(a, [...(namedListeners.get(a) ?? []), b]);
        },
        async log(text) {
            host.logs.push(text);
        },
        async send() {},
        async getEvents() {
            return events.slice();
        },
        rpc: {
            plan: {
                async read() {
                    return { exists: false };
                },
                async readSqlTodos() {
                    return { rows: [] };
                },
            },
            tasks: {
                async startAgent(args) {
                    startedAgents.push(args);
                    const agentId = `task-${startedAgents.length}`;

                    // The verdict appears in the event log the way a real sub-agent's does:
                    // a `subagent.started` carrying the task's `toolCallId`, then an
                    // `assistant.message` under the sub-agent's own internal `agentId`. Both
                    // carry an `agentId`, which is also what keeps them out of the next
                    // transcript delta.
                    emit({
                        type: "subagent.started",
                        agentId: VERDICT_AGENT_ID,
                        data: { toolCallId: VERDICT_TOOL_CALL_ID },
                    });
                    emit({
                        type: "assistant.message",
                        agentId: VERDICT_AGENT_ID,
                        data: { content: JSON.stringify(host.verdict) },
                    });
                    return { agentId };
                },
                async list() {
                    return {
                        tasks: startedAgents.map((_, i) => ({
                            id: `task-${i + 1}`,
                            status: "idle",
                            toolCallId: VERDICT_TOOL_CALL_ID,
                            result: null,
                            latestResponse: null,
                        })),
                    };
                },
                async cancel({ id }) {
                    cancelled.push(id);
                },
                async remove({ id }) {
                    removed.push(id);
                },
            },
        },
    };

    // --- driving the registered hooks -------------------------------------------------------

    let bracket = 0;

    /**
     * Runs a registered hook inside a `hook.start`/`hook.end` bracket, exactly as the runtime
     * does: the start event is dispatched before the handler and the end event after it returns.
     * `agentId` is null for the main agent and a bare uuid-shaped id for a sub-agent, matching
     * what was measured on this host.
     */
    const dispatch = async (hookName, hookType, input, { agentId = null, bracketInput } = {}) => {
        const hookInvocationId = `hook-${++bracket}`;
        emit({
            type: "hook.start",
            agentId,
            data: { hookInvocationId, hookType, input: bracketInput ?? input },
        });
        try {
            return await host.registered.hooks[hookName](input, { sessionId });
        } finally {
            emit({ type: "hook.end", agentId, data: { hookInvocationId } });
        }
    };
    host.dispatch = dispatch;

    // The bracket event and the handler argument carry DIFFERENT shapes, which is why this is not
    // simply input again. Measured against the real host (CLI 1.0.84-5) by tracing raw
    // hook.start payloads: preToolUse brackets carry {sessionId, cwd, toolCalls}, while the
    // handler receives {sessionId, timestamp, toolName, toolArgs, workingDirectory}. postToolUse
    // is the exception -- its bracket and handler agree, both carrying toolName/toolArgs.
    // To re-check after an upgrade, log Object.keys() on both sides in a throwaway extension.
    host.preToolUse = (input, opts = {}) =>
        dispatch("onPreToolUse", "preToolUse", input, {
            ...opts,
            bracketInput: { toolCalls: [{ name: input.toolName, args: input.toolArgs }] },
        });

    host.postToolUse = (input, opts = {}) =>
        dispatch("onPostToolUse", "postToolUse", input, {
            ...opts,
            bracketInput: { toolName: input.toolName },
        });

    host.agentStop = (input = {}) =>
        host.registered.hooks.onAgentStop(
            { sessionId, stopReason: "end_turn", ...input },
            { sessionId },
        );

    /**
     * Reads the extension's own view of its state through the `/advisor` command, which is the
     * only surface that exposes it — `state` is module-private, so asserting on it any other way
     * would mean asserting on a copy the test made.
     */
    host.status = async () => {
        const before = host.logs.length;
        await host.registered.commands.find((c) => c.name === "advisor").handler("");
        return host.logs.slice(before).join("\n");
    };

    /** Produces real pending advice by running the extension's own `/advisor-check` command. */
    host.runCheck = async (verdict) => {
        host.verdict = verdict;
        // The delta must contain at least one main-agent line or the check short-circuits with
        // "no new activity" before ever starting a review.
        emit({
            type: "tool.execution_start",
            data: { toolName: "edit", arguments: { path: "src/thing.mjs" } },
        });
        const command = host.registered.commands.find((c) => c.name === "advisor-check");
        if (!command) throw new Error("advisor-check command not registered");
        return command.handler("");
    };

    return host;
}

export { pathToFileURL };
