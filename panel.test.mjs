// Tests for the activity panel: the data layer, the bounds, and the server's guards.
//
// `panel.mjs` is deliberately free of any SDK import so it can be imported directly here. The
// server tests speak raw HTTP over `node:net` rather than using `fetch`, because `fetch` silently
// drops a manually-set `Host` header — it is a forbidden header name — which turns the DNS
// rebinding test into one that passes no matter what the server does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

import {
    ACTIVITY_LIMIT,
    MAX_DETAIL_BYTES,
    MAX_PAYLOAD_BYTES,
    boundBySerializedBytes,
    createActivityLog,
    createPanelServer,
    escapeHtml,
    mergeDurableHistory,
    parseAdviceLog,
    parseSettingsRequest,
    renderPanelHtml,
    truncateToBytes,
} from "./panel.mjs";

const SEPARATOR = "\n\n---\n\n";

// --- activity log ---------------------------------------------------------------------------

test("activity log stamps defaults and a monotonic sequence", () => {
    const log = createActivityLog();
    const first = log.push({ tag: "blocker", title: "stop" });
    const second = log.push({ title: "note" });

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(second.tag, "review", "unspecified tag defaults to review");
    assert.equal(first.logged, false);
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
});

test("activity log is bounded and keeps the newest entries", () => {
    const log = createActivityLog(3);
    for (let i = 1; i <= 10; i++) log.push({ title: `entry ${i}` });

    const entries = log.list();
    assert.equal(entries.length, 3);
    assert.deepEqual(
        entries.map((e) => e.title),
        ["entry 8", "entry 9", "entry 10"],
    );
    assert.equal(log.limit, 3);
});

test("activity log default limit is the exported constant", () => {
    const log = createActivityLog();
    assert.equal(log.limit, ACTIVITY_LIMIT);
});

test("a throwing subscriber cannot break the push that fed it", () => {
    const log = createActivityLog();
    log.subscribe(() => {
        throw new Error("renderer blew up");
    });
    const seen = [];
    log.subscribe((e) => seen.push(e.title));

    assert.doesNotThrow(() => log.push({ title: "still delivered" }));
    assert.deepEqual(seen, ["still delivered"]);
});

test("unsubscribe leaves nothing behind", () => {
    const log = createActivityLog();
    const off = log.subscribe(() => {});
    assert.equal(log.listenerCount, 1);
    off();
    assert.equal(log.listenerCount, 0);
});

test("loggedCount counts only entries that reached the advice log", () => {
    const log = createActivityLog();
    log.push({ title: "a", logged: true });
    log.push({ title: "b", logged: false });
    log.push({ title: "c", logged: true });
    assert.equal(log.loggedCount(), 2);
});

// --- byte bounds ----------------------------------------------------------------------------

test("truncateToBytes leaves anything within budget untouched", () => {
    const text = "short enough";
    assert.equal(truncateToBytes(text, 1024), text);
});

test("truncateToBytes measures bytes, not characters", () => {
    // 4096 CJK characters is well under any character-count cap and four times over an 8 KiB
    // byte budget — the exact case a `length` check misses.
    const text = "字".repeat(4096);
    assert.equal(text.length, 4096);
    assert.ok(Buffer.byteLength(text, "utf8") > MAX_DETAIL_BYTES);

    const cut = truncateToBytes(text, MAX_DETAIL_BYTES);
    assert.ok(Buffer.byteLength(cut, "utf8") <= MAX_DETAIL_BYTES);
    assert.match(cut, /truncated$/);
});

test("truncateToBytes never splits a multi-byte character", () => {
    // Budgets chosen to land the cut inside a 3-byte sequence rather than between two.
    for (let budget = 20; budget < 40; budget++) {
        const cut = truncateToBytes("字".repeat(100), budget);
        assert.ok(!cut.includes("\uFFFD"), `budget ${budget} produced a replacement character`);
        assert.ok(Buffer.byteLength(cut, "utf8") <= budget, `budget ${budget} overran`);
    }
});

