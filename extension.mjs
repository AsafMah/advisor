// advisor — an independent reviewer model that watches the main agent work
// and intervenes when it drifts, forgets, or is about to do something wrong.
//
// Inspired by oh-my-pi's WATCHDOG advisor. See README.md.

import { joinSession } from "@github/copilot-sdk/extension";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
    enabled: true,
    model: "gpt-5.6-terra",
    agentType: "rubber-duck",
    everyNToolCalls: 12,
    immuneToolCalls: 4,
    blockOnBlocker: true,
    minSeverityToInject: "nit",
    maxTranscriptChars: 24000,
    maxToolResultChars: 1200,
    timeoutMs: 180000,
    pollIntervalMs: 2000,
    logToTimeline: true,
    debugLog: join(homedir(), ".copilot", "logs", "advisor.log"),
    instructions: "",
};

const SEVERITY_RANK = { none: 0, nit: 1, concern: 2, blocker: 3 };

// How many consecutive settled-but-empty polls to tolerate before giving up, to absorb the lag
// between a sub-agent reporting "idle" and its result becoming readable.
const SETTLED_EMPTY_POLL_LIMIT = 8;

function loadConfig(workingDirectory) {
    const candidates = [
        process.env.COPILOT_ADVISOR_CONFIG,
        workingDirectory ? join(workingDirectory, ".github", "advisor.json") : undefined,
        join(homedir(), ".copilot", "advisor.json"),
    ].filter(Boolean);

    for (const path of candidates) {
        try {
            if (!existsSync(path)) continue;
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            return { ...DEFAULTS, ...parsed, _configPath: path };
        } catch {
            // A malformed config must not take the extension down; fall through to defaults.
        }
    }
    return { ...DEFAULTS, _configPath: null };
}

let config = loadConfig(process.cwd());

const state = {
    goal: "",
    toolCallsThisTurn: 0,
    toolCallsSinceCheck: 0,
    lastEventIndex: 0,
    checkInFlight: false,
    pendingAdvice: null,
    lastAdviceNote: "",
    checksRun: 0,
    adviceDelivered: 0,
    lastError: null,
    sessionOverrides: {},
};

const cfg = (key) => state.sessionOverrides[key] ?? config[key];

function debug(message) {
    const path = cfg("debugLog");
    if (!path) return;
    try {
        appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Logging must never break the review loop.
    }
}

function truncate(text, limit) {
    const str = typeof text === "string" ? text : JSON.stringify(text ?? "");
    if (str.length <= limit) return str;
    return `${str.slice(0, limit)}\n…[truncated ${str.length - limit} chars]`;
}

function renderEvent(event) {
    const d = event?.data ?? {};
    switch (event?.type) {
        case "user.message":
            return d.content ? `USER: ${truncate(d.content, 2000)}` : null;
        case "assistant.message":
            return d.content ? `AGENT: ${truncate(d.content, 2000)}` : null;
        case "tool.execution_start":
            return `TOOL_CALL ${d.toolName}: ${truncate(d.arguments, 600)}`;
        case "tool.execution_complete": {
            const status = d.success === false ? "FAILED" : "ok";
            const body = d.success === false ? d.error : d.result;
            return `TOOL_RESULT ${d.toolName} [${status}]: ${truncate(body, cfg("maxToolResultChars"))}`;
        }
        default:
            return null;
    }
}

async function buildTranscriptDelta(session) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch (err) {
        state.lastError = `getEvents failed: ${err?.message ?? err}`;
        return null;
    }

    const delta = events.slice(state.lastEventIndex);
    state.lastEventIndex = events.length;

    const lines = delta.map(renderEvent).filter(Boolean);
    if (lines.length === 0) return null;

    // Keep the tail: the most recent activity is what needs reviewing.
    let text = lines.join("\n\n");
    const limit = cfg("maxTranscriptChars");
    if (text.length > limit) text = `…[earlier activity omitted]\n\n${text.slice(-limit)}`;
    return text;
}

