// Pure logic shared by the extension and its tests.
//
// `extension.mjs` exports nothing and ends in a top-level `await joinSession(...)`, so importing it
// from a test would join a session rather than run assertions. Anything carrying a real invariant
// therefore lives here: no session, no rpc, no module-level mutable state, and no config lookups.
// Values these functions need are passed in by the caller.
//
// `DEFAULTS` deliberately stays in `extension.mjs`: scripts/check-config-keys.mjs and
// scripts/check-config-usage.mjs locate it there by text, as they do every `cfg("key")` call, so
// moving it would silently disable the parity checks rather than fail them.

export const SEVERITY_RANK = { none: 0, nit: 1, concern: 2, blocker: 3 };

export const LOG_LEVELS = ["info", "warning", "error"];

// A sub-agent can report "idle" before it has produced anything, so a settled-but-empty poll is
// not proof of completion. Tolerate them for a fraction of the overall timeout rather than a
// fixed count — a fixed 8 polls capped every review at 16s and made `timeoutMs` unreachable.
const SETTLED_EMPTY_GRACE_FRACTION = 0.25;
const MIN_SETTLED_EMPTY_POLLS = 8;

export function settledEmptyPollLimit(pollIntervalMs, timeoutMs) {
    const interval = Math.max(pollIntervalMs, 1);
    const grace = timeoutMs * SETTLED_EMPTY_GRACE_FRACTION;
    return Math.max(MIN_SETTLED_EMPTY_POLLS, Math.ceil(grace / interval));
}

// Failures that will recur identically on every future review. Retrying them wastes a sub-agent
// dispatch per cadence interval and repeats the same error, so the advisor stands itself down.
const FATAL_ERROR_PATTERNS = [
    /agent executors are not available/i,
    /unknown agent type/i,
    /startAgent unavailable/i,
];

export function isFatalError(message) {
    return FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message ?? ""));
}

export function truncate(text, limit) {
    const str = typeof text === "string" ? text : JSON.stringify(text ?? "");
    if (str.length <= limit) return str;
    return `${str.slice(0, limit)}\n…[truncated ${str.length - limit} chars]`;
}

// Tool arguments that carry instructions to another agent rather than data. Inlined verbatim
// into the review transcript, their contents are indistinguishable in authority from the user's
// own words, and an advisor has been observed adopting a probe sub-agent's prompt as "the user's
// requirement" and issuing a blocker on that basis.
//
// Deliberately narrow: `prompt` and `message` are near-universally instructions, whereas `body`,
// `content` and `file_text` are data the reviewer needs to do its job.
const INSTRUCTION_ARG_FIELDS = new Set(["prompt", "message"]);

export function renderToolArgs(args, limit = 600) {
    let obj = args;
    if (typeof args === "string") {
        try {
            obj = JSON.parse(args);
        } catch {
            return truncate(args, limit);
        }
    }
    if (!obj || typeof obj !== "object") return truncate(obj, limit);

    const safe = {};
    for (const [key, value] of Object.entries(obj)) {
        safe[key] =
            INSTRUCTION_ARG_FIELDS.has(key) && typeof value === "string"
                ? `[instruction text omitted, ${value.length} chars]`
                : value;
    }
    return truncate(safe, limit);
}

// `tool.execution_complete` carries the call id but no tool name (see `ToolExecutionCompleteData`
// in the SDK's session-events.d.ts), so every result reached the advisor as
// `TOOL_RESULT undefined`, detached from the call that produced it. The name lives on the
// matching `tool.execution_start`, which can fall before the review's delta, so the map is built
// from the whole log rather than from the slice being rendered.
export function toolNamesByCallId(events) {
    const names = new Map();
    for (const e of events ?? []) {
        if (e?.type !== "tool.execution_start") continue;
        const { toolCallId, toolName } = e.data ?? {};
        if (toolCallId && toolName) names.set(toolCallId, toolName);
    }
    return names;
}

export function renderEvent(event, { toolNames, maxToolResultChars = Infinity } = {}) {
    const d = event?.data ?? {};
    switch (event?.type) {
        case "user.message":
            return d.content ? `USER: ${truncate(d.content, 2000)}` : null;
        case "assistant.message":
            return d.content ? `AGENT: ${truncate(d.content, 2000)}` : null;
        case "assistant.intent":
            return d.intent ? `AGENT_INTENT: ${truncate(d.intent, 400)}` : null;
        case "tool.execution_start":
            return `TOOL_CALL ${d.toolName}: ${renderToolArgs(d.arguments)}`;
        case "tool.execution_complete": {
            const name = d.toolName ?? toolNames?.get(d.toolCallId) ?? "(unknown tool)";
            const status = d.success === false ? "FAILED" : "ok";
            const body = d.success === false ? d.error : d.result;
            return `TOOL_RESULT ${name} [${status}]: ${truncate(body, maxToolResultChars)}`;
        }
        default:
            return null;
    }
}

