// The advisor activity panel: what it records, how it renders, and the loopback server the
// canvas iframe talks to.
//
// Deliberately imports nothing from the SDK and reaches into no extension state — everything it
// needs arrives as an argument. That is what lets the ring, the renderer and the server each be
// tested on their own, and it is the only way any of this can be tested at all: `extension.mjs`
// ends in a top-level `await joinSession(...)` against a host that is absent under `node --test`,
// so it can never be imported. `lib.mjs` exists for the same reason.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Bounded so a long session cannot grow the panel without limit. Deliberately a module constant
// and not a config key: `scripts/check-config-keys.mjs` requires every key in DEFAULTS to appear
// in `advisor.example.json` and in the README table, and a knob nobody asked for is not worth
// that surface.
export const ACTIVITY_LIMIT = 200;

// Entry counts are not a memory budget. 200 entries is a bound on how *many* things the panel
// remembers, not on how large they are: an advice note is free-form model output, and a UTF-8
// byte is not a JS character, so a count-based cap alone lets the ring and the `/state` response
// grow without limit. These are the actual bounds.
//
// Per entry, generous enough that no readable note is ever cut; a note past this is not something
// a panel can usefully display anyway.
export const MAX_DETAIL_BYTES = 8 * 1024;
// Per `/state` response, over the serialized bytes rather than the entry count, because durable
// history is prepended from a file whose length nothing in this process controls.
export const MAX_PAYLOAD_BYTES = 512 * 1024;

const TRUNCATION_MARKER = "\n… truncated";

/**
 * Truncates on a UTF-8 byte budget without splitting a character.
 *
 * Slicing a Buffer at a fixed offset lands mid-sequence for any multi-byte character and decodes
 * to U+FFFD, so the cut walks back over continuation bytes (`10xxxxxx`) to the start of the
 * character it landed in.
 */
export function truncateToBytes(text, maxBytes = MAX_DETAIL_BYTES) {
    const value = String(text ?? "");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

    const marker = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    const buf = Buffer.from(value, "utf8");
    let cut = Math.max(0, maxBytes - marker);
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
    return buf.subarray(0, cut).toString("utf8") + TRUNCATION_MARKER;
}

/**
 * Drops the oldest entries until the list serializes within `maxBytes`.
 *
 * Measured on the actual JSON, because that is what crosses the socket. The newest entries are
 * the ones worth keeping, so this trims from the front — a panel showing recent advice and a gap
 * is useful, and one that fails to load is not.
 */
export function boundBySerializedBytes(entries, maxBytes = MAX_PAYLOAD_BYTES) {
    let list = entries;
    let size = Buffer.byteLength(JSON.stringify(list), "utf8");
    while (list.length > 1 && size > maxBytes) {
        // Drop a proportional slice rather than one entry at a time: re-serializing to measure is
        // O(n) and this list can start in the megabytes, so one-at-a-time would be quadratic.
        const average = Math.max(1, Math.ceil(size / list.length));
        const drop = Math.min(list.length - 1, Math.max(1, Math.ceil((size - maxBytes) / average)));
        list = list.slice(drop);
        size = Buffer.byteLength(JSON.stringify(list), "utf8");
    }
    return list;
}

// Every entry is shaped the same way whatever produced it, so the renderer needs one code path
// and the filter needs no special cases:
//
//   { seq, at, time, tag, title, detail, logged }
//
// `tag` is the filter axis — an advice severity, or the kind of the non-advice event. `logged`
// marks entries that were also appended to the advice log, which is what makes durable history
// exact rather than approximate; see `mergeDurableHistory`.
export const ADVICE_TAGS = ["blocker", "concern", "nit"];
export const PANEL_TAGS = [...ADVICE_TAGS, "review", "control", "error"];

// The only three things the panel may change, and the only three it may be told about. Anything
// outside this list is rejected rather than ignored: a request carrying a field this endpoint
// does not implement is a request that thinks it is doing something, and answering 200 to it
// would be a lie.
export const SETTINGS_KEYS = ["enabled", "model", "everyNToolCalls"];
export const MAX_SETTINGS_BODY_BYTES = 4 * 1024;
const MAX_MODEL_LENGTH = 200;
const MAX_CADENCE = 10000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function validateSettings(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return `${label} must be an object`;
    for (const key of Object.keys(value)) {
        if (!SETTINGS_KEYS.includes(key)) return `${label}.${key} is not a setting this panel can change`;
    }
    for (const key of SETTINGS_KEYS) {
        if (!(key in value)) return `${label}.${key} is missing`;
    }
    if (typeof value.enabled !== "boolean") return `${label}.enabled must be true or false`;
    if (typeof value.model !== "string") return `${label}.model must be a string`;
    const model = value.model.trim();
    if (!model) return `${label}.model must not be empty`;
    if (model.length > MAX_MODEL_LENGTH) return `${label}.model is longer than ${MAX_MODEL_LENGTH} characters`;
    if (CONTROL_CHARS.test(model)) return `${label}.model contains a control character`;
    // `Number.isInteger` rejects NaN, Infinity and 7.5 in one go. JSON has no integer type, so
    // this is the only place the distinction can be made.
    if (!Number.isInteger(value.everyNToolCalls)) return `${label}.everyNToolCalls must be a whole number`;
    if (value.everyNToolCalls < 1 || value.everyNToolCalls > MAX_CADENCE) {
        return `${label}.everyNToolCalls must be between 1 and ${MAX_CADENCE}`;
    }
    return null;
}

/**
 * Validates a settings write from the panel, before anything can act on it.
 *
 * `expected` is the baseline the user was looking at when they confirmed, and it is required
 * rather than optional: without it a confirmation dialog listing "cadence 6 → 8" can be applied
 * long after something else moved the cadence, and the change the user approved is not the change
 * that happens. Whether the baseline still holds is the caller's question, not this one's — here
 * it only has to be present and well-formed.
 *
 * Returns `{ request }` or `{ error }`; never throws.
 */