test("truncateToBytes handles astral characters", () => {
    const cut = truncateToBytes("😀".repeat(100), 30);
    assert.ok(!cut.includes("\uFFFD"));
    assert.ok(Buffer.byteLength(cut, "utf8") <= 30);
});

test("activity log truncates oversized detail on the way in", () => {
    const log = createActivityLog();
    const entry = log.push({ title: "x".repeat(5000), detail: "字".repeat(20000) });
    assert.ok(Buffer.byteLength(entry.detail, "utf8") <= MAX_DETAIL_BYTES);
    assert.ok(Buffer.byteLength(entry.title, "utf8") <= 1024);
});

test("boundBySerializedBytes bounds the serialized payload, not the entry count", () => {
    // 200 entries is within any count-based limit; as UTF-8 JSON it is over 2 MiB.
    const entries = Array.from({ length: 200 }, (_, i) => ({
        seq: i + 1,
        at: new Date().toISOString(),
        time: "12:00:00",
        tag: "concern",
        title: `entry ${i + 1}`,
        detail: "字".repeat(4096),
        logged: true,
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(entries), "utf8") > 2 * 1024 * 1024);

    const bounded = boundBySerializedBytes(entries);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MAX_PAYLOAD_BYTES);
    assert.ok(bounded.length > 0);
    assert.equal(bounded.at(-1).seq, 200, "the newest entry is the one kept");
});

test("boundBySerializedBytes keeps a single oversized entry rather than returning nothing", () => {
    const entries = [{ seq: 1, title: "huge", detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) }];
    const bounded = boundBySerializedBytes(entries);
    assert.equal(bounded.length, 1, "an empty panel is worse than an oversized one");
});

test("boundBySerializedBytes leaves a small list alone", () => {
    const entries = [{ seq: 1, title: "a" }, { seq: 2, title: "b" }];
    assert.deepEqual(boundBySerializedBytes(entries), entries);
});

// --- advice log parsing ---------------------------------------------------------------------

test("parseAdviceLog reads the advisor's own log format", () => {
    const text = [
        "### [12:00:01] BLOCKER (raised)\nDo not ship this.",
        "### [12:05:09] concern (injected)\nConsider the null case.",
    ].join(SEPARATOR);

    const entries = parseAdviceLog(text, SEPARATOR);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        seq: 0,
        at: null,
        time: "12:00:01",
        tag: "blocker",
        title: "raised",
        detail: "Do not ship this.",
        logged: true,
    });
    assert.equal(entries[1].tag, "concern", "severity is normalised to lower case");
});

test("parseAdviceLog surfaces an unparseable entry instead of dropping it", () => {
    const entries = parseAdviceLog("something entirely unexpected", SEPARATOR);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, "unparsed log entry");
    assert.equal(entries[0].detail, "something entirely unexpected");
});

test("parseAdviceLog tolerates empty and blank input", () => {
    assert.deepEqual(parseAdviceLog("", SEPARATOR), []);
    assert.deepEqual(parseAdviceLog(null, SEPARATOR), []);
    assert.deepEqual(parseAdviceLog(SEPARATOR + SEPARATOR, SEPARATOR), []);
});

test("parseAdviceLog bounds an oversized entry from disk", () => {
    const text = `### [12:00:01] blocker (raised)\n${"字".repeat(20000)}`;
    const [entry] = parseAdviceLog(text, SEPARATOR);
    assert.ok(Buffer.byteLength(entry.detail, "utf8") <= MAX_DETAIL_BYTES);
});

test("parseAdviceLog marks an unknown severity as a plain review", () => {
    const [entry] = parseAdviceLog("### [12:00:01] whatever (raised)\nbody", SEPARATOR);
    assert.equal(entry.tag, "review");
});

// --- durable history merge ------------------------------------------------------------------

const logged = (n) => ({ seq: 0, tag: "concern", title: `file ${n}`, detail: "", logged: true, at: null, time: "" });
const ringEntry = (n, isLogged) => ({ seq: n, tag: "concern", title: `ring ${n}`, detail: "", logged: isLogged });