function buildPrompt(transcript) {
    const extra = cfg("instructions");
    return `You are an ADVISOR. You are watching another AI coding agent work on a user's request. \
You do NOT do the work yourself and you do NOT talk to the user.

<user_goal>
${state.goal || "(not captured — infer it from the transcript)"}
</user_goal>

<recent_activity>
${transcript}
</recent_activity>

Decide whether the main agent needs an intervention RIGHT NOW.

Intervene for things like:
- drifting from what the user actually asked for, or silently expanding scope
- acting on an unverified assumption that the transcript shows is probably wrong
- forgetting an explicit constraint or requirement the user stated
- repeating an approach that has already failed
- about to do something destructive, irreversible, or outside the requested scope
- claiming success without having verified it

Do NOT comment on style, formatting, naming, or things the agent is obviously about to do next.
Do NOT restate what the agent is doing. Silence is the correct answer most of the time.

You may read files (read/grep/glob) to check a claim. Do not modify anything, and do not run destructive commands.

Respond with EXACTLY ONE JSON object and nothing else:
{"severity": "none" | "nit" | "concern" | "blocker", "note": "..."}

- "none"    — no intervention needed. note must be "".
- "nit"     — minor, worth a mention, non-interrupting.
- "concern" — the agent is likely to waste effort or produce a wrong result.
- "blocker" — the agent is about to do something wrong, harmful, or irreversible, \
or has already gone off the rails. This WILL interrupt it, so use it sparingly.

"note" must be under 500 characters, specific and actionable, and reference concrete files, \
functions, or requirements.${extra ? `\n\nAdditional project-specific instructions:\n${extra}` : ""}`;
}

function parseVerdict(raw) {
    if (!raw || typeof raw !== "string") return { severity: "none", note: "" };

    // The advisor may wrap its JSON in prose or a fenced block; take the last object that parses.
    const matches = raw.match(/\{[\s\S]*?\}/g);
    if (!matches) return { severity: "none", note: "" };

    for (const candidate of matches.reverse()) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed?.severity !== "string") continue;
            const severity = parsed.severity.toLowerCase();
            if (!(severity in SEVERITY_RANK)) continue;
            return { severity, note: sanitizeNote(parsed.note) };
        } catch {
            // Not the JSON we want; keep looking.
        }
    }
    return { severity: "none", note: "" };
}

// The advisor's output flows into the main agent's context, so treat it as untrusted text.
function sanitizeNote(note) {
    if (typeof note !== "string") return "";
    let clean = note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
    clean = clean.replace(/<\/?(system|instructions?|advisor)>/gi, "");
    if (/ignore (all )?(your |the )?(previous|prior|above) instructions/i.test(clean)) return "";
    return clean.slice(0, 800);
}

function formatAdvice(advice) {
    return `<advisor severity="${advice.severity}">
${advice.note}
</advisor>
The above is from an independent reviewer model watching your work. It cannot see your full \
context and may be wrong — weigh it against what you know. If it is wrong, say so briefly and continue.`;
}

async function runAdvisorAgent(session, prompt) {
    const rpc = session.rpc;
    if (!rpc?.tasks?.startAgent) throw new Error("session.rpc.tasks.startAgent unavailable");

    const { agentId } = await rpc.tasks.startAgent({
        agentType: cfg("agentType"),
        prompt,
        name: "advisor",
        description: "Advisor review",
        model: cfg("model"),
    });
    debug(`started advisor agent ${agentId} on ${cfg("model")}`);

    const deadline = Date.now() + cfg("timeoutMs");
    let seen = false;
    let emptySettledPolls = 0;

    try {
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, cfg("pollIntervalMs")));

            let tasks = [];
            try {
                ({ tasks } = await rpc.tasks.list());
            } catch (err) {
                throw new Error(`tasks.list failed: ${err?.message ?? err}`);
            }

            const task = tasks.find((t) => t.id === agentId);
            if (!task) {
                // Disappeared before we ever saw it running — nothing to report.
                if (seen) return "";
                continue;
            }
            seen = true;
            debug(`poll ${agentId}: status=${task.status} resultLen=${task.result?.length ?? "null"}`);

            if (task.status === "failed") throw new Error(task.error || "advisor agent failed");
            if (task.status === "cancelled") return "";

            // A multi-turn agent parks in "idle" after answering rather than "completed", and
            // a freshly-started agent can also report "idle" before it has produced anything.
            // Only a non-empty result means the review is actually done.
            if (task.status === "completed" || task.status === "idle") {
                if (task.result) return task.result;
                if (++emptySettledPolls >= SETTLED_EMPTY_POLL_LIMIT) {
                    debug(`${agentId} settled with no result after ${emptySettledPolls} polls`);
                    return "";
                }
            } else {
                emptySettledPolls = 0;
            }
        }
        throw new Error(`advisor agent timed out after ${cfg("timeoutMs")}ms`);
    } finally {
        // The agent parks idle and would otherwise accumulate in the task list forever.
        await disposeTask(rpc, agentId);
    }
}

