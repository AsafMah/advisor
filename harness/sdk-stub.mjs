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

// Mirrors the documented `CanvasError(code, message)` shape, including the SDK's own default for
// an action declared without a handler.
export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
    static noHandler() {
        return new CanvasError("no_handler", "action is declared but no handler is wired");
    }
}

// `createCanvas` is the one part of the surface that is not a straight pass-through: the real
// implementation splits the caller's options into a serialisable `declaration` sent to the host
// and the handler closures kept in-process, strips `handler` from the action metadata, and
// reserves the `canvas.` action prefix for lifecycle verbs. A stub returning its input unchanged
// would let a test pass against a shape the host never sees, so the documented transformation is
// reproduced here — and nothing beyond it.
//
// `invokeAction` is the exception: the real SDK dispatches `canvas.action.invoke` to the bound
// closure without exposing it on `Canvas`, so the harness needs a stand-in for that dispatch or
// no test can reach an action handler at all. It is named for what it models, not for the map it
// holds, so a test cannot quietly start asserting against the stub's bookkeeping.
export function createCanvas(options) {
    if (!options?.id) throw new CanvasError("invalid_canvas", "canvas id is required");
    if (!options.displayName) throw new CanvasError("invalid_canvas", `canvas ${options.id} requires a displayName`);
    if (!options.description) throw new CanvasError("invalid_canvas", `canvas ${options.id} requires a description`);
    if (typeof options.open !== "function") {
        throw new CanvasError("invalid_canvas", `canvas ${options.id} requires an open handler`);
    }

    const actions = options.actions ?? [];
    const handlers = new Map();
    for (const action of actions) {
        if (!action?.name) throw new CanvasError("invalid_action", `canvas ${options.id} has an action with no name`);
        if (action.name.startsWith("canvas.")) {
            throw new CanvasError(
                "invalid_action",
                `canvas ${options.id} action "${action.name}" uses the reserved canvas. prefix`,
            );
        }
        if (typeof action.handler !== "function") throw CanvasError.noHandler();
        handlers.set(action.name, action.handler);
    }

    return {
        declaration: {
            id: options.id,
            displayName: options.displayName,
            description: options.description,
            ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
            actions: actions.map(({ handler, ...metadata }) => metadata),
        },
        open: options.open,
        onClose: options.onClose,
        invokeAction(name, ctx) {
            const handler = handlers.get(name);
            if (!handler) throw CanvasError.noHandler();
            return handler(ctx);
        },
    };
}