test("mergeDurableHistory prepends exactly the prefix the ring cannot hold", () => {
    const file = [logged(1), logged(2), logged(3), logged(4)];
    const ring = [ringEntry(3, true), ringEntry(4, true)];

    const merged = mergeDurableHistory(file, ring);
    assert.deepEqual(
        merged.map((e) => e.title),
        ["file 1", "file 2", "ring 3", "ring 4"],
    );
});

test("mergeDurableHistory restores the whole file after a reload empties the ring", () => {
    const file = [logged(1), logged(2), logged(3)];
    const merged = mergeDurableHistory(file, []);
    assert.equal(merged.length, 3, "an empty ring means the entire durable history is missing");
});

test("mergeDurableHistory ignores unlogged ring entries when counting the overlap", () => {
    // Dropped or errored entries never reach the file, so they must not be counted as covering
    // any of it — counting them would hide real history.
    const file = [logged(1), logged(2)];
    const ring = [ringEntry(1, false), ringEntry(2, false), ringEntry(3, true), ringEntry(4, true)];

    const merged = mergeDurableHistory(file, ring);
    assert.equal(merged.length, 4, "file is fully covered by the ring's two logged entries");
    assert.equal(merged[0].title, "ring 1");
});

test("mergeDurableHistory returns just the ring when it already covers the file", () => {
    const merged = mergeDurableHistory([logged(1)], [ringEntry(1, true), ringEntry(2, true)]);
    assert.deepEqual(
        merged.map((e) => e.title),
        ["ring 1", "ring 2"],
    );
});

test("mergeDurableHistory bounds its result by serialized size", () => {
    const file = Array.from({ length: 300 }, (_, i) => ({ ...logged(i), detail: "字".repeat(4096) }));
    const merged = mergeDurableHistory(file, []);
    assert.ok(Buffer.byteLength(JSON.stringify(merged), "utf8") <= MAX_PAYLOAD_BYTES);
});

// --- rendering ------------------------------------------------------------------------------

test("escapeHtml neutralises markup", () => {
    assert.equal(escapeHtml(`<script>alert("x")&'`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
});

test("the document escapes its interpolated title", () => {
    const html = renderPanelHtml({ basePath: "/abc/", title: `</title><script>bad()</script>`, nonce: "n1" });
    assert.ok(!html.includes("<script>bad()"), "an injected tag must not survive into the document");
    assert.ok(html.includes("&lt;/title&gt;"));
});

test("the client script carries no template literal that could break out of a host template", () => {
    // The script is embedded in a JS template literal, so a backtick or `${` inside it would end
    // the literal early or interpolate. It is built from single-quoted concatenation for exactly
    // this reason, and this test is what keeps that true.
    const html = renderPanelHtml({ basePath: "/abc/", title: "t", nonce: "n1" });
    const script = html.slice(html.indexOf("<script"), html.lastIndexOf("</script>"));
    assert.ok(!script.includes("`"), "backtick in client script");
    assert.ok(!script.includes("${"), "interpolation in client script");
});

test("the document has no inline event handlers", () => {
    const html = renderPanelHtml({ basePath: "/abc/", title: "t", nonce: "nonce-value" });
    assert.ok(/<style nonce="nonce-value">/.test(html));
    assert.ok(/<script nonce="nonce-value">/.test(html));
    assert.ok(!/\son\w+=/.test(html), "inline event handler attribute");
});

// --- server ---------------------------------------------------------------------------------

/**
 * Speaks HTTP/1.1 over a raw socket.
 *
 * `fetch` cannot be used for these: `Host` is a forbidden header name, so a manually-set one is
 * dropped without error and the rebinding test silently becomes a no-op that always passes.
 *
 * Responses without a Content-Length come back chunk-encoded, so the framing has to be undone
 * here — reading it raw makes an empty body look like `0\r\n\r\n` and JSON bodies unparseable.
 */
function dechunk(body) {
    let rest = body;
    let out = "";
    for (;;) {
        const eol = rest.indexOf("\r\n");
        if (eol === -1) return out + rest;
        const size = Number.parseInt(rest.slice(0, eol), 16);
        if (!Number.isFinite(size)) return out + rest;
        if (size === 0) return out;
        out += rest.slice(eol + 2, eol + 2 + size);
        rest = rest.slice(eol + 2 + size + 2);
    }
}

function request(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
            const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "host") lines[1] = `Host: ${v}`;
                else lines.push(`${k}: ${v}`);
            }
            socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
        });
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (raw += chunk));
        socket.on("error", reject);
        socket.on("close", () => {
            const status = Number.parseInt(raw.slice(9, 12), 10);
            const split = raw.indexOf("\r\n\r\n");
            const head = raw.slice(0, split);
            const body = split === -1 ? "" : raw.slice(split + 4);
            resolve({
                status,
                headers: head,
                body: /transfer-encoding:\s*chunked/i.test(head) ? dechunk(body) : body,
            });
        });
    });
}