async function disposeTask(rpc, agentId) {
    try {
        await rpc.tasks.cancel({ id: agentId });
    } catch {
        // Already settled.
    }
    try {
        await rpc.tasks.remove({ id: agentId });
    } catch {
        // Not removable; nothing more we can do.
    }
}

async function runCheck(session, { force = false } = {}) {
    if (state.checkInFlight) return { skipped: "already running" };
    state.checkInFlight = true;
    state.toolCallsSinceCheck = 0;
    debug(`check starting (force=${force}, checksRun=${state.checksRun})`);

    try {
        const transcript = await buildTranscriptDelta(session);
        if (!transcript) return { skipped: "no new activity" };

        state.checksRun++;
        const raw = await runAdvisorAgent(session, buildPrompt(transcript));
        const advice = parseVerdict(raw);
        debug(`verdict: ${advice.severity} | raw=${truncate(raw, 300)}`);

        if (advice.severity === "none" || !advice.note) {
            if (force && cfg("logToTimeline")) {
                await session.log("advisor: no concerns", { ephemeral: true });
            }
            return { severity: "none" };
        }

        // Don't repeat identical advice the agent has already been given.
        if (advice.note === state.lastAdviceNote) return { skipped: "duplicate advice" };

        if (SEVERITY_RANK[advice.severity] < SEVERITY_RANK[cfg("minSeverityToInject")]) {
            return { skipped: `below minSeverityToInject (${advice.severity})` };
        }

        state.pendingAdvice = advice;
        state.lastAdviceNote = advice.note;

        if (cfg("logToTimeline")) {
            const level = advice.severity === "blocker" ? "warning" : "info";
            await session.log(`advisor [${advice.severity}]: ${advice.note}`, { level });
        }
        return advice;
    } catch (err) {
        state.lastError = err?.message ?? String(err);
        debug(`ERROR: ${state.lastError}`);
        if (force && cfg("logToTimeline")) {
            await session.log(`advisor error: ${state.lastError}`, { level: "error" });
        }
        return { error: state.lastError };
    } finally {
        state.checkInFlight = false;
    }
}

function takePendingAdvice() {
    const advice = state.pendingAdvice;
    state.pendingAdvice = null;
    if (advice) state.adviceDelivered++;
    return advice;
}

