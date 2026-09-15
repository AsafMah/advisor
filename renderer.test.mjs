// Renders the panel in a real headless browser and reads the resulting DOM.
//
// Every other test in this repo proves the server returned the right bytes. None of them prove a
// browser executes them: a CSP that blocks the panel's own script, a renderer that throws on
// first paint, or an SSE stream the browser refuses would all pass an HTTP-level assertion and
// show the user an empty panel. This is the only check that the thing actually renders.
//
// Skipped, not failed, where Edge is absent — this is evidence when it can be gathered, and a
// machine without a browser is not a defect in the panel.

import { test, skip } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createActivityLog, createPanelServer } from "./panel.mjs";

const EDGE = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts headless Edge and connects to its DevTools endpoint. */
async function launchBrowser() {
    const profile = mkdtempSync(join(tmpdir(), "advisor-cdp-"));
    const proc = spawn(
        EDGE,
        [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "about:blank",
        ],
        { stdio: "ignore" },
    );

    const portFile = join(profile, "DevToolsActivePort");
    let port = null;
    for (let i = 0; i < 100 && port === null; i++) {
        await delay(100);
        if (!existsSync(portFile)) continue;
        const parsed = Number.parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10);
        if (Number.isFinite(parsed)) port = parsed;
    }
    if (port === null) {
        proc.kill();
        throw new Error("Edge never reported a DevTools port");
    }

    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
    });

    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const msgId = ++id;
            pending.set(msgId, { resolve, reject });
            ws.send(JSON.stringify({ id: msgId, method, params }));
        });

    return {
        send,
        async goto(url) {
            await send("Page.enable");
            await send("Page.navigate", { url });
            // No load event to await over raw CDP without more plumbing than this is worth; the
            // panel fetches its state after DOMContentLoaded, so poll the result instead.
            await delay(600);
        },
        async evaluate(expression) {
            const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        },
        async close() {
            try {
                ws.close();
            } catch {
                // Already gone.
            }
            // `proc.kill()` alone leaves Edge's renderer and GPU children running. They are
            // spawned children of this process's child, so Node keeps its event loop alive
            // waiting for them and the test run never exits — measured here as a run that
            // passed every assertion and then hung indefinitely. Kill the tree by pid.
            await new Promise((resolve) => {
                const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
                killer.on("exit", resolve);
                killer.on("error", resolve);
            });
            await new Promise((resolve) => (proc.exitCode === null ? proc.once("exit", resolve) : resolve()));
            rmSync(profile, { recursive: true, force: true });
        },
    };
}

async function withRenderedPanel(run, entries = []) {
    const log = createActivityLog();
    for (const entry of entries) log.push(entry);
    const status = { enabled: true, model: "gpt-5.6-terra", checksRun: 3, pendingAdvice: null };
    const panel = await createPanelServer({
        title: "Advisor activity",
        getSnapshot: () => ({ status, entries: log.list(), historyError: null, historyTruncated: false }),
        getStatus: () => status,
        subscribe: log.subscribe,
        statusIntervalMs: 200,
        onError: () => {},
    });
    const browser = await launchBrowser();
    try {
        await browser.goto(panel.url);
        // The document is served before its first snapshot has been fetched, so every assertion
        // below would otherwise race the client's own `load()`.
        const deadline = Date.now() + 10000;
        for (;;) {
            if (await browser.evaluate("window.__advisorPanelReady === true")) break;
            if (Date.now() > deadline) throw new Error("the panel never finished its first render");
            await delay(50);
        }
        await run({ browser, panel, log });
    } finally {
        await browser.close();
        await panel.close();
    }
}

if (!EDGE) {
    skip("headless renderer checks need Microsoft Edge, which is not installed here");
} else {
    test("the panel renders its entries in a real browser", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                const titles = await browser.evaluate(
                    "Array.from(document.querySelectorAll('.entry .title')).map(e => e.textContent)",
                );
                assert.ok(titles.length >= 2, `expected rendered entries, got ${JSON.stringify(titles)}`);
                assert.ok(titles.some((t) => t.includes("first finding")));
            },
            [
                { tag: "blocker", title: "first finding", detail: "do not ship" },
                { tag: "nit", title: "second finding", detail: "minor" },
            ],
        );
    });

    test("no script was blocked and the page threw nothing", async () => {
        // A CSP that blocks the panel's own nonce'd script is invisible to an HTTP assertion and
        // fatal to the user.
        await withRenderedPanel(async ({ browser }) => {
            const ready = await browser.evaluate("document.querySelector('#entries') !== null");
            assert.equal(ready, true);
            const scriptRan = await browser.evaluate("typeof window.__advisorPanelReady");
            assert.notEqual(scriptRan, "undefined", "the client script never executed");
        });
    });

    test("markup in an advice note renders as text, not as markup", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                const injected = await browser.evaluate("document.querySelectorAll('#entries img').length");
                assert.equal(injected, 0, "an advice note created an element");
                const text = await browser.evaluate("document.querySelector('#entries').textContent");
                assert.ok(text.includes("<img"), "the note should be visible as literal text");
            },
            [{ tag: "concern", title: "<img src=x onerror=alert(1)>", detail: "<script>alert(2)</script>" }],
        );
    });

    test("a live entry appears without a reload", async () => {
        await withRenderedPanel(
            async ({ browser, log }) => {
                const before = await browser.evaluate("document.querySelectorAll('.entry').length");
                log.push({ tag: "blocker", title: "arrived while open", detail: "live" });
                await delay(700);
                const after = await browser.evaluate(
                    "document.querySelector('#entries').textContent.includes('arrived while open')",
                );
                assert.equal(after, true, `entry never reached the open panel (started with ${before})`);
            },
            [{ tag: "nit", title: "existing", detail: "" }],
        );
    });

    test("filtering removes the entries it excludes", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                const before = await browser.evaluate("document.querySelectorAll('.entry').length");
                assert.equal(before, 2);
                // The filter is re-rendered rather than hidden with CSS, so an excluded entry
                // leaves the document entirely — asserting on visibility would measure nothing.
                await browser.evaluate("document.querySelector('input[data-tag=\"blocker\"]').click(); true");
                await delay(200);
                const after = await browser.evaluate(
                    "Array.from(document.querySelectorAll('.entry')).map(e => e.dataset.tag)",
                );
                assert.deepEqual(after, ["nit"], "the filter did not remove exactly the blocker");
            },
            [
                { tag: "blocker", title: "a blocker", detail: "" },
                { tag: "nit", title: "a nit", detail: "" },
            ],
        );
    });

    test("the panel is usable at a narrow panel width", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                await browser.send("Emulation.setDeviceMetricsOverride", {
                    width: 320,
                    height: 800,
                    deviceScaleFactor: 1,
                    mobile: false,
                });
                await delay(200);
                const overflow = await browser.evaluate(
                    "document.documentElement.scrollWidth > document.documentElement.clientWidth + 2",
                );
                assert.equal(overflow, false, "the panel overflows horizontally at 320px");
            },
            [{ tag: "blocker", title: "a fairly long finding title that has to wrap somewhere", detail: "x".repeat(400) }],
        );
    });
}