export function parseSettingsRequest(text) {
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return { error: "the request body is not valid JSON" };
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { error: "the request body must be a JSON object" };
    }
    for (const key of Object.keys(body)) {
        if (key !== "expected" && key !== "desired") return { error: `${key} is not a field this endpoint accepts` };
    }
    for (const key of ["expected", "desired"]) {
        if (!(key in body)) return { error: `${key} is missing` };
    }
    const problem = validateSettings(body.expected, "expected") ?? validateSettings(body.desired, "desired");
    if (problem) return { error: problem };
    const pick = (o) => ({ enabled: o.enabled, model: o.model.trim(), everyNToolCalls: o.everyNToolCalls });
    return { request: { expected: pick(body.expected), desired: pick(body.desired) } };
}

/**
 * The in-memory record of this session's advisor activity, and the thing the panel subscribes to.
 *
 * Append-only and bounded. `subscribe` exists so an open panel is pushed to rather than polling,
 * and returns its own unsubscribe so a closed panel leaves nothing behind.
 */
export function createActivityLog(limit = ACTIVITY_LIMIT) {
    const entries = [];
    const listeners = new Set();
    let seq = 0;

    return {
        push(entry) {
            const now = new Date();
            const record = {
                seq: ++seq,
                at: now.toISOString(),
                time: now.toLocaleTimeString(),
                tag: "review",
                title: "",
                detail: "",
                logged: false,
                ...entry,
            };
            record.detail = truncateToBytes(record.detail);
            record.title = truncateToBytes(record.title, 1024);
            entries.push(record);
            if (entries.length > limit) entries.splice(0, entries.length - limit);
            for (const fn of listeners) {
                try {
                    fn(record);
                } catch {
                    // A panel that throws must never break the review loop that fed it.
                }
            }
            return record;
        },
        list: () => entries.slice(),
        // How many of the retained entries also reached the advice log. `mergeDurableHistory`
        // needs this to know how much of the file it is already showing.
        loggedCount: () => entries.reduce((n, e) => n + (e.logged ? 1 : 0), 0),
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        get limit() {
            return limit;
        },
        get listenerCount() {
            return listeners.size;
        },
    };
}

const ADVICE_HEADER = /^###\s*\[([^\]]*)\]\s+(\S+)\s+\((.*)\)\s*$/;

// Every stamp the panel and the tool render goes through this, so a row can never be read as
// "just now" when it is days old. That is not hypothetical: an advice row reading `11:00:02` was
// read as current when it was eight days old, because a bare clock time looks like today.
//
// Explicit components rather than `dateStyle`/`timeStyle`, which cannot be combined with
// `timeZoneName` — the pair throws a TypeError. The zone is worth the width: what is stored is a
// UTC instant and what is shown is the reader's local time, so the two only agree by accident.
export const STAMP_FORMAT = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
};

// Entries the advisor wrote before it recorded dates. Their date is genuinely unrecoverable —
// today's date and the file's mtime are both wrong answers, and the second is worse for looking
// plausible — so the display says so rather than inventing one.
export const STAMP_UNKNOWN_DATE = "date unavailable";

// Deliberately strict. `Date.parse` accepts far more than ISO 8601, and several of the things it
// accepts are time-only forms it resolves against *today* — which is the exact error this whole
// change exists to prevent. A stamp becomes an instant only if it was written as one.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Reads whatever an advice-log entry recorded in its header brackets.
 *
 * Returns the ISO instant when the entry carries one, and otherwise `at: null` with the raw text
 * preserved — never a date guessed from the parse.
 */
export function readStamp(raw) {
    const text = String(raw ?? "").trim();
    if (!ISO_STAMP.test(text)) return { at: null, time: text };
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) return { at: null, time: text };
    return { at: new Date(ms).toISOString(), time: text };
}

/** Renders an ISO instant as a full local date and time. Empty for anything unparseable. */
export function formatStamp(iso) {
    const date = new Date(iso ?? NaN);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, STAMP_FORMAT);
}

/**
 * The one answer to "when did this happen", for an entry from either era.
 *
 * Dated entries read as a full local date and time; undated ones keep the only thing they ever
 * recorded and say outright that the date is missing.
 */
export function describeStamp(entry) {
    const at = entry?.at ? formatStamp(entry.at) : "";
    if (at) return at;
    const time = String(entry?.time ?? "").trim();
    return time ? `${time} \u2014 ${STAMP_UNKNOWN_DATE}` : "";
}

/**
 * Rewrites one raw advice-log entry's header for reading, leaving the file itself untouched.
 *
 * The log is append-only history and stays exactly as written; this is the display of it, which
 * is where the date belongs. An entry whose header does not parse is passed through verbatim,
 * for the same reason `parseAdviceLog` surfaces it rather than dropping it.
 */
export function describeAdviceEntry(chunk) {
    const text = String(chunk ?? "");
    const newline = text.indexOf("\n");
    const head = (newline === -1 ? text : text.slice(0, newline)).trim();
    const match = ADVICE_HEADER.exec(head);
    if (!match) return text;
    const shown = describeStamp(readStamp(match[1]));
    const header = `### [${shown}] ${match[2]} (${match[3]})`;
    return newline === -1 ? header : header + text.slice(newline);
}

/**
 * Reads the session's advice log back into panel entries.
 *
 * The advice log is already the durable record of everything the advisor said, so the panel
 * reads it rather than inventing a second telemetry file that could disagree with it. Parsing is
 * tolerant by design: a line that does not match the header is surfaced verbatim instead of
 * being dropped, because silently hiding a malformed entry is exactly the failure the panel is
 * supposed to make visible.
 */
export function parseAdviceLog(text, separator) {
    return String(text ?? "")
        .split(separator)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
            const newline = chunk.indexOf("\n");
            const head = (newline === -1 ? chunk : chunk.slice(0, newline)).trim();
            const body = newline === -1 ? "" : chunk.slice(newline + 1).trim();
            const match = ADVICE_HEADER.exec(head);
            if (!match) {
                return { seq: 0, at: null, time: "", tag: "review", title: "unparsed log entry", detail: truncateToBytes(chunk), logged: true };
            }
            const tag = match[2].toLowerCase();
            const stamp = readStamp(match[1]);
            return {
                seq: 0,
                at: stamp.at,
                time: stamp.time,
                tag: ADVICE_TAGS.includes(tag) ? tag : "review",
                title: truncateToBytes(match[3], 1024),
                detail: truncateToBytes(body),
                logged: true,
            };
        });
}