function post(port, path) {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
            socket.write(
                `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
            );
        });
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (raw += chunk));
        socket.on("error", reject);
        socket.on("close", () => resolve({ status: Number.parseInt(raw.slice(9, 12), 10) }));
    });
}

async function withServer(run, overrides = {}) {
    const log = createActivityLog();
    const status = { enabled: true, checksRun: 0 };
    const panel = await createPanelServer({
        title: "Advisor activity",
        getSnapshot: () => ({ status, entries: log.list(), historyError: null, historyTruncated: false }),
        getStatus: () => status,
        subscribe: log.subscribe,
        statusIntervalMs: 20,
        onError: () => {},
        ...overrides,
    });
    try {
        await run({ panel, log, status });
    } finally {
        await panel.close();
    }
}

test("server binds loopback and serves the document at its token path", async () => {
    await withServer(async ({ panel }) => {
        assert.ok(panel.url.startsWith("http://127.0.0.1:"), "must not bind a routable interface");
        const res = await request(panel.port, panel.basePath);
        assert.equal(res.status, 200);
        assert.ok(res.body.includes("<!doctype html>") || res.body.includes("<!DOCTYPE html>"));
        assert.ok(res.headers.includes("X-Content-Type-Options: nosniff"));
        assert.ok(res.headers.includes("Referrer-Policy: no-referrer"), "otherwise the token leaks via Referer");
    });
});

test("server rejects a wrong token", async () => {
    await withServer(async ({ panel }) => {
        const res = await request(panel.port, "/0000000000000000000000000000000000000000000000/");
        assert.equal(res.status, 404);
        assert.equal(res.body, "", "a self-explaining 404 is a probing oracle");
    });
});

test("server rejects a token of the wrong length without throwing", async () => {
    // timingSafeEqual throws on a length mismatch, so the length check must come first.
    await withServer(async ({ panel }) => {
        assert.equal((await request(panel.port, "/short/")).status, 404);
    });
});

test("server rejects a rebound Host header", async () => {
    // The DNS rebinding case: an attacker resolves their own name to 127.0.0.1, so the request
    // arrives on loopback but carries their name in Host. Origin does not catch this.
    await withServer(async ({ panel }) => {
        const res = await request(panel.port, panel.basePath, { Host: "attacker.example" });
        assert.equal(res.status, 403);
    });
});

test("server rejects a Host with the right name but the wrong port", async () => {
    await withServer(async ({ panel }) => {
        const res = await request(panel.port, panel.basePath, { Host: "127.0.0.1:1" });
        assert.equal(res.status, 403);
    });
});

test("server rejects a cross-origin request", async () => {
    await withServer(async ({ panel }) => {
        const res = await request(panel.port, `${panel.basePath}state`, { Origin: "https://evil.example" });
        assert.equal(res.status, 403);
    });
});

test("server allows a request with no Origin", async () => {
    // Same-origin GETs and the host's own iframe navigation both send none, so a blanket
    // requirement would reject the only consumer.
    await withServer(async ({ panel }) => {
        assert.equal((await request(panel.port, `${panel.basePath}state`)).status, 200);
    });
});

test("server sends no CORS headers", async () => {
    await withServer(async ({ panel }) => {
        const res = await request(panel.port, `${panel.basePath}state`);
        assert.ok(!res.headers.toLowerCase().includes("access-control-allow"));
    });
});

test("server rejects a non-GET method", async () => {
    await withServer(async ({ panel }) => {
        assert.equal((await post(panel.port, panel.basePath)).status, 405);
    });
});

test("server has no file-read endpoint and does not serve traversal", async () => {
    await withServer(async ({ panel }) => {
        assert.equal((await request(panel.port, `${panel.basePath}../../../etc/passwd`)).status, 404);
        assert.equal((await request(panel.port, `${panel.basePath}panel.mjs`)).status, 404);
    });
});

test("state returns the current snapshot as JSON", async () => {
    await withServer(async ({ panel, log }) => {
        log.push({ tag: "blocker", title: "stop", detail: "a reason" });
        const res = await request(panel.port, `${panel.basePath}state`);
        const body = JSON.parse(res.body);
        assert.equal(body.entries.length, 1);
        assert.equal(body.entries[0].title, "stop");
        assert.equal(body.status.enabled, true);
    });
});

test("state reflects a snapshot re-read rather than a cached copy", async () => {
    let calls = 0;
    await withServer(
        async ({ panel }) => {
            await request(panel.port, `${panel.basePath}state`);
            await request(panel.port, `${panel.basePath}state`);
            assert.equal(calls, 2, "a cached snapshot would not pick up history after a reload");
        },
        {
            getSnapshot: () => {
                calls++;
                return { status: {}, entries: [], historyError: null, historyTruncated: false };
            },
        },
    );
});

/** Opens an SSE stream and collects complete events off the chunked stream. */
function openStream(port, basePath) {
    const state = { events: [], socket: null, raw: "" };
    const ready = new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
            socket.write(`GET ${basePath}events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
        });
        state.socket = socket;
        socket.setEncoding("utf8");
        socket.on("error", reject);
        socket.on("data", (chunk) => {
            state.raw += chunk;
            const parts = state.raw.split("\n\n");
            state.raw = parts.pop();
            for (const part of parts) if (part.includes("event:")) state.events.push(part);
            if (state.raw.includes(": open") || state.events.length) resolve();
        });
        setTimeout(resolve, 500);
    });
    state.ready = ready;
    // Waits for a *matching* event rather than for a count. The status sampler also broadcasts on
    // this stream, so "one event arrived" is satisfied by a status tick and says nothing about
    // the entry under test — a count-based wait here passes for the wrong reason.
    state.waitForEvent = async (match, label) => {
        for (let i = 0; i < 150; i++) {
            const hit = state.events.find(match);
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timed out waiting for ${label}; saw: ${JSON.stringify(state.events)}`);
    };
    return state;
}

test("an open stream receives new entries live", async () => {
    await withServer(async ({ panel, log }) => {
        const stream = openStream(panel.port, panel.basePath);
        await stream.ready;
        assert.equal(panel.clientCount, 1);

        log.push({ tag: "concern", title: "look here" });
        const event = await stream.waitForEvent((e) => e.includes("event: entry"), "an entry event");
        assert.ok(event.includes("look here"));
        stream.socket.destroy();
    });
});

test("refresh broadcasts to every open stream", async () => {
    await withServer(async ({ panel }) => {
        const stream = openStream(panel.port, panel.basePath);
        await stream.ready;

        assert.equal(panel.refresh(), 1);
        await stream.waitForEvent((e) => e.includes("event: refresh"), "a refresh event");
        stream.socket.destroy();
    });
});

test("refresh on a panel with no renderer attached is a no-op that reports zero", async () => {
    await withServer(async ({ panel }) => {
        assert.equal(panel.refresh(), 0);
    });
});

test("close ends every stream and leaves no clients", async () => {
    const log = createActivityLog();
    const panel = await createPanelServer({
        title: "t",
        getSnapshot: () => ({ status: {}, entries: [], historyError: null, historyTruncated: false }),
        getStatus: () => ({}),
        subscribe: log.subscribe,
        statusIntervalMs: 20,
        onError: () => {},
    });
    const stream = openStream(panel.port, panel.basePath);
    await stream.ready;
    assert.equal(panel.clientCount, 1);

    await panel.close();
    assert.equal(panel.clientCount, 0);
    assert.equal(log.listenerCount, 0, "close must unsubscribe or the ring leaks a dead panel");

    // The port is genuinely released, not merely marked closed.
    const after = await request(panel.port, panel.basePath).catch((err) => err);
    assert.ok(after instanceof Error, "server still accepting connections after close");
    stream.socket.destroy();
});

test("a slow reader is skipped rather than disconnected, and is refreshed on drain", async () => {
    // A reader that never drains its socket must not be torn down — destroying it is what turns
    // one stalled client into a reconnect loop — and must not be buffered without limit either.
    const log = createActivityLog();
    const panel = await createPanelServer({
        title: "t",
        getSnapshot: () => ({ status: {}, entries: [], historyError: null, historyTruncated: false }),
        getStatus: () => ({}),
        subscribe: log.subscribe,
        statusIntervalMs: 1000,
        onError: () => {},
    });
    try {
        const stream = openStream(panel.port, panel.basePath);
        await stream.ready;
        stream.socket.pause();

        // Enough volume to fill the socket buffer and make write() return false.
        for (let i = 0; i < 400; i++) log.push({ tag: "concern", title: `entry ${i}`, detail: "x".repeat(4000) });

        assert.equal(panel.clientCount, 1, "a stalled reader must stay connected");

        stream.socket.resume();
        await stream.waitForEvent((e) => e.includes("event:"), "anything after drain");
        stream.socket.destroy();
    } finally {
        await panel.close();
    }
});

test("reopening is the caller's job: two servers get two ports", async () => {
    // The extension keys one server per canvas instance id precisely so this does not happen; the
    // panel module itself has no opinion, and this records that boundary.
    await withServer(async ({ panel: first }) => {
        await withServer(async ({ panel: second }) => {
            assert.notEqual(first.port, second.port);
        });
    });
});

// ---------------------------------------------------------------------------------------------
// Settings: the one write the panel has.

function postJson(port, path, { body = "", headers = {}, host = null } = {}) {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
            const payload = Buffer.from(body, "utf8");
            const lines = [`POST ${path} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`];
            const sent = { "Content-Type": "application/json", ...headers };
            for (const [k, v] of Object.entries(sent)) {
                if (v !== null) lines.push(`${k}: ${v}`);
            }
            lines.push(`Content-Length: ${payload.length}`);
            socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
            socket.write(payload);
        });
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (raw += chunk));
        socket.on("error", reject);
        socket.on("close", () => {
            const status = Number.parseInt(raw.slice(9, 12), 10);
            const split = raw.indexOf("\r\n\r\n");
            const head = raw.slice(0, split);
            const text = split === -1 ? "" : raw.slice(split + 4);
            const decoded = /transfer-encoding:\s*chunked/i.test(head) ? dechunk(text) : text;
            let parsed = null;
            try {
                parsed = JSON.parse(decoded);
            } catch {
                parsed = null;
            }
            resolve({ status, headers: head, body: decoded, json: parsed });
        });
    });
}

const BASELINE = { enabled: true, model: "gpt-5-mini", everyNToolCalls: 6 };

/** A server with a settings route, recording every call that reaches the apply callback. */
async function withSettings(run, reply = (req) => ({ ok: true, applied: [], settings: req.desired })) {
    const calls = [];
    await withServer(
        async ({ panel }) => {
            const send = (body, opts) =>
                postJson(panel.port, `${panel.basePath}settings`, {
                    body: typeof body === "string" ? body : JSON.stringify(body),
                    headers: { Origin: `http://127.0.0.1:${panel.port}`, ...(opts?.headers ?? {}) },
                    host: opts?.host ?? null,
                });
            await run({ panel, calls, send });
        },
        {
            applySettings: (req) => {
                calls.push(req);
                return reply(req);
            },
        },
    );
}

