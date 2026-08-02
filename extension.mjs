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
    backoff: true,
    maxBackoffFactor: 8,
    maxAdviceAgeMs: 120000,
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
// between a sub-agent reporting "idle" and its reply becoming readable.
const SETTLED_EMPTY_POLL_LIMIT = 8;

// `tasks.startAgent` accepts only these built-in agent types. Custom agents defined on disk are
// not dispatchable through it, so the advisor cannot use one to pin its own reasoning effort.
const BUILTIN_AGENT_TYPES = [
    "explore",
    "task",
    "general-purpose",
    "rubber-duck",
    "code-review",
    "research",
    "security-review",
];

// Distinctive description stamped on the sub-agent so its events can be identified in the
// session event log. RPC-started agents have no parent tool call to correlate on.
const ADVISOR_TASK_DESCRIPTION = "Advisor review";

// How many past verdicts the advisor is shown, so it can spot a repeated failure rather than
// restating the same note each review.
const VERDICT_HISTORY_LIMIT = 5;

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
    pendingAdviceAt: 0,
    lastAdviceNote: "",
    verdictHistory: [],
    consecutiveQuietChecks: 0,
    activeCalls: new Map(),
    checksRun: 0,
    adviceDelivered: 0,
    lastError: null,
    lastReportedError: null,
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
        case "assistant.intent":
            return d.intent ? `AGENT_INTENT: ${truncate(d.intent, 400)}` : null;
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

// Tool calls that have started but not finished — what the agent is doing right now. Without
// these the advisor only ever sees the past and can react to a mistake but never prevent one.
//
// These are tracked from the hook payloads rather than derived from `tool.execution_start`
// events, because at hook time the corresponding event may not have been emitted yet and the
// derivation would silently yield nothing. The hooks carry `toolName`/`toolArgs` authoritatively.
// Hook payloads have no call id, so identical concurrent calls are counted rather than keyed.
const MAX_ACTIVE_CALL_AGE_MS = 10 * 60 * 1000;

function callKey(toolName, toolArgs) {
    return `${toolName}\u0000${truncate(toolArgs, 400)}`;
}

function markCallStarted(toolName, toolArgs) {
    if (!toolName) return;
    const key = callKey(toolName, toolArgs);
    const entry = state.activeCalls.get(key);
    if (entry) {
        entry.count++;
        entry.startedAt = Date.now();
    } else {
        state.activeCalls.set(key, { toolName, toolArgs, count: 1, startedAt: Date.now() });
    }
}

function markCallFinished(toolName, toolArgs) {
    if (!toolName) return;
    const key = callKey(toolName, toolArgs);
    const entry = state.activeCalls.get(key);
    if (!entry) return;
    if (--entry.count <= 0) state.activeCalls.delete(key);
}

// A tool call that is aborted never reaches a post hook, so its entry would leak.
function pruneActiveCalls() {
    const cutoff = Date.now() - MAX_ACTIVE_CALL_AGE_MS;
    for (const [key, entry] of state.activeCalls) {
        if (entry.startedAt < cutoff) state.activeCalls.delete(key);
    }
}

function collectInFlight() {
    pruneActiveCalls();
    return [...state.activeCalls.values()].map(
        (e) => `${e.toolName}${e.count > 1 ? ` (x${e.count})` : ""}: ${truncate(e.toolArgs, 600)}`,
    );
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

    // Captured from live hook state rather than the event log, so it reflects calls that are
    // executing at this instant.
    return { transcript: text, inFlight: collectInFlight() };
}

// The plan and todo list are what the user actually asked for, distilled. Without them the
// advisor has to infer intent from the transcript and can only guess at drift.
async function readPlanContext(session) {
    const parts = [];

    try {
        const plan = await session.rpc.plan.read();
        if (plan?.exists && plan.content?.trim()) {
            parts.push(`Current plan:\n${truncate(plan.content, 4000)}`);
        }
    } catch {
        // Plan is unavailable when the session has no workspace.
    }

    try {
        const { rows } = await session.rpc.plan.readSqlTodos();
        if (rows?.length) {
            const list = rows
                .map((r) => `- [${r.status ?? "?"}] ${r.title ?? r.id ?? "(untitled)"}`)
                .join("\n");
            parts.push(`Tracked todos:\n${truncate(list, 2000)}`);
        }
    } catch {
        // No session SQL database.
    }

    return parts.join("\n\n");
}