/**
 * Prepends the history the ring cannot have.
 *
 * Both sequences are appends of the same events in the same order, and the ring always holds the
 * most recent of them, so the ring's logged entries are exactly a suffix of the file. The count
 * that is missing is therefore the file's prefix — no timestamp matching, no heuristic dedupe.
 *
 * This is what restores messages after a panel is reopened or the extension is reloaded: a
 * reload empties the ring but the advice log is keyed to the session, so the whole file is
 * missing and the whole file is prepended. That file has no length limit of its own, which is
 * why the result is bounded by serialized size before it becomes a response.
 */
export function mergeDurableHistory(logged, ring) {
    const missing = logged.length - ring.reduce((n, e) => n + (e.logged ? 1 : 0), 0);
    if (missing <= 0) return boundBySerializedBytes(ring.slice());
    return boundBySerializedBytes([...logged.slice(0, missing), ...ring]);
}

/** Escapes text interpolated into the served HTML. Dynamic content uses `textContent` instead. */
export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Rendered with DOM APIs and `textContent` rather than by building HTML strings, so an advice
// note containing markup is structurally incapable of becoming markup — the escaping is not a
// function anyone has to remember to call. `escapeHtml` covers the one value interpolated into
// the document itself, the title.
function clientScript(basePath) {
    return [
        "const BASE = " + JSON.stringify(basePath) + ";",
        "const LIMIT = " + JSON.stringify(ACTIVITY_LIMIT) + ";",
        "const TAGS = " + JSON.stringify(PANEL_TAGS) + ";",
        // Formatted in the browser, so the reader sees their own local date and time rather than
        // the extension host's. The server persists the instant; only the rendering is local.
        "const STAMP_FORMAT = " + JSON.stringify(STAMP_FORMAT) + ";",
        "const STAMP_UNKNOWN_DATE = " + JSON.stringify(STAMP_UNKNOWN_DATE) + ";",
        "function stampOf(e) {",
        "  if (e.at) {",
        "    const d = new Date(e.at);",
        "    if (!Number.isNaN(d.getTime())) { return d.toLocaleString(undefined, STAMP_FORMAT); }",
        "  }",
        // No `at` means the entry predates dated logging. Its date is not recoverable, and
        // today's would be a lie, so the row says the date is missing instead.
        "  const time = (e.time || '').trim();",
        "  return time ? time + ' \\u2014 ' + STAMP_UNKNOWN_DATE : '';",
        "}",
        // Every tag on by default, and unchecking removes one. The panel exists to show what the
        // advisor did, so the default has to be "all of it".
        "const active = new Set(TAGS);",
        "let entries = [];",
        "let lastSeq = 0;",
        "let historyError = null;",
        "let historyTruncated = false;",
        "let adviceLogPath = null;",
        "let source = null;",
        "const el = (id) => document.getElementById(id);",
        "const set = (id, value) => { el(id).textContent = String(value); };",
        "function show(id, value, isError) {",
        "  const node = el(id);",
        "  node.textContent = value || '';",
        "  node.hidden = !value;",
        "  node.className = isError ? 'error' : 'muted';",
        "}",
        // The badge answers "what is it doing right now" in one word, which the reference panel
        // puts beside the section title. Order matters: disabled outranks in-flight, and a
        // pending blocker outranks idle watching.
        "function phaseOf(s) {",
        "  if (!s) { return 'Loading'; }",
        "  if (!s.enabled) { return 'Disabled'; }",
        "  if (s.checkInFlight) { return 'Reviewing'; }",
        "  if (s.pendingAdvice) { return s.pendingAdvice + ' pending'; }",
        "  return 'Watching';",
        "}",
        "function renderStatus(s) {",
        "  if (!s) { return; }",
        "  set('phase', phaseOf(s));",
        "  set('configuration', (s.enabled ? 'Enabled' : 'Disabled') + ' | ' + s.model + ' (' + s.agentType +",
        "    ') | Reviews every ' + s.everyNToolCalls + ' tool calls | Blocks completion on ' +",
        "    (s.blockOnBlocker ? 'a blocker' : 'nothing'));",
        "  set('checks', s.checksRun);",
        "  set('advice', s.adviceDelivered);",
        "  set('cadence', s.toolCallsSinceCheck + '/' + s.currentInterval);",
        "  set('pending', s.pendingAdvice ? 'Pending ' + s.pendingAdvice + ', held for the next tool call.'",
        "    : s.checkInFlight ? 'A review is running now.' : 'No pending advice.');",
        "  show('last-error', s.lastError ? 'Last review error: ' + s.lastError : null, true);",
        "  renderSettings(s);",
        "}",
        // The settings form is the one part of the panel the user writes through, so it holds two
        // pieces of state the rest does not need: `base`, the values the server last confirmed,
        // and `dirty`, whether the user has typed since. `base` is what gets sent as `expected`,
        // which is how a change made elsewhere while the confirmation was on screen gets refused
        // instead of silently overwriting it.
        "let base = null;",
        "let dirty = false;",
        "const UNKNOWN = 'Outcome unknown \\u2014 the change may or may not have been applied. Refresh to see the current settings.';",
        // The edit controls only appear once there is an edit to act on, so an untouched panel
        // reads as the status display it mostly is. The preview follows the same edit, so the
        // exact change is always on screen next to the button that sends it.
        "function updateDirty() { el('settings-actions').hidden = !(dirty || unknown); renderPreview(); }",
        // A request that left this document and did not come back leaves the panel with no idea
        // what the advisor now holds. The honest response is to stop pretending: the form locks,
        // so a second Apply cannot land on top of a change that may already have happened, and
        // Reset cannot quietly redraw the pre-write values as though they were current. Only a
        // successful read of the real state clears it.
        "let unknown = false;",
        "function setUnknown(on) {",
        "  unknown = on;",
        "  for (const id of ['set-enabled', 'set-model', 'set-cadence', 'settings-apply', 'settings-reset']) {",
        "    el(id).disabled = on;",
        "  }",
        "  updateDirty();",
        "}",
        "function settingsOf(s) {",
        "  return { enabled: !!s.enabled, model: String(s.model || ''), everyNToolCalls: Number(s.everyNToolCalls) };",
        "}",
        "function sameSettings(a, b) {",
        "  return !!a && !!b && a.enabled === b.enabled && a.model === b.model && a.everyNToolCalls === b.everyNToolCalls;",
        "}",
        "function fillForm(s) {",
        "  el('set-enabled').checked = s.enabled;",
        "  el('set-model').value = s.model;",
        "  el('set-cadence').value = String(s.everyNToolCalls);",
        "}",
        "function readForm() {",
        "  return {",
        "    enabled: el('set-enabled').checked,",
        "    model: el('set-model').value.trim(),",
        "    everyNToolCalls: Number(el('set-cadence').value),",
        "  };",
        "}",
        "function describe(key, value) {",
        "  if (key === 'enabled') { return value ? 'enabled' : 'disabled'; }",
        "  if (key === 'everyNToolCalls') { return 'every ' + value + ' tool calls'; }",
        "  return String(value);",
        "}",
        "const SETTING_LABELS = { enabled: 'Advisor', model: 'Model', everyNToolCalls: 'Review cadence' };",
        "function diffSettings(from, to) {",
        "  const out = [];",
        "  for (const key of ['enabled', 'model', 'everyNToolCalls']) {",
        "    if (from[key] !== to[key]) { out.push(SETTING_LABELS[key] + ': ' + describe(key, from[key]) + ' \\u2192 ' + describe(key, to[key])); }",
        "  }",
        "  return out;",
        "}",
        "function settingsResult(text, ok) {",
        "  const node = el('settings-result');",
        "  node.textContent = text || '';",
        "  node.hidden = !text;",
        "  node.dataset.ok = ok ? 'yes' : 'no';",
        "  node.className = ok ? 'muted' : 'error';",
        "}",
        "function renderPreview() {",
        "  const box = el('settings-preview');",
        "  const list = el('settings-diff');",
        "  list.replaceChildren();",
        "  if (!base || !dirty) { box.hidden = true; return; }",
        "  const desired = readForm();",
        "  const lines = validateForm(desired) ? [] : diffSettings(base, desired);",
        "  for (const line of lines) { const li = document.createElement('li'); li.textContent = line; list.append(li); }",
        "  box.hidden = lines.length === 0;",
        "}",
        // A push from the server must not overwrite what the user is halfway through typing, and
        // must not be hidden from them either. So an edited form keeps its values and gains a
        // notice; an untouched one just follows the advisor.
        "function renderSettings(s) {",
        "  const next = settingsOf(s);",
        "  if (sameSettings(base, next)) { return; }",
        "  const first = base === null;",
        "  base = next;",
        "  if (first || !dirty) { fillForm(next); show('settings-note', null, false); updateDirty(); return; }",        "  show('settings-note', 'The advisor changed elsewhere while you were editing. Your edits are kept \\u2014 check them before applying.', false);",
        "  updateDirty();",
        "}",
        "function validateForm(desired) {",
        "  if (!desired.model) { return 'Model must not be empty.'; }",
        "  if (!Number.isInteger(desired.everyNToolCalls) || desired.everyNToolCalls < 1) {",
        "    return 'Review cadence must be a whole number of at least 1.';",
        "  }",
        "  return null;",
        "}",
        // Reset discards the edits and puts the advisor's own values back. It sends nothing.
        "function resetSettings() {",
        "  if (unknown) { return; }",
        "  dirty = false;",
        "  if (base) { fillForm(base); }",
        "  show('settings-note', null, false);",
        "  settingsResult(null, true);",
        "  updateDirty();",
        "}",
        // One button, one meaning. The change is previewed live above it as the form is edited, so
        // the user sees exactly what will be sent without paying a click for it — and, unlike the
        // review gate this replaces, there is no second piece of state that an edit can quietly
        // invalidate, leaving a button that does nothing and says nothing.
        //
        // Every path out of here writes a result line. A press that changes nothing must still say
        // so: silence is indistinguishable from a broken button, which is exactly how the gate
        // this replaces was reported.
        "async function applySettings(ev) {",
        "  if (ev) { ev.preventDefault(); }",
        "  settingsResult(null, true);",
        "  if (unknown) { settingsResult('Not applied \\u2014 refresh to read the advisor\\u0027s current settings first.', false); return; }",
        "  if (!base) { settingsResult('Not applied \\u2014 current settings are not loaded yet.', false); return; }",
        "  const desired = readForm();",
        "  const problem = validateForm(desired);",
        "  if (problem) { settingsResult('Not applied \\u2014 ' + problem, false); return; }",
        // The baseline is read once, here, so the request answers for the values the preview was
        // showing rather than whatever a push replaced them with mid-flight.
        "  const expected = base;",
        "  if (diffSettings(expected, desired).length === 0) { settingsResult('Nothing to change.', true); return; }",
        "  const button = el('settings-apply');",
        "  button.disabled = true;",
        "  try {",
        "    const r = await fetch(BASE + 'settings', {",
        "      method: 'POST',",
        "      cache: 'no-store',",
        "      headers: { 'Content-Type': 'application/json' },",
        "      body: JSON.stringify({ expected: expected, desired: desired }),",
        "    });",
        "    const body = await r.json().catch(() => null);",
        "    if (body && body.settings) { base = settingsOf(body.settings); }",
        "    if (body && body.status) { renderStatus(body.status); }",
        "    if (body && body.ok) {",
        "      dirty = false;",
        "      if (base) { fillForm(base); }",
        "      show('settings-note', null, false);",
        "      updateDirty();",
        "      const applied = Array.isArray(body.applied) ? body.applied : [];",
        "      settingsResult(applied.length ? 'Applied: ' + applied.map((k) => SETTING_LABELS[k] || k).join(', ') + '.' : 'Nothing to change.', true);",
        // A refusal the server named is a refusal: it rejected the request before changing
        // anything. Anything else — a 5xx, a body that is not the answer to this question — is
        // not evidence that nothing happened, and saying so would be a guess dressed as a fact.
        "    } else if (body && body.message && r.status < 500) {",
        "      updateDirty();",
        "      settingsResult('Not applied \\u2014 ' + body.message, false);",
        "    } else {",
        "      setUnknown(true);",
        "      settingsResult(UNKNOWN + ' (' + r.status + ')', false);",
        "    }",
        "  } catch (err) {",
        // The request left this document. Whether it arrived is exactly what a network error does
        // not say, so this cannot claim the settings were left alone.
        "    setUnknown(true);",
        "    settingsResult(UNKNOWN + ' (' + err.message + ')', false);",
        "  } finally {",
        "    button.disabled = unknown;",
        "  }",
        "}",
        // Tag selection and search compose: an entry must pass both. Selection is a set rather
        // than a single value so several severities can be watched at once, which is the whole
        // reason the filter is a row of checkboxes and not a dropdown.
        "function visible() {",
        "  const text = el('search').value.trim().toLocaleLowerCase();",
        "  return entries",
        "    .filter((e) => active.has(e.tag) &&",
        "      ((e.title || '') + ' ' + (e.detail || '')).toLocaleLowerCase().includes(text))",
        // Newest first: the reason to open this panel is almost always the most recent thing.
        "    .reverse();",
        "}",
        "function renderEntries() {",
        "  const shown = visible();",
        "  set('count', shown.length + ' of ' + entries.length);",
        "  const host = el('entries'); host.replaceChildren();",
        "  for (const e of shown) {",
        "    const item = document.createElement('li');",
        "    item.dataset.kind = e.tag;",
        "    const meta = document.createElement('div');",
        "    meta.className = 'entry-meta';",
        // Durable entries parsed back out of the advice log carry an ISO instant if the advisor
        // recorded one, and nothing but a clock time if they predate that. Both are shown for
        // what they are — a full local date and time, or a time that says its date is missing.
        // Neither ever borrows today's date, which is how a week-old blocker came to be read as
        // current.
        "    const when = stampOf(e);",
        "    meta.textContent = [e.tag, e.title, when].filter(Boolean).join(' | ');",
        "    const message = document.createElement('p');",
        "    message.className = 'entry-message';",
        "    message.textContent = e.detail || '';",
        "    item.append(meta, message);",
        "    host.append(item);",
        "  }",
        "  const empty = el('empty');",
        "  empty.hidden = shown.length > 0;",
        "  empty.textContent = entries.length ? 'No matching activity.' : 'No advisor activity recorded yet this session.';",
        "}",
        "function renderNotice() {",
        "  if (historyError) { show('history', 'Earlier advice could not be read: ' + historyError, true); }",
        "  else if (historyTruncated) { show('history', 'Showing recent advice only \\u2014 earlier entries exceed the display limit.', false); }",
        "  else { show('history', null, false); }",
        "  set('session', (adviceLogPath ? 'Advice log ' + adviceLogPath : 'Advice log disabled') +",
        "    ' | Retaining up to ' + LIMIT + ' activity entries.');",
        "}",
        "function applySnapshot(snap) {",
        "  entries = Array.isArray(snap.entries) ? snap.entries : [];",
        "  historyError = snap.historyError || null;",
        "  historyTruncated = !!snap.historyTruncated;",
        "  adviceLogPath = snap.adviceLogPath || null;",
        "  lastSeq = entries.reduce((m, e) => (e.seq > m ? e.seq : m), 0);",
        "  renderStatus(snap.status); renderEntries(); renderNotice();",
        // A readiness flag rather than a sleep: the renderer test asserts on what the document
        // holds after the first snapshot, and a timing guess would be both slower and flaky.
        "  window.__advisorPanelReady = true;",
        "}",
        "function setConn(text, ok) { const c = el('connection'); c.textContent = text; c.dataset.ok = ok ? 'yes' : 'no'; }",
        "async function load() {",
        "  const button = el('refresh');",
        "  button.disabled = true;",
        "  try {",
        "    const r = await fetch(BASE + 'state', { cache: 'no-store' });",
        "    if (!r.ok) { throw new Error('Status request failed (' + r.status + ')'); }",
        // A successful read is the only thing that can resolve an unknown outcome: it is the
        // advisor's actual state, which is exactly what the failed request left in doubt.
        "    const recovered = unknown;",
        "    if (recovered) { dirty = false; base = null; setUnknown(false); }",
        "    applySnapshot(await r.json());",
        "    if (recovered) { show('settings-note', null, false); settingsResult('Reloaded \\u2014 these are the advisor\\u0027s current settings.', true); }",
        "    setConn('Live updates connected', true);",
        "    show('error', null, true);",
        "  } catch (err) {",
        "    setConn('Disconnected \\u2014 displayed data may be stale.', false);",
        "    show('error', err.message, true);",
        "  } finally {",
        "    button.disabled = false;",
        "  }",
        "}",
        "function connect() {",
        "  if (source) { source.close(); }",
        "  source = new EventSource(BASE + 'events');",
        "  source.onopen = () => { setConn('Live updates connected', true); load(); };",
        "  source.onerror = () => setConn('Disconnected \\u2014 displayed data may be stale. Reconnecting\\u2026', false);",
        "  source.addEventListener('entry', (ev) => {",
        "    const e = JSON.parse(ev.data);",
        "    if (e.seq <= lastSeq) { return; }",
        "    lastSeq = e.seq; entries.push(e);",
        "    if (entries.length > LIMIT * 4) { entries.splice(0, 1); }",
        "    renderEntries();",
        "  });",
        "  source.addEventListener('status', (ev) => renderStatus(JSON.parse(ev.data)));",
        "  source.addEventListener('refresh', () => load());",
        "}",
        "document.querySelectorAll('input[data-tag]').forEach((box) => {",
        "  box.addEventListener('change', () => {",
        "    if (box.checked) { active.add(box.dataset.tag); } else { active.delete(box.dataset.tag); }",
        "    renderEntries();",
        "  });",
        "});",
        "el('search').addEventListener('input', renderEntries);",
        "el('refresh').addEventListener('click', load);",
        // Apply is the form's submit button, so the click and the Enter key are the same path —
        // bound once, so a press cannot post twice.
        "el('settings').addEventListener('submit', applySettings);",
        "el('settings-reset').addEventListener('click', resetSettings);",
        "for (const id of ['set-enabled', 'set-model', 'set-cadence']) {",
        "  const onEdit = () => { if (unknown) { return; } dirty = !sameSettings(base, readForm()); updateDirty(); };",
        "  el(id).addEventListener('input', onEdit);",
        "  el(id).addEventListener('change', onEdit);",
        "}",
        "window.addEventListener('pagehide', () => { if (source) { source.close(); } }, { once: true });",
        "load(); connect();",
    ].join("\n");
}