// Minimum sane values for numeric keys. A zero or negative interval would dispatch a review on
// every tool call or busy-loop the poller, and a bad value currently fails in confusing ways
// rather than loudly.
const NUMERIC_FLOORS = {
    everyNToolCalls: 1,
    immuneToolCalls: 0,
    maxBackoffFactor: 1,
    maxAdviceAgeMs: 0,
    maxTranscriptChars: 500,
    maxToolResultChars: 100,
    timeoutMs: 5000,
    pollIntervalMs: 250,
};

// Rejected values fall back to the default rather than propagating. Reasons are returned so the
// user can be told once, at startup, instead of silently getting different behaviour.
export function validateConfig(raw, defaults) {
    const clean = { ...raw };
    const problems = [];

    for (const [key, floor] of Object.entries(NUMERIC_FLOORS)) {
        const value = clean[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= floor) continue;
        problems.push(`${key}=${JSON.stringify(value)} (must be a number >= ${floor})`);
        clean[key] = defaults[key];
    }

    if (!(clean.minSeverityToInject in SEVERITY_RANK)) {
        problems.push(
            `minSeverityToInject=${JSON.stringify(clean.minSeverityToInject)}` +
                ` (must be one of ${Object.keys(SEVERITY_RANK).join(", ")})`,
        );
        clean.minSeverityToInject = defaults.minSeverityToInject;
    }

    if (!LOG_LEVELS.includes(clean.timelineLevel)) {
        problems.push(
            `timelineLevel=${JSON.stringify(clean.timelineLevel)}` +
                ` (must be one of ${LOG_LEVELS.join(", ")})`,
        );
        clean.timelineLevel = defaults.timelineLevel;
    } else if (clean.timelineLevel === "error") {
        // Not a taste question. An extension log at error level is a `session.error`, which the
        // CLI classifies as a terminal fault and uses to stop autopilot and fail the session, so
        // honouring this setting would break the very session it is advising. The check lives
        // here rather than in LOG_LEVELS so the reason is reported instead of a bare "invalid".
        problems.push(
            'timelineLevel="error" is not supported: the CLI treats an error-level extension log' +
                " as a terminal session failure, which stops autopilot and marks the session" +
                ` failed. Using "${defaults.timelineLevel}" instead.`,
        );
        clean.timelineLevel = defaults.timelineLevel;
    }

    clean._problems = problems;
    return clean;
}

// Extracts balanced {...} spans, respecting string literals and escapes. A naive non-greedy
// regex stops at the first "}", so any note mentioning code — `else { }`, `${VAR}`, a regex —
// truncates into invalid JSON and the whole verdict is lost.
export function balancedJsonCandidates(text) {
    const candidates = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === "{") {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === "}" && depth > 0) {
            depth--;
            if (depth === 0) candidates.push(text.slice(start, i + 1));
        }
    }
    return candidates;
}

// Returned when the reply could not be understood at all. Distinct from a genuine "none" so the
// caller never mistakes a parse failure for a clean review.
const UNPARSEABLE = { severity: "none", note: "", unparseable: true };

