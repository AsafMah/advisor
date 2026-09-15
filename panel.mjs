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
            return {
                seq: 0,
                at: null,
                time: match[1],
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
        "}",
        "function visible() {",
        "  const kind = el('kind').value;",
        "  const text = el('search').value.trim().toLocaleLowerCase();",
        "  return entries",
        "    .filter((e) => (kind === 'all' || e.tag === kind) &&",
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
        // Durable entries parsed back out of the advice log have no ISO timestamp, only the
        // locale time the log recorded, so `at` is the preferred source and `time` the fallback.
        "    const when = e.at ? new Date(e.at).toLocaleString() : (e.time || '');",
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
        "    applySnapshot(await r.json());",
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
        "for (const id of ['kind', 'search']) { el(id).addEventListener('input', renderEntries); }",
        "el('refresh').addEventListener('click', load);",
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
    ".filters{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 16px}",
    "label{display:flex;align-items:center;gap:8px;font-size:12px}",
    ".search{flex:1 1 180px;min-width:0}",
    "input{width:100%;min-width:80px}",
    "input,select,button{font:inherit;color:inherit;background:var(--background-color-default,#fff);",
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
    "input,select,button{background:var(--background-color-default,#181818)}",
    ".muted,footer,.eyebrow,#connection,.metrics span,.entry-meta{color:var(--text-color-muted,#a6adb4)}",
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
    const options = [
        `<option value="all">All activity</option>`,
        ...PANEL_TAGS.map(
            (tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(TAG_LABELS[tag] ?? tag)}</option>`,
        ),
    ].join("");
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
  <section aria-labelledby="activity-title">
    <div class="activity-heading"><h2 id="activity-title">Recent activity</h2><span id="count" class="muted"></span></div>
    <div class="filters">
      <label>Show <select id="kind">${options}</select></label>
      <label class="search">Search <input id="search" type="search" placeholder="Filter advice" /></label>
    </div>
    <p id="empty" class="muted">Waiting for activity\u2026</p>
    <ol id="entries" aria-label="Advisor activity, newest first"></ol>
  </section>
  <footer>
    <p>This panel is read-only. Ask the agent for advisor status, the advice log, or a review. Changing the advisor still requires the existing confirmation dialog.</p>
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
        try {
            handle(req, res);
        } catch (err) {
            onError(err);
            try {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
                res.end("error");
            } catch {
                // The response is already gone; nothing left to do but not throw.
            }
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
        if (req.method !== "GET") return deny(res, 405);
        if (req.headers.host !== host) return deny(res, 403);
        if (req.headers.origin && req.headers.origin !== origin) return deny(res, 403);

        const parts = new URL(req.url, origin).pathname.split("/").filter(Boolean);
        if (parts.length === 0 || !tokenMatches(parts[0])) return deny(res, 404);

        switch (parts[1] ?? "") {
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