// Adapted from the self-learn panel so the two read as one product: the same type scale, the
// 880px centred column, section rules instead of full-bleed bars, restrained metric cards and
// muted footer. Advisor-specific additions are the severity colouring on a row and the
// connection state, which self-learn does not have to show.
const STYLES = [
    ":root{color-scheme:light dark}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--background-color-default,#fff);color:var(--text-color-default,#202124);",
    "font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--text-body-medium,14px);line-height:1.5}",
    "main{max-width:880px;margin:auto;padding:20px}",
    "header,.activity-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}",
    "header > div{min-width:0}",
    "header button{flex-shrink:0}",
    "h1{font-size:24px;line-height:1.3;margin:0}",
    "h2{font-size:16px;margin:0 0 12px}",
    "p{overflow-wrap:anywhere}",
    ".eyebrow{margin:0 0 4px;color:var(--text-color-muted,#656d76);font-size:12px}",
    ".muted,footer{color:var(--text-color-muted,#656d76);font-size:12px}",
    "#connection{color:var(--text-color-muted,#656d76);font-size:12px;min-height:18px}",
    "#connection[data-ok='no']{color:var(--true-color-red,#c62828)}",
    "section{border-top:1px solid var(--border-color-default,#d0d7de);margin-top:20px;padding-top:20px}",
    ".badge{font-size:12px;font-weight:normal;border:1px solid var(--border-color-default,#d0d7de);border-radius:20px;padding:3px 10px;margin-left:8px}",
    ".metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
    ".metrics div{padding:12px;border:1px solid var(--border-color-default,#d0d7de);border-radius:8px}",
    ".metrics strong{display:block;font-size:24px;font-weight:var(--font-weight-semibold,600)}",
    ".metrics span{color:var(--text-color-muted,#656d76);font-size:12px}",
    ".filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:8px 0 16px}",
    "label{display:flex;align-items:center;gap:8px;font-size:12px}",
    // A borderless fieldset keeps the grouping semantics the checkboxes need while looking like
    // the reference's single filter row. `min-width:0` so it can shrink instead of forcing the
    // panel to scroll sideways at 320px.
    ".kinds{border:0;margin:0;padding:0;min-width:0;display:flex;flex-wrap:wrap;gap:2px 12px;flex:1 1 260px}",
    ".kinds legend{padding:0;font-size:12px;color:var(--text-color-muted,#656d76)}",
    ".check{gap:6px;white-space:nowrap}",
    ".check input{width:auto;min-width:0;padding:0;border:0;border-radius:0;accent-color:var(--color-focus-outline,#0969da)}",
    ".search{flex:1 1 180px;min-width:0}",
    "input[type='search']{width:100%;min-width:80px}",
    // The settings form reuses the reference panel's field rhythm: a narrow column so a text
    // input never stretches the width of a desktop window, and rows that stack on a phone.
    ".settings{display:grid;gap:12px;max-width:420px;margin-bottom:12px}",
    ".field{flex-direction:column;align-items:stretch;gap:4px}",
    ".field input{width:100%}",
    ".row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
    ".confirm{border:1px solid var(--border-color-default,#d0d7de);border-radius:8px;padding:12px;max-width:420px;display:grid;gap:8px}",
    ".confirm p{margin:0}",
    ".confirm ul{margin:0;padding-left:18px;font-size:12px}",
    "#settings-result{margin-top:12px}",
    "input,button{font:inherit;color:inherit;background:var(--background-color-default,#fff);",
    "border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;padding:7px 10px}",
    "button{cursor:pointer}",
    "button:disabled{opacity:.6;cursor:wait}",
    ":focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}",
    "ol{list-style:none;padding:0}",
    "li{border-bottom:1px solid var(--border-color-default,#d0d7de);padding:8px 0 12px;margin-bottom:12px}",
    // Severity is the advisor's whole point, so it colours the row's meta line. The reference
    // panel colours errors the same way; these are the same rule with more kinds.
    "li[data-kind='blocker'] .entry-meta,li[data-kind='error'] .entry-meta{color:var(--true-color-red,#c62828)}",
    "li[data-kind='control'] .entry-meta{color:var(--true-color-blue,#0969da)}",
    ".entry-meta{color:var(--text-color-muted,#656d76);font-size:12px}",
    // Advice notes carry paths, hashes and stack frames — unbroken runs far longer than a side
    // panel is wide. Without `anywhere` they do not wrap and the whole panel scrolls sideways.
    ".entry-message{white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0 0}",
    ".error{color:var(--true-color-red,#c62828)}",
    "footer{border-top:1px solid var(--border-color-default,#d0d7de);margin-top:24px;padding-top:8px}",
    "@media (max-width:360px){main{padding:12px}.metrics{gap:6px}.metrics div{padding:8px}header{align-items:flex-start}}",
    "@media (prefers-color-scheme:dark){",
    "body{background:var(--background-color-default,#181818);color:var(--text-color-default,#e5e5e5)}",
    "input,button{background:var(--background-color-default,#181818)}",
    ".muted,footer,.eyebrow,#connection,.metrics span,.entry-meta,.kinds legend{color:var(--text-color-muted,#a6adb4)}",
    ".error,#connection[data-ok='no'],li[data-kind='blocker'] .entry-meta,li[data-kind='error'] .entry-meta{color:var(--true-color-red,#ff8c8c)}",
    "}",
].join("");