test("a valid settings write reaches the apply callback exactly once", async () => {
    await withSettings(async ({ calls, send }) => {
        const res = await send({ expected: BASELINE, desired: { ...BASELINE, everyNToolCalls: 9 } });
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].expected, BASELINE);
        assert.equal(calls[0].desired.everyNToolCalls, 9);
    });
});

test("the settings response carries no CORS grant", async () => {
    await withSettings(async ({ send }) => {
        const res = await send({ expected: BASELINE, desired: BASELINE });
        assert.ok(!/access-control-allow/i.test(res.headers), "a browser must not be able to read this cross-origin");
        assert.ok(/Cache-Control: no-store/i.test(res.headers));
    });
});

test("a settings write without an Origin is refused", async () => {
    // A same-origin GET legitimately sends none. A write may not: browsers attach Origin to every
    // POST, so its absence means the request did not come from this document.
    await withSettings(async ({ panel, calls }) => {
        const res = await postJson(panel.port, `${panel.basePath}settings`, {
            body: JSON.stringify({ expected: BASELINE, desired: BASELINE }),
        });
        assert.equal(res.status, 403);
        assert.equal(calls.length, 0);
    });
});

test("a settings write from a foreign Origin is refused", async () => {
    await withSettings(async ({ calls, send }) => {
        const res = await send(
            { expected: BASELINE, desired: BASELINE },
            { headers: { Origin: "http://attacker.example" } },
        );
        assert.equal(res.status, 403);
        assert.equal(calls.length, 0);
    });
});

