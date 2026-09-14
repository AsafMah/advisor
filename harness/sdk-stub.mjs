// Stands in for `@github/copilot-sdk/extension`. The real module cannot be imported here — the
// host supplies it — so the registration surface is reproduced instead: one `joinSession` export
// that the extension awaits at top level.
//
// This deliberately does nothing but hand the options object to whatever the test installed. The
// point of the harness is that the *extension* decides what to register; the stub must not have
// an opinion about it, or the test starts asserting against the stub's idea of the contract
// rather than the extension's.

export async function joinSession(options) {
    const install = globalThis.__ADVISOR_JOIN_SESSION__;
    if (typeof install !== "function") {
        throw new Error("harness not installed: set globalThis.__ADVISOR_JOIN_SESSION__ before importing extension.mjs");
    }
    return install(options);
}
