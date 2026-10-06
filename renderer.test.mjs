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

async function withRenderedPanel(run, entries = [], options = {}) {
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
    // Stands in for the extension's own apply: the same contract, over a status object the test
    // can read afterwards to see whether the write actually happened.
    const applied = [];
    const settingsOf = () => ({
        enabled: status.enabled,
        model: status.model,
        everyNToolCalls: status.everyNToolCalls,
    });
    const applySettings =
        options.applySettings ??
        ((req) => {
            applied.push(req);
            const current = settingsOf();
            const drifted = Object.keys(current).filter((k) => req.expected[k] !== current[k]);
            if (drifted.length > 0) {
                return { ok: false, code: "stale", message: `changed elsewhere (${drifted.join(", ")})`, settings: current, status };
            }
            const changed = Object.keys(current).filter((k) => req.desired[k] !== current[k]);
            Object.assign(status, req.desired);
            status.currentInterval = status.everyNToolCalls;
            return { ok: true, applied: changed, settings: settingsOf(), status };
        });
    const panel = await createPanelServer({
        title: "Advisor activity",
        getSnapshot: () => ({ status, entries: log.list(), historyError: null, historyTruncated: false }),
        getStatus: () => status,
        subscribe: log.subscribe,
        applySettings,
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
        await run({ browser, panel, log, status, applied, settingsOf });
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

    test("a dated row shows its date, and an undated one says the date is missing", async () => {
        // The reported failure: a blocker from eight days earlier rendered as `11:00:02` and was
        // read as current. Both eras of entry are on screen here at once, so neither can be
        // mistaken for the other.
        const iso = "2026-09-14T08:00:02.975Z";
        await withRenderedPanel(
            async ({ browser }) => {
                const metas = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries .entry-meta')).map(e => e.textContent)",
                );
                const dated = metas.find((t) => t.includes("dated entry"));
                const legacy = metas.find((t) => t.includes("legacy entry"));

                const year = String(new Date(iso).getFullYear());
                assert.ok(dated.includes(year), `the stored instant lost its date: ${JSON.stringify(dated)}`);
                assert.ok(!dated.includes("date unavailable"), "a dated entry must not be labelled undated");

                assert.ok(legacy.includes("11:00:02"), "the recorded time must survive");
                assert.ok(
                    legacy.includes("date unavailable"),
                    `an undated entry must say so: ${JSON.stringify(legacy)}`,
                );
                const today = new Date().toLocaleDateString();
                assert.ok(!legacy.includes(today), "an undated entry must not borrow today's date");
            },
            [
                { tag: "blocker", title: "legacy entry", detail: "old", at: null, time: "11:00:02" },
                { tag: "concern", title: "dated entry", detail: "new", at: iso },
            ],
        );
    });

    test("rows either side of local midnight read as different days", async () => {
        // Time-only labels show 23:59:30 and 00:00:30 and hide the day boundary between them.
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const stamp = (offsetMs) => new Date(midnight.getTime() + offsetMs).toISOString();
        await withRenderedPanel(
            async ({ browser }) => {
                const metas = await browser.evaluate(
                    "Array.from(document.querySelectorAll('#entries .entry-meta')).map(e => e.textContent)",
                );
                const when = (title) => {
                    const row = metas.find((t) => t.includes(title));
                    return row.slice(row.lastIndexOf("|") + 1).trim();
                };
                assert.notEqual(when("before midnight"), when("after midnight"));
                // Not merely different — different in the date, not just the clock.
                const dayOf = (text) => text.replace(/\d{1,2}:\d{2}:\d{2}.*$/, "").trim();
                assert.notEqual(
                    dayOf(when("before midnight")),
                    dayOf(when("after midnight")),
                    "the day has to change, not only the time",
                );
            },
            [
                { tag: "nit", title: "before midnight", detail: "", at: stamp(-30000) },
                { tag: "nit", title: "after midnight", detail: "", at: stamp(30000) },
            ],
        );
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

    // --- settings -----------------------------------------------------------------------------

    const edit = (field, value) =>
        "(() => { const n = document.getElementById('set-" +
        field +
        "'); " +
        (field === "enabled" ? "n.checked = " : "n.value = ") +
        JSON.stringify(value) +
        "; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";

    const click = (id) => "(() => { document.getElementById('" + id + "').click(); return true; })()";
    const text = (id) => "document.getElementById('" + id + "').textContent";
    const hidden = (id) => "document.getElementById('" + id + "').hidden";

    // `.click()` dispatches straight at the node, so it passes whether or not the button is
    // reachable. This drives the pointer at real coordinates and returns whatever the browser
    // actually hit there, which is the only way a test can tell a working button from a covered,
    // scrolled-away or zero-sized one.
    async function realClick(browser, id) {
        const box = JSON.parse(
            await browser.evaluate(
                "(() => { const n = document.getElementById('" +
                    id +
                    "'); n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect();" +
                    " const x = r.x + r.width / 2, y = r.y + r.height / 2;" +
                    " const at = document.elementFromPoint(x, y);" +
                    " return JSON.stringify({ x: x, y: y, hit: at ? at.id : null }); })()",
            ),
        );
        for (const type of ["mousePressed", "mouseReleased"]) {
            await browser.send("Input.dispatchMouseEvent", {
                type,
                x: box.x,
                y: box.y,
                button: "left",
                clickCount: 1,
                buttons: type === "mousePressed" ? 1 : 0,
            });
        }
        return box.hit;
    }

    test("the settings form seeds from the advisor and hides its controls until edited", async () => {
        await withRenderedPanel(async ({ browser }) => {
            assert.equal(await browser.evaluate("document.getElementById('set-enabled').checked"), true);
            assert.equal(await browser.evaluate("document.getElementById('set-model').value"), "gpt-5.6-terra");
            assert.equal(await browser.evaluate("document.getElementById('set-cadence').value"), "6");
            assert.equal(await browser.evaluate(hidden("settings-actions")), true, "an untouched form offers nothing");
        });
    });

    test("editing previews the exact change and sends nothing", async () => {
        await withRenderedPanel(async ({ browser, applied, settingsOf }) => {
            await browser.evaluate(edit("cadence", "9"));
            await delay(100);
            assert.equal(await browser.evaluate(hidden("settings-actions")), false);
            assert.equal(await browser.evaluate(hidden("settings-preview")), false, "the change is shown without a click");

            const lines = await browser.evaluate(
                "Array.from(document.querySelectorAll('#settings-diff li')).map(e => e.textContent)",
            );
            assert.deepEqual(lines, ["Review cadence: every 6 tool calls \u2192 every 9 tool calls"]);
            assert.equal(applied.length, 0, "previewing must not reach the extension");
            assert.equal(settingsOf().everyNToolCalls, 6);
        });
    });

    test("the preview follows every edit rather than freezing at the first", async () => {
        await withRenderedPanel(async ({ browser, applied }) => {
            await browser.evaluate(edit("cadence", "9"));
            await delay(60);
            await browser.evaluate(edit("model", "claude-opus-5"));
            await delay(100);

            const lines = await browser.evaluate(
                "Array.from(document.querySelectorAll('#settings-diff li')).map(e => e.textContent)",
            );
            assert.deepEqual(lines, [
                "Model: gpt-5.6-terra \u2192 claude-opus-5",
                "Review cadence: every 6 tool calls \u2192 every 9 tool calls",
            ]);

            // Back to the advisor's own value: there is nothing left to apply, so nothing is offered.
            await browser.evaluate(edit("cadence", "6"));
            await browser.evaluate(edit("model", "gpt-5.6-terra"));
            await delay(100);
            assert.equal(await browser.evaluate(hidden("settings-preview")), true);
            assert.equal(await browser.evaluate(hidden("settings-actions")), true);
            assert.equal(applied.length, 0);
        });
    });

    // The defect this replaces: a review could be invalidated by any later edit, after which the
    // Apply button returned before doing anything at all — no request, no message, nothing to see.
    // `.click()` cannot catch that class on its own because it skips hit-testing, so this drives
    // the real pointer at the real coordinates and asserts what the user would have seen.
    test("Apply posts after an edit that follows an edit, and is really clickable", async () => {
        await withRenderedPanel(async ({ browser, applied, settingsOf }) => {
            await browser.evaluate(edit("cadence", "9"));
            await delay(60);
            await browser.evaluate(edit("enabled", false));
            await delay(60);
            await browser.evaluate(edit("cadence", "11"));
            await delay(100);

            const hit = await realClick(browser, "settings-apply");
            assert.equal(hit, "settings-apply", "the Apply button must be where the user clicks");
            await delay(400);

            assert.equal(applied.length, 1, "one press, one write");
            assert.deepEqual(settingsOf(), { enabled: false, model: "gpt-5.6-terra", everyNToolCalls: 11 });
            assert.match(await browser.evaluate(text("settings-result")), /Applied:/);
        });
    });

    test("resetting discards the edit without sending anything", async () => {
        await withRenderedPanel(async ({ browser, applied }) => {
            await browser.evaluate(edit("cadence", "12"));
            await browser.evaluate(click("settings-reset"));
            await delay(100);

            assert.equal(applied.length, 0);
            assert.equal(await browser.evaluate("document.getElementById('set-cadence').value"), "6");
            assert.equal(await browser.evaluate(hidden("settings-actions")), true);
            assert.equal(await browser.evaluate(hidden("settings-preview")), true);
        });
    });

    test("applying sends one request and reports what landed", async () => {
        await withRenderedPanel(async ({ browser, applied, settingsOf }) => {
            await browser.evaluate(edit("cadence", "9"));
            await browser.evaluate(edit("enabled", false));
            await browser.evaluate(click("settings-apply"));
            await delay(400);

            assert.equal(applied.length, 1, "exactly one write per Apply");
            assert.deepEqual(applied[0].desired, { enabled: false, model: "gpt-5.6-terra", everyNToolCalls: 9 });
            assert.deepEqual(settingsOf(), { enabled: false, model: "gpt-5.6-terra", everyNToolCalls: 9 });
            assert.match(await browser.evaluate(text("settings-result")), /Applied:/);
            assert.equal(await browser.evaluate(hidden("settings-actions")), true, "a landed change is no longer dirty");
            assert.equal(await browser.evaluate(text("phase")), "Disabled", "and the status must follow");
        });
    });

    // Silence is what made the old button look broken, so no press may end without a line of text.
    test("every press of Apply says what happened, including when it did nothing", async () => {
        await withRenderedPanel(async ({ browser, applied }) => {
            // Dirty, but back at the advisor's own values: the press is real and must answer.
            await browser.evaluate(edit("cadence", "9"));
            await browser.evaluate(edit("cadence", "6"));
            await browser.evaluate(click("settings-apply"));
            await delay(200);
            assert.match(await browser.evaluate(text("settings-result")), /Nothing to change/i);
            assert.equal(applied.length, 0);

            await browser.evaluate(edit("cadence", "0"));
            await browser.evaluate(click("settings-apply"));
            await delay(200);
            assert.match(await browser.evaluate(text("settings-result")), /Not applied \u2014 Review cadence/);
            assert.equal(applied.length, 0, "an invalid value is refused here, not sent");

            await browser.evaluate(edit("model", "   "));
            await browser.evaluate(click("settings-apply"));
            await delay(200);
            assert.match(await browser.evaluate(text("settings-result")), /Not applied \u2014 Model/);
            assert.equal(applied.length, 0);
        });
    });

    test("a refused change says so and leaves the form alone", async () => {
        await withRenderedPanel(
            async ({ browser, settingsOf }) => {
                await browser.evaluate(edit("cadence", "9"));
                await browser.evaluate(click("settings-apply"));
                await delay(400);

                assert.match(await browser.evaluate(text("settings-result")), /Not applied/);
                assert.match(await browser.evaluate(text("settings-result")), /somebody else/);
                assert.equal(settingsOf().everyNToolCalls, 6);
                assert.equal(await browser.evaluate("document.getElementById('set-cadence').value"), "9");
                assert.equal(await browser.evaluate(hidden("settings-actions")), false, "the edit is still there to retry");
            },
            [],
            {
                applySettings: () => ({
                    ok: false,
                    code: "stale",
                    message: "somebody else moved it",
                    settings: { enabled: true, model: "gpt-5.6-terra", everyNToolCalls: 6 },
                }),
            },
        );
    });

    test("a change made elsewhere while editing is surfaced, not silently merged", async () => {
        await withRenderedPanel(async ({ browser, status }) => {
            await browser.evaluate(edit("model", "claude-opus-5"));
            // The advisor moves underneath the open form; the status poll carries it in.
            status.everyNToolCalls = 20;
            status.currentInterval = 20;
            await delay(700);

            assert.equal(
                await browser.evaluate("document.getElementById('set-model').value"),
                "claude-opus-5",
                "a live update must not overwrite what the user is typing",
            );
            assert.equal(await browser.evaluate(hidden("settings-note")), false);
            assert.match(await browser.evaluate(text("settings-note")), /changed elsewhere/i);
        });
    });

    test("an untouched form follows the advisor", async () => {
        await withRenderedPanel(async ({ browser, status }) => {
            status.everyNToolCalls = 20;
            status.currentInterval = 20;
            await delay(700);

            assert.equal(await browser.evaluate("document.getElementById('set-cadence').value"), "20");
            assert.equal(await browser.evaluate(hidden("settings-note")), true);
        });
    });

    test("a lost response locks the form rather than claiming nothing happened", async () => {
        // The write reaches the extension and lands; only the answer is lost. Saying "not
        // applied" there would be a guess, and letting Reset redraw the pre-write values would
        // dress that guess up as the current state.
        await withRenderedPanel(async ({ browser, applied, settingsOf }) => {
            await browser.evaluate(
                "(() => { const real = window.fetch.bind(window); window.__realFetch = real;" +
                    " window.fetch = async (...a) => { const r = await real(...a);" +
                    " if (String(a[0]).endsWith('settings')) { await r.text(); throw new TypeError('connection lost'); } return r; }; return true; })()",
            );
            await browser.evaluate(edit("cadence", "9"));
            await browser.evaluate(click("settings-apply"));
            await delay(400);

            assert.equal(applied.length, 1, "the write really did reach the extension");
            assert.equal(settingsOf().everyNToolCalls, 9, "and really did land");
            assert.match(await browser.evaluate(text("settings-result")), /Outcome unknown/);
            assert.equal(await browser.evaluate("document.getElementById('set-cadence').disabled"), true);
            assert.equal(await browser.evaluate("document.getElementById('settings-apply').disabled"), true);

            // Reset must not overwrite the uncertainty with a comforting claim, and a locked
            // Apply must not resubmit on top of a change that may already have happened.
            await browser.evaluate(click("settings-reset"));
            await browser.evaluate(click("settings-apply"));
            await delay(200);
            assert.match(await browser.evaluate(text("settings-result")), /Outcome unknown/);
            assert.equal(applied.length, 1, "a locked form must not resubmit");

            // Only reading the real state resolves it; `fetch` is an own property of the global
            // here, so restore the saved original rather than deleting the override.
            await browser.evaluate("(() => { window.fetch = window.__realFetch; return true; })()");
            await browser.evaluate(click("refresh"));
            await delay(500);

            assert.match(await browser.evaluate(text("settings-result")), /Reloaded/);
            assert.equal(await browser.evaluate("document.getElementById('set-cadence').disabled"), false);
            assert.equal(await browser.evaluate("document.getElementById('set-cadence').value"), "9");
        });
    });
}