test("a settings write with a rebound Host is refused", async () => {
    await withSettings(async ({ calls, send }) => {
        const res = await send({ expected: BASELINE, desired: BASELINE }, { host: "attacker.example" });
        assert.equal(res.status, 403);
        assert.equal(calls.length, 0);
    });
});

test("a settings write at a wrong token is a 404, not a 403", async () => {
    await withSettings(async ({ panel, calls }) => {
        const res = await postJson(panel.port, "/0000000000000000000000000000000000000000000000/settings", {
            body: JSON.stringify({ expected: BASELINE, desired: BASELINE }),
            headers: { Origin: `http://127.0.0.1:${panel.port}` },
        });
        assert.equal(res.status, 404);
        assert.equal(calls.length, 0);
    });
});

test("a GET on the settings route is refused", async () => {
    await withSettings(async ({ panel, calls }) => {
        assert.equal((await request(panel.port, `${panel.basePath}settings`)).status, 405);
        assert.equal(calls.length, 0);
    });
});

test("a panel with no apply callback has no settings route at all", async () => {
    await withServer(async ({ panel }) => {
        const res = await postJson(panel.port, `${panel.basePath}settings`, {
            body: JSON.stringify({ expected: BASELINE, desired: BASELINE }),
            headers: { Origin: `http://127.0.0.1:${panel.port}` },
        });
        // The same 405 any non-GET gets anywhere on a read-only panel: the route is not declined,
        // it does not exist, and nothing about the answer says which.
        assert.equal(res.status, 405, "a read-only panel must not accept a write");
    });
});

