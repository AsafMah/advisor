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
    const status = {
        enabled: true,
        model: "gpt-5.6-terra",
        agentType: "general-purpose",
        everyNToolCalls: 6,
        currentInterval: 6,
        blockOnBlocker: true,
        checksRun: 3,
        adviceDelivered: 1,
        toolCallsSinceCheck: 2,
        checkInFlight: false,
        pendingAdvice: null,
        lastError: null,
    };
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
                const metas = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries .entry-meta')).map(e => e.textContent)",
                );
                assert.ok(metas.length >= 2, `expected rendered entries, got ${JSON.stringify(metas)}`);
                assert.ok(metas.some((t) => t.includes("first finding")));
                // Newest first, matching the reference panel.
                assert.ok(metas[0].includes("second finding"), `unexpected order: ${JSON.stringify(metas)}`);
                const phase = await browser.evaluate("document.querySelector('#phase').textContent");
                assert.equal(phase, "Watching");
                const count = await browser.evaluate("document.querySelector('#count').textContent");
                assert.equal(count, "2 of 2");
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
                const before = await browser.evaluate("document.querySelectorAll('#entries li').length");
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
                const before = await browser.evaluate("document.querySelectorAll('#entries li').length");
                assert.equal(before, 2);
                // The filter is re-rendered rather than hidden with CSS, so an excluded entry
                // leaves the document entirely — asserting on visibility would measure nothing.
                await browser.evaluate("document.querySelector('input[data-tag=\"blocker\"]').click(); true");
                await delay(200);
                const after = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries li')).map(e => e.dataset.kind)",
                );
                assert.deepEqual(after, ["nit"], "the filter did not remove exactly the blocker");
                const count = await browser.evaluate("document.querySelector('#count').textContent");
                assert.equal(count, "1 of 2");
            },
            [
                { tag: "blocker", title: "a blocker", detail: "" },
                { tag: "nit", title: "a nit", detail: "" },
            ],
        );
    });

    test("two tags can be watched at once", async () => {
        // The point of checkboxes over a dropdown: several severities at the same time. A
        // single-selection control would make this impossible, so this is the regression that
        // keeps it from quietly becoming one again.
        await withRenderedPanel(
            async ({ browser }) => {
                await browser.evaluate(
                    "for (const b of document.querySelectorAll('input[data-tag]')) {" +
                        " if (b.dataset.tag !== 'blocker' && b.dataset.tag !== 'concern') { b.click(); } } true",
                );
                await delay(200);
                const kinds = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries li')).map(e => e.dataset.kind)",
                );
                assert.deepEqual(kinds, ["concern", "blocker"], "both selected tags must remain visible");
                assert.equal(await browser.evaluate("document.querySelector('#count').textContent"), "2 of 4");

                // Re-checking restores the entry it had removed, rather than being one-way.
                await browser.evaluate("document.querySelector('input[data-tag=\"nit\"]').click(); true");
                await delay(200);
                assert.equal(await browser.evaluate("document.querySelector('#count').textContent"), "3 of 4");
            },
            [
                { tag: "review", title: "a review", detail: "" },
                { tag: "nit", title: "a nit", detail: "" },
                { tag: "blocker", title: "a blocker", detail: "" },
                { tag: "concern", title: "a concern", detail: "" },
            ],
        );
    });

    test("clearing every tag empties the feed and says so", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                await browser.evaluate("document.querySelectorAll('input[data-tag]').forEach(b => b.click()); true");
                await delay(200);
                assert.equal(await browser.evaluate("document.querySelectorAll('#entries li').length"), 0);
                assert.equal(await browser.evaluate("document.querySelector('#count').textContent"), "0 of 2");
                const empty = await browser.evaluate(
                    "(() => { const e = document.querySelector('#empty'); return e.hidden ? null : e.textContent; })()",
                );
                // "No matching activity" and "nothing recorded yet" are different facts, and a
                // panel that confuses them tells the user the advisor did nothing.
                assert.equal(empty, "No matching activity.");
            },
            [
                { tag: "blocker", title: "a blocker", detail: "" },
                { tag: "nit", title: "a nit", detail: "" },
            ],
        );
    });

    test("search composes with the selected tags rather than replacing them", async () => {
        await withRenderedPanel(
            async ({ browser }) => {
                await browser.evaluate("document.querySelector('input[data-tag=\"nit\"]').click(); true");
                await browser.evaluate(
                    "(() => { const i = document.querySelector('#search');" +
                        "i.value = 'haystack'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
                );
                await delay(200);
                // Only the blocker matches both halves: the nit is deselected and the concern
                // does not match the text. Either filter alone would show two rows.
                const texts = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries .entry-message')).map(e => e.textContent)",
                );
                assert.deepEqual(texts, ["a haystack blocker"]);
                assert.equal(await browser.evaluate("document.querySelector('#count').textContent"), "1 of 3");

                // Clearing the text restores the tag selection rather than the whole feed.
                await browser.evaluate(
                    "(() => { const i = document.querySelector('#search');" +
                        "i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
                );
                await delay(200);
                const kinds = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries li')).map(e => e.dataset.kind)",
                );
                assert.deepEqual(kinds, ["concern", "blocker"]);
            },
            [
                { tag: "blocker", title: "a blocker", detail: "a haystack blocker" },
                { tag: "nit", title: "a nit", detail: "a haystack nit" },
                { tag: "concern", title: "a concern", detail: "unrelated" },
            ],
        );
    });

    for (const scheme of ["light", "dark"]) {
        test(`the panel is usable at a narrow panel width in ${scheme} mode`, async () => {
            await withRenderedPanel(
                async ({ browser }) => {
                    await browser.send("Emulation.setEmulatedMedia", {
                        features: [{ name: "prefers-color-scheme", value: scheme }],
                    });
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
                    // A restyle that leaves text the same colour as its background renders a
                    // blank panel while every structural assertion above still passes.
                    const contrast = await browser.evaluate(
                        "(() => { const s = getComputedStyle(document.body);" +
                            " return s.color !== s.backgroundColor; })()",
                    );
                    assert.equal(contrast, true, "body text and background resolved to the same colour");
                },
                [
                    {
                        tag: "blocker",
                        title: "a fairly long finding title that has to wrap somewhere",
                        detail: "x".repeat(400),
                    },
                ],
            );
        });
    }
}