const session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async (input) => {
            state.goal = input.prompt ?? "";
            state.toolCallsThisTurn = 0;
            state.toolCallsSinceCheck = 0;
            state.pendingAdvice = null;
            state.lastAdviceNote = "";
        },

        onPreToolUse: async () => {
            const advice = takePendingAdvice();
            if (!advice) return;

            if (advice.severity === "blocker" && cfg("blockOnBlocker")) {
                debug(`delivering BLOCKER (denying tool call): ${advice.note}`);
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason: `Advisor blocker: ${advice.note}`,
                    additionalContext: formatAdvice(advice),
                };
            }
            debug(`delivering ${advice.severity} as context: ${advice.note}`);
            return { additionalContext: formatAdvice(advice) };
        },

        onPostToolUse: async (input, invocation) => {
            countToolCall(input?.toolName, invocation);
        },

        onPostToolUseFailure: async (input, invocation) => {
            countToolCall(input?.toolName, invocation);
        },
    },

    commands: [
        {
            name: "advisor",
            description: "Show advisor status",
            handler: async () => {
                const lines = [
                    `enabled:        ${cfg("enabled")}`,
                    `model:          ${cfg("model")} (${cfg("agentType")})`,
                    `cadence:        every ${cfg("everyNToolCalls")} tool calls (immune for first ${cfg("immuneToolCalls")})`,
                    `block on:       ${cfg("blockOnBlocker") ? "blocker" : "nothing"}`,
                    `config:         ${config._configPath ?? "built-in defaults"}`,
                    `checks run:     ${state.checksRun}`,
                    `advice given:   ${state.adviceDelivered}`,
                    `tool calls:     ${state.toolCallsSinceCheck}/${cfg("everyNToolCalls")} since last check`,
                    `in flight:      ${state.checkInFlight}`,
                    `pending advice: ${state.pendingAdvice ? state.pendingAdvice.severity : "none"}`,
                    `last error:     ${state.lastError ?? "none"}`,
                ];
                await session.log(`advisor status\n${lines.join("\n")}`);
            },
        },
        {
            name: "advisor-check",
            description: "Run an advisor review right now",
            handler: async () => {
                await session.log("advisor: reviewing…", { ephemeral: true });
                await runCheck(session, { force: true });
            },
        },
        {
            name: "advisor-on",
            description: "Enable the advisor for this session",
            handler: async () => {
                state.sessionOverrides.enabled = true;
                await session.log("advisor: enabled");
            },
        },
        {
            name: "advisor-off",
            description: "Disable the advisor for this session",
            handler: async () => {
                state.sessionOverrides.enabled = false;
                state.pendingAdvice = null;
                await session.log("advisor: disabled");
            },
        },
        {
            name: "advisor-model",
            description: "Set the advisor model for this session, e.g. /advisor-model gpt-5.6-terra",
            handler: async (ctx) => {
                const model = ctx.args?.trim();
                if (!model) {
                    await session.log(`advisor model: ${cfg("model")}`);
                    return;
                }
                state.sessionOverrides.model = model;
                await session.log(`advisor model set to ${model}`);
            },
        },
        {
            name: "advisor-every",
            description: "Set how many tool calls between advisor reviews, e.g. /advisor-every 20",
            handler: async (ctx) => {
                const n = Number.parseInt(ctx.args?.trim(), 10);
                if (!Number.isFinite(n) || n < 1) {
                    await session.log(`advisor cadence: every ${cfg("everyNToolCalls")} tool calls`);
                    return;
                }
                state.sessionOverrides.everyNToolCalls = n;
                await session.log(`advisor will review every ${n} tool calls`);
            },
        },
        {
            name: "advisor-reload",
            description: "Reload advisor.json config from disk",
            handler: async () => {
                config = loadConfig(process.cwd());
                state.sessionOverrides = {};
                await session.log(`advisor config reloaded from ${config._configPath ?? "built-in defaults"}`);
            },
        },
    ],
});

function countToolCall(toolName, invocation) {
    if (!cfg("enabled")) return;
    if (typeof toolName === "string" && toolName.startsWith("advisor")) return;

    state.toolCallsThisTurn++;
    state.toolCallsSinceCheck++;

    if (state.toolCallsThisTurn < cfg("immuneToolCalls")) return;
    if (state.toolCallsSinceCheck < cfg("everyNToolCalls")) return;
    if (state.checkInFlight || state.pendingAdvice) return;

    // Fire and forget: the main agent must not block on the review.
    void runCheck(session).catch(() => {});
    void invocation;
}

await session.log(
    `advisor ready — ${cfg("model")} every ${cfg("everyNToolCalls")} tool calls` +
        `${config._configPath ? ` (config: ${config._configPath})` : ""}`,
    { ephemeral: true },
);