test("a settings write that is not JSON is refused", async () => {
    await withSettings(async ({ calls, send }) => {
        const res = await send({ expected: BASELINE, desired: BASELINE }, { headers: { "Content-Type": "text/plain" } });
        assert.equal(res.status, 415);
        assert.equal(calls.length, 0);
    });
});

test("an oversized settings body is refused before it is parsed", async () => {
    await withSettings(async ({ calls, send }) => {
        const res = await send(JSON.stringify({ expected: BASELINE, desired: BASELINE, pad: "x".repeat(9000) }));
        assert.equal(res.status, 413);
        assert.equal(calls.length, 0);
    });
});

test("a stale baseline is a 409 and the callback decides it, not the transport", async () => {
    await withSettings(
        async ({ calls, send }) => {
            const res = await send({ expected: BASELINE, desired: { ...BASELINE, enabled: false } });
            assert.equal(res.status, 409);
            assert.equal(res.json.ok, false);
            assert.equal(res.json.code, "stale");
            assert.equal(calls.length, 1, "staleness is semantic, so it is the extension's call to make");
        },
        () => ({ ok: false, code: "stale", message: "moved", settings: BASELINE }),
    );
});

test("an apply callback that throws is a 500, not a silent success", async () => {
    await withSettings(
        async ({ send }) => {
            const res = await send({ expected: BASELINE, desired: { ...BASELINE, enabled: false } });
            assert.equal(res.status, 500);
            assert.equal(res.json.ok, false);
        },
        () => {
            throw new Error("boom");
        },
    );
});
test("parseSettingsRequest accepts exactly the three settings and trims the model", () => {
    const { request, error } = parseSettingsRequest(
        JSON.stringify({
            expected: { enabled: true, model: " gpt-5-mini ", everyNToolCalls: 6 },
            desired: { enabled: false, model: "claude-sonnet-5", everyNToolCalls: 1 },
        }),
    );
    assert.equal(error, undefined);
    assert.deepEqual(request.expected, { enabled: true, model: "gpt-5-mini", everyNToolCalls: 6 });
    assert.deepEqual(request.desired, { enabled: false, model: "claude-sonnet-5", everyNToolCalls: 1 });
});

