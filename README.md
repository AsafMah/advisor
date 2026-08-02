# advisor

An independent reviewer model that watches the main Copilot agent work and intervenes when it
drifts, forgets a requirement, or is about to do something wrong.

Inspired by [oh-my-pi](https://github.com/)'s `WATCHDOG` advisor, reimplemented as a GitHub
Copilot CLI extension.

## How it works

```
main agent runs tools
        │
        ├─ onPostToolUse ──► counter++
        │                       │
        │                       └─ every N tool calls ─► spawn advisor sub-agent
        │                                                 (own model, own context)
        │                                                        │
        │                                                        ▼
        │                                            {"severity":…, "note":…}
        │                                                        │
        └─ onPreToolUse ◄──────── pending advice ◄───────────────┘
                │
                ├─ nit / concern ─► injected as hidden context
                └─ blocker ───────► tool call DENIED with the advisor's reason
```

Every `everyNToolCalls` tool calls, the extension snapshots what has happened since the last
review and hands it to a **separate sub-agent** running its own model. That agent returns a
severity and a note. The advice is then delivered on the main agent's *next* tool call:

| Severity  | Effect                                                            |
| --------- | ----------------------------------------------------------------- |
| `none`    | Nothing happens.                                                  |
| `nit`     | Injected as hidden context alongside the tool call.               |
| `concern` | Injected as hidden context.                                       |
| `blocker` | The tool call is **denied**, with the advisor's note as the reason. |

Denying is this runtime's closest equivalent to oh-my-pi's steering channel: the main agent
cannot proceed with that action and must react to the note.

## Install

The extension lives in this repo and is linked into the Copilot CLI extensions directory:

```powershell
New-Item -ItemType Junction `
    -Path "$env:USERPROFILE\.copilot\extensions\advisor" `
    -Target "G:\copilot-plugins\advisor"
```

Then reload from inside a session:

```
/extensions reload
```

## Configuration

Config is read from the first of these that exists:

1. `$COPILOT_ADVISOR_CONFIG`
2. `<cwd>/.github/advisor.json`
3. `~/.copilot/advisor.json`
4. built-in defaults

See `advisor.example.json`. Keys:

| Key                   | Default          | Meaning                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `enabled`             | `true`           | Master switch.                                                          |
| `model`               | `gpt-5.6-terra`  | Model the advisor runs on. Independent of the main agent's model.        |
| `agentType`           | `rubber-duck`    | Built-in agent type to spawn.                                            |
| `everyNToolCalls`     | `12`             | Review cadence.                                                          |
| `immuneToolCalls`     | `4`              | No reviews until this many tool calls into a turn.                       |
| `blockOnBlocker`      | `true`           | Whether `blocker` denies the tool call, or just injects context.         |
| `minSeverityToInject` | `nit`            | Drop advice below this severity.                                         |
| `maxTranscriptChars`  | `24000`          | Cap on the transcript slice sent to the advisor.                         |
| `maxToolResultChars`  | `1200`           | Per-tool-result truncation inside the transcript.                        |
| `timeoutMs`           | `180000`         | How long to wait for the advisor sub-agent.                              |
| `logToTimeline`       | `true`           | Surface advice in the session timeline so you can see it too.            |
| `debugLog`            | `~/.copilot/logs/advisor.log` | Trace file for the review loop. Set to `null` to disable. |
| `instructions`        | `""`             | Extra project-specific review instructions appended to the prompt.       |

## Commands

| Command                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `/advisor`              | Status: cadence, counters, last error.     |
| `/advisor-check`        | Force a review right now.                  |
| `/advisor-on`           | Enable for this session.                   |
| `/advisor-off`          | Disable for this session.                  |
| `/advisor-model <id>`   | Override the advisor model for the session. |
| `/advisor-every <n>`    | Override the cadence for the session.       |
| `/advisor-reload`       | Re-read `advisor.json` from disk.           |

Session overrides are in-memory and reset when extensions reload.

## Design notes

- **Non-blocking.** The review runs as a detached background task; the main agent never waits.
  Advice lands on the next tool call after the advisor finishes.
- **Reply recovery.** `tasks.list()` reports the sub-agent as `idle` but leaves `result` null
  permanently, and the `toolCallId` it reports for an RPC-started agent is a stub (the agent
  name), not a real tool call id. The reply is therefore recovered from the session event log:
  the extension records the event count before starting, finds the `subagent.started` event
  after that baseline, and reads the last `assistant.message` carrying the same internal
  `agentId` (`bg-…`) once `subagent.completed` appears.
- **Untrusted output.** The advisor's note ends up in the main agent's context, so it is
  stripped of control characters and tag-like text, checked for instruction-override phrasing,
  and capped at 800 characters. It is wrapped in an `<advisor>` block that tells the main agent
  the source is fallible.
- **Emission guard.** One piece of advice per review, identical consecutive notes are dropped,
  and no new review starts while one is in flight or while advice is still pending.
- **Incremental transcript.** Each review sees only what happened since the previous one, plus
  the user's original goal.
- **Self-cleanup.** A sub-agent parks in `idle` forever and would accumulate in the task list,
  so each review's task is cancelled and removed once its reply has been read.

## Known limitations

- The RPC surface for starting a sub-agent accepts a `model` but no reasoning-effort override,
  so the advisor runs at that model's default effort.
- Every review emits an "agent finished" system notification into the main agent's context.
  This is runtime behaviour for background agents and cannot currently be suppressed.
- Advice cannot interrupt mid-stream — it is delivered at the next tool-call boundary. An agent
  that stops calling tools and answers directly will not be reviewed before it replies.
- There is no backlog stall: if the advisor falls behind, reviews are skipped rather than
  pausing the main agent.
- Reloading extensions mid-review orphans that review's sub-agent in the `idle` state.

## Debugging

Set `debugLog` (default `~/.copilot/logs/advisor.log`) to trace the review loop: check start,
sub-agent id and model, per-poll task status, reply recovery, parsed verdict, and delivery. When
a review settles without a reply, the extension dumps the event types and `subagent.*` payloads
seen since the baseline so the correlation can be diagnosed without rebuilding.
