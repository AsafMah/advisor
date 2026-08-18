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