function buildPrompt({ transcript, inFlight, planContext }) {
    const extra = cfg("instructions");
    const planBlock = planContext ? `\n<stated_plan>\n${planContext}\n</stated_plan>\n` : "";
    const inFlightBlock = inFlight?.length
        ? `\n<in_flight_right_now>\n${inFlight.join("\n")}\n</in_flight_right_now>\n`
        : "";

    return `You are an ADVISOR. You are watching another AI coding agent work on a user's request. \
You do NOT do the work yourself and you do NOT talk to the user.

<user_goal>
${state.goal || "(not captured — infer it from the transcript)"}
</user_goal>
${planBlock}
<recent_activity>
${transcript}
</recent_activity>
${inFlightBlock}${state.verdictHistory.length ? `\n<your_previous_verdicts>\n${state.verdictHistory.join("\n")}\n</your_previous_verdicts>\n` : ""}
Decide whether the main agent needs an intervention RIGHT NOW.

Intervene for things like:
- drifting from what the user actually asked for, or silently expanding scope
- diverging from the stated plan above without saying why
- acting on an unverified assumption that the transcript shows is probably wrong
- forgetting an explicit constraint or requirement the user stated
- repeating an approach that has already failed
- about to do something destructive, irreversible, or outside the requested scope
- claiming success without having verified it

If an <in_flight_right_now> block is present, those tool calls are executing as you read this. \
Weight them heavily: stopping a wrong action there is far more useful than criticising it later.

Do NOT comment on style, formatting, naming, or things the agent is obviously about to do next.
Do NOT restate what the agent is doing. Do NOT repeat a previous verdict that was already \
delivered. Silence is the correct answer most of the time.

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

    const agentType = cfg("agentType");
    if (!BUILTIN_AGENT_TYPES.includes(agentType)) {
        throw new Error(
            `agentType "${agentType}" is not a built-in agent. startAgent accepts only: ` +
                `${BUILTIN_AGENT_TYPES.join(", ")}. Custom agents cannot be dispatched this way.`,
        );
    }

    let baseline = 0;
    try {
        baseline = (await session.getEvents()).length;
    } catch {
        baseline = 0;
    }

    // When `model` is unset the agent definition's own model and reasoning effort apply. The
    // startAgent RPC has no effort parameter, so a dedicated custom agent is the only way to
    // pin the advisor's reasoning level.
    const modelOverride = cfg("model");
    const { agentId } = await rpc.tasks.startAgent({
        agentType: cfg("agentType"),
        prompt,
        name: "advisor",
        description: ADVISOR_TASK_DESCRIPTION,
        ...(modelOverride ? { model: modelOverride } : {}),
    });
    debug(
        `started advisor agent ${agentId} as ${cfg("agentType")}` +
            ` on ${modelOverride ?? "agent-defined model"} (event baseline ${baseline})`,
    );

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
            debug(
                `poll ${agentId}: status=${task.status} resultLen=${task.result?.length ?? "null"}` +
                    ` toolCallId=${task.toolCallId ?? "null"}`,
            );

            if (task.status === "failed") throw new Error(task.error || "advisor agent failed");
            if (task.status === "cancelled") return "";

            // Exact correlation: keyed by the task id we own, so unlike event-log matching these
            // cannot pick up the self-learn extension's or the main agent's sub-agent.
            if (task.result) {
                debug(`reply via task.result`);
                return task.result;
            }
            if (task.latestResponse) {
                debug(`reply via task.latestResponse`);
                return task.latestResponse;
            }

            // The task parks in "idle" without ever exposing a result, so the event log is the
            // real completion signal.
            const { status, reply } = await readAgentReplyFromEventLog(session, task.toolCallId, baseline);
            if (status === "failed") throw new Error(reply);
            if (status === "done") {
                debug(`reply via event log (fallback)`);
                return reply;
            }

            // Guard against a sub-agent that settles without ever emitting a completion event.
            if (task.status === "completed" || task.status === "idle") {
                if (++emptySettledPolls >= SETTLED_EMPTY_POLL_LIMIT) {
                    debug(`${agentId} settled with no result after ${emptySettledPolls} polls`);
                    await dumpEventDiagnostics(session, baseline);
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

// `tasks.list()` leaves `result` null for a sub-agent that parks in "idle", so the reply has to be
// recovered from the session event log. Sub-agent events are tagged with an internal agent id
// (`bg-…`) that differs from the task id (`advisor-…`). An agent started over RPC has no parent
// tool invocation, so `toolCallId` cannot be relied on for correlation — match on the sub-agent's
// description instead, scoped to events emitted after this review began.
async function readAgentReplyFromEventLog(session, toolCallId, baseline) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch {
        return { status: "pending", reply: "" };
    }

    const recent = events.slice(baseline);

    // The baseline is captured immediately before the sub-agent is started, so the first
    // `subagent.started` after it is this review's. Prefer an explicit description or model
    // match when the payload carries one, since the main agent may spawn its own sub-agents.
    const candidates = recent.filter((e) => e?.type === "subagent.started" && e?.agentId);
    const started =
        candidates.find(
            (e) =>
                e?.data?.agentDescription === ADVISOR_TASK_DESCRIPTION ||
                (toolCallId && e?.data?.toolCallId === toolCallId),
        ) ??
        candidates.find((e) => e?.data?.model && e.data.model === cfg("model")) ??
        candidates[0];

    if (!started) return { status: "pending", reply: "" };

    const internalId = started.agentId;
    const mine = (e) => e?.agentId === internalId;

    const failed = recent.find((e) => e?.type === "subagent.failed" && mine(e));
    if (failed) return { status: "failed", reply: failed?.data?.error ?? "sub-agent failed" };

    if (!recent.some((e) => e?.type === "subagent.completed" && mine(e))) {
        return { status: "pending", reply: "" };
    }

    const replies = recent
        .filter((e) => e?.type === "assistant.message" && mine(e))
        .map((e) => e?.data?.content)
        .filter((c) => typeof c === "string" && c.trim());

    if (replies.length === 0) return { status: "done", reply: "" };
    debug(`recovered reply for ${internalId} from event log (${replies.length} message(s))`);
    return { status: "done", reply: replies[replies.length - 1] };
}

// Emitted once when a review yields nothing, so an unexpected event shape can be diagnosed
// without rebuilding the extension.
async function dumpEventDiagnostics(session, baseline) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch {
        return;
    }
    const recent = events.slice(baseline);
    const summary = recent.map((e) => `${e?.type}${e?.agentId ? `@${e.agentId}` : ""}`).join(", ");
    debug(`event diagnostics since baseline ${baseline}: ${truncate(summary, 2000)}`);

    for (const e of recent.filter((e) => String(e?.type).startsWith("subagent."))) {
        debug(`  ${e.type} agentId=${e.agentId} data=${truncate(JSON.stringify(e.data), 600)}`);
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
    debug(
        `check starting (force=${force}, checksRun=${state.checksRun},` +
            ` interval=${currentInterval()}, quietStreak=${state.consecutiveQuietChecks})`,
    );

    try {
        const snapshot = await buildTranscriptDelta(session);
        if (!snapshot) return { skipped: "no new activity" };

        const planContext = await readPlanContext(session);
        state.checksRun++;
        const raw = await runAdvisorAgent(session, buildPrompt({ ...snapshot, planContext }));
        const advice = parseVerdict(raw);
        debug(
            `verdict: ${advice.severity} | inFlight=${snapshot.inFlight.length}` +
                ` plan=${planContext ? "yes" : "no"} | raw=${truncate(raw, 300)}`,
        );

        if (advice.severity === "none" || !advice.note) {
            state.consecutiveQuietChecks++;
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
        state.pendingAdviceAt = Date.now();
        state.lastAdviceNote = advice.note;
        state.consecutiveQuietChecks = 0;
        state.verdictHistory.push(`[${advice.severity}] ${truncate(advice.note, 200)}`);
        if (state.verdictHistory.length > VERDICT_HISTORY_LIMIT) state.verdictHistory.shift();

        if (cfg("logToTimeline")) {
            const level = advice.severity === "blocker" ? "warning" : "info";
            await session.log(`advisor [${advice.severity}]: ${advice.note}`, { level });
        }
        return advice;
    } catch (err) {
        state.lastError = err?.message ?? String(err);
        debug(`ERROR: ${state.lastError}`);

        // A misconfigured advisor would otherwise fail every review in silence, visible only in
        // the debug log. Surface each distinct failure once so it cannot go unnoticed.
        if (cfg("logToTimeline") && (force || state.lastError !== state.lastReportedError)) {
            state.lastReportedError = state.lastError;
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
    if (!advice) return null;

    // A review runs asynchronously, so its verdict can arrive after the situation that prompted
    // it has already moved on. Acting on stale advice — especially denying a tool call over it —
    // is worse than dropping it.
    const age = Date.now() - state.pendingAdviceAt;
    const maxAge = cfg("maxAdviceAgeMs");
    if (maxAge && age > maxAge) {
        debug(`dropping stale ${advice.severity} advice (${Math.round(age / 1000)}s old)`);
        return null;
    }

    state.adviceDelivered++;
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
            state.activeCalls.clear();
        },

        onPreToolUse: async (input) => {
            markCallStarted(input?.toolName, input?.toolArgs);

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
            markCallFinished(input?.toolName, input?.toolArgs);
            countToolCall(input?.toolName, invocation);
        },

        onPostToolUseFailure: async (input, invocation) => {
            markCallFinished(input?.toolName, input?.toolArgs);
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
                    `cadence:        every ${cfg("everyNToolCalls")} tool calls (currently ${currentInterval()}, immune for first ${cfg("immuneToolCalls")})`,
                    `block on:       ${cfg("blockOnBlocker") ? "blocker" : "nothing"}`,
                    `config:         ${config._configPath ?? "built-in defaults"}`,
                    `checks run:     ${state.checksRun}`,
                    `advice given:   ${state.adviceDelivered}`,
                    `tool calls:     ${state.toolCallsSinceCheck}/${currentInterval()} since last check`,
                    `quiet streak:   ${state.consecutiveQuietChecks}`,
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
    if (state.toolCallsSinceCheck < currentInterval()) return;
    if (state.checkInFlight || state.pendingAdvice) return;

    // Fire and forget: the main agent must not block on the review.
    void runCheck(session).catch(() => {});
    void invocation;
}

// Reviews are expensive and most return nothing, so the interval widens while the agent is
// behaving and snaps back to the configured cadence as soon as something is worth saying.
function currentInterval() {
    const base = cfg("everyNToolCalls");
    if (!cfg("backoff")) return base;

    const factor = Math.min(2 ** state.consecutiveQuietChecks, cfg("maxBackoffFactor"));
    return Math.max(base, Math.round(base * factor));
}

await session.log(
    `advisor ready — ${cfg("model")} every ${cfg("everyNToolCalls")} tool calls` +
        `${config._configPath ? ` (config: ${config._configPath})` : ""}`,
    { ephemeral: true },
);

// Advice is normally delivered on the next tool call. A turn that ends without one would drop
// it silently, so surface anything still pending when the session goes idle.
session.on("session.idle", () => {
    const advice = state.pendingAdvice;
    if (!advice) return;
    state.pendingAdvice = null;
    debug(`flushing undelivered ${advice.severity} at idle: ${advice.note}`);
    void session
        .log(`advisor [${advice.severity}, undelivered]: ${advice.note}`, {
            level: advice.severity === "blocker" ? "warning" : "info",
        })
        .catch(() => {});
});