// Doubles as the advisor's "is this sub-agent's reply the one I asked for" recogniser, which is
// why it must stay shape-specific: it requires a known `severity`, so a preamble or a
// differently-shaped reply is rejected rather than mistaken for a verdict.
//
// Note the empty-string case is NOT unparseable — it is a clean "none". Callers using this as a
// recogniser must therefore reject an empty reply themselves before consulting it.
export function parseVerdict(raw) {
    if (!raw || typeof raw !== "string") return { severity: "none", note: "" };

    // The advisor may wrap its JSON in prose or a fenced block; take the last object that parses.
    const candidates = balancedJsonCandidates(raw);
    if (candidates.length === 0) return UNPARSEABLE;

    for (const candidate of candidates.reverse()) {
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
    return UNPARSEABLE;
}

// The advisor's output flows into the main agent's context, so treat it as untrusted text. The
// note is interpolated between real <advisor> delimiters, so angle brackets are escaped rather
// than pattern-stripped — a note cannot then forge a tag of any shape.
export function sanitizeNote(note) {
    if (typeof note !== "string") return "";
    const clean = note
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .trim();
    return clean.slice(0, 800);
}

// `onAgentStop` fires for sub-agents too, contradicting the SDK's own comment that "for
// sub-agents, the runtime fires a separate sub-agent stop lifecycle". Measured on 1.0.80: a
// sub-agent's stop arrives with `input.sessionId` set to that sub-agent's own id — the `task`
// tool's toolCallId, or a `bg-<uuid>` for an RPC-started agent — while `invocation.sessionId`
// stays the main session's either way. So the sub-agent id is never equal to the main session id,
// and comparing against it is the discriminator.
//
// This is a different mechanism from the hook-dispatch matching used for the tool-use hooks: those
// carry no agent identity at all, whereas a stop does.
//
// Unknown ids are treated as NOT the main agent. Advisor's advice is written about the main
// agent's work, so mis-attributing a stop would hold a sub-agent's turn open over advice it can
// neither see nor act on.
export function isMainAgentStop(input, mainSessionId) {
    const id = input?.sessionId;
    if (typeof id !== "string" || id === "") return false;
    if (typeof mainSessionId !== "string" || mainSessionId === "") return false;
    return id === mainSessionId;
}

export function formatAdvice(advice) {
    return `<advisor severity="${advice.severity}">
${advice.note}
</advisor>
The above is from an independent reviewer model watching your work. It cannot see your full \
context and may be wrong — weigh it against what you know. If it is wrong, say so briefly and continue.`;
}

// Advice is one line in a busy session log, so the message itself has to carry the emphasis. The
// banner makes it findable when scrolling back. It cannot be raised by logging at a higher level:
// an error-level extension log is a terminal session failure (see validateConfig).
export function formatTimelineAdvice(advice, suffix = "") {
    const bar = "━".repeat(18);
    return `${bar} ⚠  ADVISOR · ${advice.severity.toUpperCase()}${suffix} ${bar}\n${advice.note}`;
}

// The advisor can only learn what the user asked for through the transcript, so a verdict that
// rests on a claimed user requirement is exactly the case most likely to be a misreading of some
// instruction-shaped text. A blocker halts real work immediately, so it has to be earned: the
// prompt requires such a blocker to quote the user verbatim, and an unquoted or uncorroborated
// claim is downgraded.
//
// This deliberately errs toward downgrading. A downgraded verdict is still delivered in full as a
// concern — only the tool-call denial is withheld — so a false negative costs far less than a
// false blocker halting real work on an imagined requirement.
export const USER_CLAIM_PATTERN =
    /\b(?:the\s+)?user(?:'s|s)?\s+(?:\w+ly\s+|explicit\s+|stated\s+|clear\s+)?(?:require|requirement|request|asked|ask|said|says|instruct|specified|wants?|demanded|told)/i;

// `userPrompts` is passed in rather than read from module state so this stays pure and so the
// caller controls what counts as trusted: only real user prompts, never the transcript, which is
// the untrusted surface. Mutates `advice` in place and returns whether it downgraded, leaving the
// logging to the caller.
export function downgradeUnfoundedUserClaim(advice, userPrompts = []) {
    if (advice.severity !== "blocker") return false;
    if (!USER_CLAIM_PATTERN.test(advice.note)) return false;

    // Corroborate against every user prompt in the session, not just the current one: a follow-up
    // like "continue" would otherwise discard the requirement an earlier prompt established and
    // downgrade a legitimate blocker.
    const trusted = userPrompts.join("\n").toLowerCase();
    const quoted = [...advice.note.matchAll(/[`"']([^`"']{8,80})[`"']/g)].map((m) =>
        m[1].toLowerCase(),
    );
    if (quoted.some((q) => trusted.includes(q))) return false;

    advice.severity = "concern";
    advice.note =
        `${advice.note}\n\n[advisor: downgraded from blocker — this asserts a user requirement ` +
        `that could not be corroborated against the recorded goal, so it may be a misreading of ` +
        `instruction-shaped text in the transcript.]`;
    return true;
}

// Every prompt that drives the main session arrives as a `user.message` event, and that event is
// the only place the prompt's provenance is recorded. The hook that also reports prompts
// (`onUserPromptSubmitted`) carries no agent identity at all — measured on host 1.0.84-5, a
// sub-agent's opening prompt reaches it with `agentId` and `parentToolCallId` both null, unlike
// the tool-use hooks — so a sub-agent's task prompt is indistinguishable there from something the
// user typed. Classifying from the event instead is the same move `countToolCall` already makes,
// and for the same reason.
//
// Two independent questions are answered here, and conflating them is the bug this replaced:
//
//   owner       — main session or sub-agent. A sub-agent prompt is not this session's turn at all.
//   authority   — whether the text is evidence of something *the user* asked for.
//
// They are not the same axis. A cross-session message from an operator session is a legitimate
// instruction that should steer the work, but it is not the user speaking; neither is the
// `<advisor>` follow-up the host enqueues when `onAgentStop` blocks, which is the advisor's own
// words being handed back to it. Treating either as user evidence lets the advisor corroborate a
// blocker against text it produced — see `downgradeUnfoundedUserClaim`, whose whole defence is
// that `userPrompts` contains only what the user actually said.
export const PROMPT_OWNER_MAIN = "main";
export const PROMPT_OWNER_SUB_AGENT = "sub-agent";

// The host re-delivers a blocked stop as a user message whose body is exactly `formatAdvice`'s
// output, so the opening tag identifies it without needing to match the note itself. Checked on
// the raw text rather than on `source`, because it must hold even for a prompt that arrived with
// no event to classify.
export function isAdvisorFollowUp(text) {
    return typeof text === "string" && /^\s*<advisor\b/.test(text);
}

// `record` is the `user.message` event's payload, or null when a prompt could not be attributed.
// Absence is deliberately treated as an ordinary user prompt: that is the behaviour every release
// before this one had, so an unattributed prompt is no worse off than it used to be, while the
// `<advisor>` check above still applies because it needs no attribution.
export function classifyPrompt(record) {
    const content = typeof record?.content === "string" ? record.content : "";

    // Presence, never a prefix: sub-agent ids appear both as bare UUIDs and with a `bg-` prefix
    // depending on how the agent was started, and matching the shape would miss one of them.
    if (record?.agentId) {
        return { owner: PROMPT_OWNER_SUB_AGENT, isUserAuthored: false, setsGoal: false, reason: "sub-agent" };
    }
    if (isAdvisorFollowUp(content)) {
        // Must not become the goal either: it would overwrite the real objective with the
        // advisor's own critique of it.
        return { owner: PROMPT_OWNER_MAIN, isUserAuthored: false, setsGoal: false, reason: "advisor-follow-up" };
    }
    // Set on messages the host did not receive from the user: `system` for injections, and
    // `agent-<session-id>` for a message sent by another session. Deliberately not used to decide
    // ownership — a cross-session message from an operator carries a source but is a genuine
    // instruction to this session, and ignoring it would make the advisor deaf to its own operator.
    if (typeof record?.source === "string" && record.source) {
        return { owner: PROMPT_OWNER_MAIN, isUserAuthored: false, setsGoal: true, reason: `source:${record.source}` };
    }
    return { owner: PROMPT_OWNER_MAIN, isUserAuthored: true, setsGoal: true, reason: "user" };
}

// The host announces a finished sub-agent to the main agent unless the task is cancelled first,
// and polling for the reply can only race that announcement. `onSubagentStop` is the one point
// where the race is decided in advisor's favour. Measured on 1.0.99-2: a cancel of the exact agent,
// awaited inside the hook, produced no notification in 4 of 4 runs, whereas `modifiedResponse`
// does not suppress it.
//
// One capture describes one review. `start` records the agent id once `startAgent` returns —
// the stop can arrive before that, so a stop waits briefly for it — and `settle` hands the
// captured reply to the polling loop.
export function createReviewCapture() {
    let resolveStarted;
    let resolveSettled;
    const capture = {
        agentId: null,
        claimed: false,
        done: false,
        started: new Promise((resolve) => (resolveStarted = resolve)),
        settled: new Promise((resolve) => (resolveSettled = resolve)),
        start(id) {
            if (capture.agentId === null && typeof id === "string" && id) capture.agentId = id;
            resolveStarted(capture.agentId);
        },
        settle(value) {
            resolveSettled(value);
        },
    };
    return capture;
}

function waitBounded(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)));
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Ownership is the exact agent id `startAgent` returned, never a prompt or model match: cancelling
// a stop that is not advisor's would kill the user's own sub-agent. The cancel is awaited before
// settling so the review cannot return — and dispose the task — while the cancel is in flight.
// A failed cancel is still settled: the reply is valid either way, and only the notification is lost.
export async function captureOwnedStop(capture, input, { cancel, startWaitMs = 0 } = {}) {
    const notOwned = { owned: false };
    const id = input?.agentId;
    if (!capture || capture.done || capture.claimed) return notOwned;
    if (typeof id !== "string" || id === "") return notOwned;

    if (capture.agentId === null) await waitBounded(capture.started, startWaitMs);
    if (capture.agentId !== id || capture.done || capture.claimed) return notOwned;

    capture.claimed = true;
    const response = typeof input.response === "string" ? input.response : "";
    let cancelled = false;
    let cancelError = null;
    try {
        cancelled = (await cancel(id))?.cancelled === true;
    } catch (err) {
        cancelError = err?.message ?? String(err);
    }
    const outcome = { response, cancelled, cancelError };
    capture.settle(outcome);
    return { owned: true, ...outcome };
}

// HydraFusion runs a turn as phases before committing one phase's work. A root-scope phase's work
// is never in `getEvents()` while it runs — it arrives only through `session.on`, as ephemeral
// events tagged `data.fusion.phaseId` with no `commitId` — so reviewing it means buffering it as it
// streams. The commit then replays the selected phase as persisted events carrying a `commitId`
// and the same call ids and content, which is what `fusionWorkKey` matches on. Measured on a
// recorded cascade fusion on 1.0.99-2.
const FUSION_WORK_EVENT_TYPES = new Set([
    "assistant.message",
    "assistant.intent",
    "tool.execution_start",
    "tool.execution_complete",
]);

// Review-scope phases (a judge or critic) run in an isolated history that never reaches the root
// conversation, so their output is not the agent's work.
export function isLivePhaseWork(event, phaseId) {
    if (!phaseId || event?.agentId) return false;
    if (!FUSION_WORK_EVENT_TYPES.has(event?.type)) return false;
    const tag = event.data?.fusion;
    return tag?.phaseId === phaseId && !tag.commitId && tag.conversationScope !== "review";
}

export function fusionWorkKey(event) {
    const data = event?.data ?? {};
    const phaseId = data.fusion?.phaseId;
    if (!phaseId || !FUSION_WORK_EVENT_TYPES.has(event?.type)) return null;
    const identity = data.toolCallId ?? data.content ?? data.intent;
    if (typeof identity !== "string" || identity === "") return null;
    return `${phaseId}|${event.type}|${identity}`;
}

export function createFusionPhase({ phaseId, phaseKind }, limit = 400) {
    return { id: phaseId, kind: phaseKind || "unknown", events: [], dropped: 0, toolNames: new Map(), limit };
}

// A result can arrive after its call was drained by an earlier review, so tool names are kept for
// the phase's lifetime rather than per drain, under the same bound as the events.
export function bufferPhaseEvent(phase, event) {
    if (event?.type === "tool.execution_start") {
        const { toolCallId, toolName } = event.data ?? {};
        if (toolCallId && toolName) {
            phase.toolNames.set(toolCallId, toolName);
            if (phase.toolNames.size > phase.limit) phase.toolNames.delete(phase.toolNames.keys().next().value);
        }
    }
    phase.events.push(event);
    if (phase.events.length > phase.limit) {
        phase.events.shift();
        phase.dropped++;
    }
}

export function drainPhaseEvents(phase) {
    const drained = { events: phase.events, dropped: phase.dropped };
    phase.events = [];
    phase.dropped = 0;
    return drained;
}

// The phase may be discarded rather than committed, so the reviewer is told it is judging an
// attempt in progress rather than the turn's final work.
export function renderPhaseWork(phase, { events, dropped }, { maxToolResultChars = Infinity } = {}) {
    const lines = events
        .map((e) => renderEvent(e, { toolNames: phase.toolNames, maxToolResultChars }))
        .filter(Boolean);
    if (lines.length === 0) return [];
    const header = `[HydraFusion ${phase.kind} phase in progress: provisional work that may not be kept]`;
    return [header, ...(dropped > 0 ? [`…[${dropped} earlier phase events omitted]`] : []), ...lines];
}

// Sub-agent events are never the main agent's work. A commit replay of work already reviewed
// live is dropped so the next review does not judge the same work twice as though it were new;
// a replay of a phase that was never reviewed stays, as the committed record of what happened.
export function selectReviewableEvents(events, reviewedKeys) {
    return (events ?? []).filter((e) => {
        if (e?.agentId) return false;
        if (!e?.data?.fusion?.commitId) return true;
        const key = fusionWorkKey(e);
        return !(key && reviewedKeys?.has(key));
    });
}

// A Set iterates in insertion order, so the first value is the oldest.
export function rememberBounded(set, values, limit) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        set.add(value);
        if (set.size > limit) set.delete(set.values().next().value);
    }
}