const TAG_LABELS = {
    blocker: "Blockers",
    concern: "Concerns",
    nit: "Nits",
    review: "Reviews",
    control: "Control changes",
    error: "Errors",
};

/** The canvas document. `basePath` carries the per-server token, so it is never a constant. */
export function renderPanelHtml({ basePath, title = "Advisor activity", nonce = "" }) {
    const filters = PANEL_TAGS.map(
        (tag) =>
            `<label class="check"><input type="checkbox" data-tag="${escapeHtml(tag)}" checked /> ` +
            `${escapeHtml(TAG_LABELS[tag] ?? tag)}</label>`,
    ).join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<main>
  <header>
    <div><p class="eyebrow">Session reviewer</p><h1>${escapeHtml(title)}</h1></div>
    <button id="refresh" type="button">Refresh</button>
  </header>
  <p id="connection" role="status" aria-live="polite" data-ok="no">Connecting\u2026</p>
  <p id="error" class="error" role="alert" hidden></p>
  <p id="history" class="muted" role="status" hidden></p>
  <section aria-labelledby="status-title">
    <h2 id="status-title">Current status <span id="phase" class="badge">Loading</span></h2>
    <p id="configuration"></p>
    <div class="metrics">
      <div><strong id="checks">-</strong><span>Reviews</span></div>
      <div><strong id="advice">-</strong><span>Advice delivered</span></div>
      <div><strong id="cadence">-</strong><span>Tool calls since review</span></div>
    </div>
    <p class="muted">Counters are since this extension loaded; advice below survives reloads.</p>
    <p id="pending"></p>
    <p id="last-error" class="error" hidden></p>
  </section>
  <section aria-labelledby="settings-title">
    <h2 id="settings-title">Session settings</h2>
    <p class="muted">These apply to this session only. Your configuration file is not changed, and a review already running is not cancelled.</p>
    <!-- novalidate: the browser's own constraint check blocks submit before any handler runs and
         answers with a transient tooltip, which is another way for a press of Apply to look like
         nothing happened. The form's rules are enforced in validateForm, which always writes a
         result line the user can read. -->
    <form id="settings" class="settings" novalidate>
      <label class="check"><input id="set-enabled" type="checkbox" /> Advisor enabled</label>
      <label class="field">Model<input id="set-model" type="text" autocomplete="off" spellcheck="false" /></label>
      <label class="field">Review every N tool calls<input id="set-cadence" type="number" min="1" step="1" /></label>
      <p id="settings-note" class="muted" role="status" aria-live="polite" hidden></p>
      <div id="settings-preview" class="confirm" hidden>
        <p><strong>Pending change</strong></p>
        <ul id="settings-diff"></ul>
      </div>
      <div id="settings-actions" class="row" hidden>
        <button id="settings-apply" type="submit">Apply change</button>
        <button id="settings-reset" type="button">Reset</button>
      </div>
    </form>
    <p id="settings-result" class="muted" role="status" aria-live="polite" hidden></p>
  </section>
  <section aria-labelledby="activity-title">
    <div class="activity-heading"><h2 id="activity-title">Recent activity</h2><span id="count" class="muted"></span></div>
    <div class="filters">
      <fieldset id="kinds" class="kinds">
        <legend>Show</legend>
        ${filters}
      </fieldset>
      <label class="search">Search <input id="search" type="search" placeholder="Filter advice" /></label>
    </div>
    <p id="empty" class="muted">Waiting for activity\u2026</p>
    <ol id="entries" aria-label="Advisor activity, newest first"></ol>
  </section>
  <footer>
    <p>Activity above is read-only. The settings here change only this session; anything else \u2014 a review, a config reload \u2014 still goes through the agent and its confirmation dialog.</p>
    <p id="session" class="muted"></p>
  </footer>
</main>
<script nonce="${nonce}">${clientScript(basePath)}</script>
</body>
</html>`;
}
// One loopback server per open panel.
//
// The renderer is an iframe with no privileged bridge to the host, so state reaches it over
// ordinary HTTP. Four things guard a server that is, unavoidably, listening on a port any local
// process can reach:
//
//   - an unguessable token in the path, compared in constant time;
//   - a `Host` check, which is what actually stops DNS rebinding — an attacker who resolves
//     their own name to 127.0.0.1 arrives with their name in `Host`, not ours;
//   - an `Origin` check, which rejects cross-origin `fetch` (a same-origin GET sends no `Origin`,
//     and the host's iframe navigation sends none either, so this rejects only what it should);
//   - no CORS headers at all, so a browser would refuse to hand over a response even if one
//     escaped the three checks above.
//
// There is deliberately no endpoint that reads a caller-supplied path. The advice log is read by
// the extension and served as parsed entries; the server proxies no files.
//
// `getStatus` is separate from `getSnapshot` on purpose. The snapshot re-reads the session's
// advice log so an explicit refresh cannot show stale history; status is sampled every couple of
// seconds and must stay cheap, so it never touches the disk.
export async function createPanelServer({
    getSnapshot,
    getStatus,
    subscribe,
    title,
    applySettings = null,
    statusIntervalMs = 2000,
    onError = () => {},
}) {
    const token = randomBytes(24).toString("hex");
    const basePath = `/${token}/`;
    const clients = new Set();
    // Clients whose socket has refused bytes. Skipped until `drain`; see `write`.
    const saturated = new Set();

    let origin = "";
    let host = "";

    const server = createServer((req, res) => {
        const fail = (err) => {
            onError(err);
            try {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
                res.end("error");
            } catch {
                // The response is already gone; nothing left to do but not throw.
            }
        };
        try {
            // The settings route is async, so a rejection here would otherwise escape as an
            // unhandled rejection rather than a 500.
            const pending = handle(req, res);
            if (pending && typeof pending.then === "function") pending.catch(fail);
        } catch (err) {
            fail(err);
        }
    });

    function deny(res, code) {
        // No detail in the body: a 404 that explains itself is a probing oracle.
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end();
    }

    function tokenMatches(candidate) {
        const given = Buffer.from(String(candidate ?? ""), "utf8");
        const want = Buffer.from(token, "utf8");
        return given.length === want.length && timingSafeEqual(given, want);
    }

    function securityHeaders(extra) {
        return {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            // Without this the token would leak in the `Referer` of any outbound navigation.
            "Referrer-Policy": "no-referrer",
            ...extra,
        };
    }

    function handle(req, res) {
        if (req.headers.host !== host) return deny(res, 403);
        if (req.headers.origin && req.headers.origin !== origin) return deny(res, 403);

        const parts = new URL(req.url, origin).pathname.split("/").filter(Boolean);
        if (parts.length === 0 || !tokenMatches(parts[0])) return deny(res, 404);

        const route = parts[1] ?? "";
        // The one write. It exists only when the extension handed this server something to write
        // to; a panel with no `applySettings` has no such route at all rather than a route that
        // refuses, so a read-only panel cannot be probed for one.
        if (route === "settings" && applySettings) {
            if (req.method !== "POST") return deny(res, 405);
            return receiveSettings(req, res);
        }

        if (req.method !== "GET") return deny(res, 405);

        switch (route) {
            case "":
                return sendHtml(res);
            case "state":
                return sendState(res);
            case "events":
                return sendEvents(req, res);
            default:
                return deny(res, 404);
        }
    }

    function sendJson(res, code, payload) {
        res.writeHead(code, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
        res.end(JSON.stringify(payload));
    }

    // Buffers at most `MAX_SETTINGS_BODY_BYTES`. A settings write is three small values, so a body
    // that needs more than 4KiB is not one, and reading it to find out is the only thing worth
    // refusing here.
    function readBody(req) {
        return new Promise((resolve, reject) => {
            const declared = Number(req.headers["content-length"]);
            if (Number.isFinite(declared) && declared > MAX_SETTINGS_BODY_BYTES) {
                const err = new Error("body too large");
                err.code = "too-large";
                reject(err);
                return;
            }
            let size = 0;
            const chunks = [];
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_SETTINGS_BODY_BYTES) {
                    const err = new Error("body too large");
                    err.code = "too-large";
                    reject(err);
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
        });
    }

    async function receiveSettings(req, res) {
        // A read may arrive without an `Origin` — a same-origin GET and the host's own iframe
        // navigation both do. A write may not: the absence that is unremarkable on a read is the
        // signature of a request that did not come from this document, and this is the request
        // that changes something.
        if (req.headers.origin !== origin) return deny(res, 403);
        const type = String(req.headers["content-type"] ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();
        if (type !== "application/json") return deny(res, 415);

        let text;
        try {
            text = await readBody(req);
        } catch (err) {
            if (err?.code === "too-large") {
                deny(res, 413);
                req.destroy();
                return;
            }
            return deny(res, 400);
        }

        const parsed = parseSettingsRequest(text);
        if (parsed.error) return sendJson(res, 400, { ok: false, code: "invalid", message: parsed.error });

        let result;
        try {
            result = await applySettings(parsed.request);
        } catch (err) {
            onError(err);
            return sendJson(res, 500, { ok: false, code: "failed", message: "the change could not be applied" });
        }
        if (result?.ok) return sendJson(res, 200, result);
        return sendJson(res, result?.code === "stale" ? 409 : 400, result ?? { ok: false, code: "failed" });
    }

    function sendHtml(res) {
        // Per-response nonce, so the one inline script is allowed by name and nothing else is.
        // `frame-ancestors` is deliberately absent: the host embeds this document in an iframe
        // whose origin is not knowable here, and restricting ancestors would block the only
        // consumer. The token is what makes that safe.
        const nonce = randomBytes(16).toString("base64");
        const body = renderPanelHtml({ basePath, title, nonce });
        res.writeHead(
            200,
            securityHeaders({
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": [
                    "default-src 'none'",
                    `style-src 'nonce-${nonce}'`,
                    `script-src 'nonce-${nonce}'`,
                    "connect-src 'self'",
                    "base-uri 'none'",
                    "form-action 'none'",
                ].join("; "),
            }),
        );
        res.end(body);
    }

    function sendState(res) {
        const snapshot = getSnapshot();
        res.writeHead(200, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
        res.end(JSON.stringify(snapshot));
    }

    function sendEvents(req, res) {
        res.writeHead(
            200,
            securityHeaders({
                "Content-Type": "text/event-stream; charset=utf-8",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            }),
        );
        res.write(": open\n\n");
        clients.add(res);
        const drop = () => {
            clients.delete(res);
            saturated.delete(res);
        };
        req.on("close", drop);
        req.on("error", drop);
        res.on("error", drop);
    }

    function broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of [...clients]) {
            if (saturated.has(res)) continue;
            write(res, payload);
        }
    }

    // A stalled reader is not a broken one — a laptop that slept, a renderer mid-layout — so a
    // `write` returning false must not tear the connection down; destroying it there is what
    // turns one slow client into a reconnect loop. But the bytes it refused are buffered in this
    // process, and nothing bounds that, so the stream cannot simply keep pushing either.
    //
    // Instead the client is marked saturated and skipped until `drain`, then sent a single
    // `refresh` — which the renderer already handles by re-fetching `/state`. Any number of
    // missed entries collapses into one bounded response, so catching up costs the same whether
    // the client missed one event or a thousand.
    function write(res, payload) {
        try {
            if (res.write(payload) === false) {
                saturated.add(res);
                res.once("drain", () => {
                    if (!clients.has(res)) return;
                    saturated.delete(res);
                    write(res, "event: refresh\ndata: {}\n\n");
                });
            }
        } catch {
            saturated.delete(res);
            clients.delete(res);
        }
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    server.on("error", onError);

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;

    // New activity is pushed rather than polled, so the panel is live without the renderer
    // hammering `/state`.
    const unsubscribe = subscribe((entry) => broadcast("entry", entry));

    // Status has no event to hang off — `checkInFlight` and `pendingAdvice` change inside the
    // review loop — so it is sampled. Only a change is sent, so an idle panel costs nothing on
    // the wire, and the timer is unref'd so a forgotten panel cannot hold the process open.
    let lastStatus = "";
    const statusTimer = setInterval(() => {
        if (clients.size === 0) return;
        try {
            const next = JSON.stringify(getStatus());
            if (next === lastStatus) return;
            lastStatus = next;
            broadcast("status", JSON.parse(next));
        } catch (err) {
            onError(err);
        }
    }, statusIntervalMs);
    statusTimer.unref?.();

    return {
        url: `${origin}${basePath}`,
        port,
        token,
        basePath,
        get clientCount() {
            return clients.size;
        },
        // Tells every connected renderer to re-fetch. The panel is read-only, so this is the
        // whole of what an agent-invoked action can do to it.
        refresh() {
            broadcast("refresh", { at: new Date().toISOString() });
            return clients.size;
        },
        async close() {
            clearInterval(statusTimer);
            unsubscribe();
            for (const res of [...clients]) {
                try {
                    res.end();
                } catch {
                    // Already gone.
                }
            }
            clients.clear();
            saturated.clear();
            // Keep-alive sockets would otherwise hold `close` open until they time out.
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}