test("parseSettingsRequest rejects what it cannot act on", () => {
    const bad = (body) => parseSettingsRequest(typeof body === "string" ? body : JSON.stringify(body)).error;
    const both = (over) => ({ expected: BASELINE, desired: { ...BASELINE, ...over } });

    assert.match(bad("not json"), /valid JSON/);
    assert.match(bad("[]"), /JSON object/);
    assert.match(bad("null"), /JSON object/);
    assert.match(bad({ desired: BASELINE }), /expected is missing/);
    assert.match(bad({ expected: BASELINE }), /desired is missing/);
    // A field this endpoint does not implement is a caller that thinks it is doing something.
    assert.match(bad({ expected: BASELINE, desired: BASELINE, blockOnBlocker: false }), /not a field/);
    assert.match(bad({ expected: BASELINE, desired: { ...BASELINE, agentType: "x" } }), /not a setting/);
    assert.match(bad({ expected: BASELINE, desired: { enabled: true, model: "m" } }), /everyNToolCalls is missing/);
    assert.match(bad(both({ enabled: "yes" })), /true or false/);
    assert.match(bad(both({ model: 7 })), /must be a string/);
    assert.match(bad(both({ model: "   " })), /must not be empty/);
    assert.match(bad(both({ model: "x".repeat(201) })), /longer than/);
    assert.match(bad(both({ model: "gpt\u0000mini" })), /control character/);
    assert.match(bad(both({ everyNToolCalls: 2.5 })), /whole number/);
    assert.match(bad(both({ everyNToolCalls: "6" })), /whole number/);
    assert.match(bad(both({ everyNToolCalls: 0 })), /between 1 and/);
    assert.match(bad(both({ everyNToolCalls: -1 })), /between 1 and/);
    assert.match(bad(both({ everyNToolCalls: 100000 })), /between 1 and/);
});

test("parseSettingsRequest requires a baseline rather than defaulting one", () => {
    // Without it, a confirmation the user read minutes ago can be applied against values that
    // have since moved, and the change that happens is not the change they approved.
    assert.match(parseSettingsRequest(JSON.stringify({ expected: null, desired: BASELINE })).error, /expected must be/);
});