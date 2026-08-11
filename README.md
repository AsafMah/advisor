# advisor

An independent reviewer model that watches the main Copilot agent work and comments when it
drifts, forgets a requirement, or repeats an approach that has already failed.

Review is **asynchronous and retrospective**: it audits what has happened, it does not gate what
happens next. Read "What a blocker actually does" before relying on it as a safety control.

Inspired by [oh-my-pi](https://github.com/)'s `WATCHDOG` advisor, reimplemented as a GitHub
Copilot CLI extension.

## Status: experimental

The mechanism works and is well tested. Whether continuous review is *worth its cost* is not
established. From ~50 review runs in one long session:

| Verdict | Count |
| ------- | ----- |
| `none` | 36 |
| `concern` | 3 |
| `nit` | 1 |
| `blocker` | 4 — all synthetic, forced during testing |
| errors | 8 |

**No blocker has ever fired organically.** Two catches were genuinely valuable — a real defect in
this extension's own code, and catching its author building a workaround before diagnosing a root
cause — which is roughly 25 frontier-model reviews per useful catch.

Both came while reviewing work on *this extension*: long, tool-heavy, plan-explicit engineering.
That is plausibly where the value is, and it is narrower than "watch everything". Routine work
produces mostly expensive silence. Budget accordingly, and prefer a higher `everyNToolCalls` or
manual `/advisor-check` over the default cadence until you have your own evidence.


## How it works

```
main agent runs tools
        │
        ├─ tool.execution_start ──► counter++
        │       (main agent only)     │
        │                             └─ every N tool calls ─► spawn advisor sub-agent
        │                                                       (own model, own context)
        │                                                              │
        │                                                              ▼
        │                                                  {"severity":…, "note":…}
        │                                                              │
        └─ onPreToolUse ◄──────── pending advice ◄─────────────────────┘
           (main agent only)
                │
                ├─ nit / concern ─► injected as hidden context
                └─ blocker ───────► the NEXT tool call is denied
```

Note the asymmetry in that diagram: the review is triggered by one tool call but delivered
before a *later* one. Everything below follows from that.

Every `everyNToolCalls` tool calls, the extension snapshots what has happened since the last
review and hands it to a **separate sub-agent** running its own model. That agent returns a
severity and a note. The advice is then delivered on the main agent's *next* tool call:

| Severity  | Effect                                                            |
| --------- | ----------------------------------------------------------------- |
| `none`    | Nothing happens.                                                  |
| `nit`     | Injected as hidden context alongside the next tool call.          |
| `concern` | Injected as hidden context.                                       |
| `blocker` | The next tool call is **denied**, with the advisor's note as the reason. |

## What a blocker actually does

A blocker denies **the next tool call the agent makes**, which is usually *not* the call the
reviewer was looking at. By the time a verdict arrives — reviews take 10–60 seconds while the
agent keeps working — the action under review has typically finished.

So a blocker is a loud, disruptive way to make the agent stop and read a note. It is not a gate:

- It may deny an unrelated, harmless call.
- It cannot cancel work already in flight; `onPreToolUse` has already passed for those.
- The agent may simply retry, route around it, or answer without calling a tool at all.
- Nothing is latched — one call is denied, then normal operation resumes.

Advice older than `maxAdviceAgeMs` is discarded rather than delivered, which limits the damage
but does not make delivery causally aligned with the reviewed action.

Treat `blockOnBlocker` as "interrupt me hard", not as a safety control. If you want advice
without the disruption, set it to `false` and blockers inject as context like everything else.

## Install

Ask Copilot to install it directly from a repository folder:

```
install_extension({ url: "https://github.com/<owner>/<repo>/tree/main/advisor", scope: "user" })
```

Or place the folder yourself, then run `/extensions reload`:

| Platform | Destination |
| -------- | ----------- |
| Windows  | `%USERPROFILE%\.copilot\extensions\advisor\` |
| macOS / Linux | `~/.copilot/extensions/advisor/` |

Only `extension.mjs` is required. Use `.github/extensions/advisor/` instead to scope it to one
repository.

For development, link the checkout rather than copying it so edits take effect on reload:

```powershell
# Windows
New-Item -ItemType Junction -Path "$env:USERPROFILE\.copilot\extensions\advisor" -Target "C:\src\advisor"
```

```bash
# macOS / Linux
ln -s ~/src/advisor ~/.copilot/extensions/advisor
```

## Configuration

Copy `advisor.example.json` to `~/.copilot/advisor.json` and edit. Config is read from the first
of these that exists:

1. `$COPILOT_ADVISOR_CONFIG`
2. `<cwd>/.github/advisor.json` — per-repository
3. `<copilot config dir>/advisor.json` — per-user

Everything is optional; anything omitted falls back to the built-in defaults. Log paths may be
relative, in which case they resolve against the CLI's log directory.

| Key                   | Default          | Meaning                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `enabled`             | `true`           | Master switch.                                                          |
| `model`               | `gpt-5.6-sol`    | Model the advisor runs on. Independent of the main agent's model. Set to `null` to inherit. |
| `agentType`           | `rubber-duck`    | Built-in agent type to spawn. Custom agents are not dispatchable.         |
| `everyNToolCalls`     | `12`             | Review cadence.                                                          |
| `immuneToolCalls`     | `4`              | No reviews until this many tool calls into a turn.                       |
| `backoff`             | `true`           | Widen the interval after reviews that find nothing.                      |
| `maxBackoffFactor`    | `8`              | Cap on that widening, as a multiple of `everyNToolCalls`.                 |
| `maxAdviceAgeMs`      | `120000`         | Discard advice older than this instead of acting on it. `0` disables.    |
| `blockOnBlocker`      | `true`           | Whether `blocker` denies the tool call, or just injects context.         |
| `minSeverityToInject` | `nit`            | Drop advice below this severity.                                         |
| `maxTranscriptChars`  | `24000`          | Cap on the transcript slice sent to the advisor.                         |
| `maxToolResultChars`  | `1200`           | Per-tool-result truncation inside the transcript.                        |
| `timeoutMs`           | `180000`         | How long to wait for the advisor sub-agent.                              |
| `pollIntervalMs`      | `2000`           | How often to check whether the review has finished.                      |
| `logToTimeline`       | `true`           | Surface advice in the session timeline so you can see it too.            |
| `timelineLevel`       | `"info"`         | Log level for advice. Must not be `error`; see below.                     |
| `debugLog`            | `"advisor.log"`  | Trace file for the review loop. Relative to the CLI log directory. `null` disables. |
| `adviceLog`           | `"advisor-advice.log"` | Human-readable advice record read by `/advisor-log`. `null` disables. |
| `instructions`        | `""`             | Extra project-specific review instructions appended to the prompt.       |

Log paths are suffixed with the session id, so `advisor-advice.log` becomes
`advisor-advice-1a2b3c4d.log`.

## Commands

| Command                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `/advisor`              | Status: cadence, counters, advice log path, last error. |
| `/advisor-log [n]`      | Show the last n pieces of advice for this session (default 5). |
| `/advisor-check`        | Force a review right now.                  |
| `/advisor-on`           | Enable for this session.                   |
| `/advisor-off`          | Disable for this session.                  |
| `/advisor-model <id>`   | Override the advisor model for the session. |
| `/advisor-every <n>`    | Override the cadence for the session.       |
| `/advisor-reload`       | Re-read `advisor.json` from disk.           |

Session overrides are in-memory and reset when extensions reload.

## What the advisor sees

Each review is given four things:

1. **The user's goal** — the prompt that started the current turn.
2. **The stated plan** — `plan.md` and the session todo list, read via `rpc.plan.read()` and
   `rpc.plan.readSqlTodos()`. Without these, "drifting from the request" can only be guessed at.
3. **Recent activity** — messages, stated intents, tool calls and results since the last review.
4. **What is executing right now** — tool calls that have started but not finished.

The fourth matters most. It is derived from `tool.execution_start` / `tool.execution_complete`
events for the main agent, keyed by call id. Knowing what is running tells the reviewer what the
agent is committed to, which a purely historical transcript does not. It does **not** let the
advisor stop that call — see "What a blocker actually does".

The advisor is also shown its own recent verdicts, so it can recognise a repeated failure rather
than restating the same note every review.

## Waiting on the user is not agent work

`ask_user` is excluded from all of it: it is not counted towards the cadence, never appears in
"what is executing right now", and never receives advice or a blocker. While a question is open
the advisor also starts no new review, and holds any verdict that lands until the user answers.

Each of those is a failure that was observed rather than imagined. Treating the call as work fed
the question and its multiple-choice options to the reviewer, which then critiqued the *question*
instead of the work. Counting it towards the cadence made the question itself trigger a review, so
the review fired at the exact moment the user was being asked. The verdict then arrived as an
error-level notification on top of the pending prompt, and the session hung — twice, in unrelated
sessions. A blocker would have been worse still: it would deny the agent the one action that
resolves the ambiguity the advisor was worried about. The call also never completes until the user
answers, so it would otherwise have sat in the in-flight set until the prune timeout and been
shown to every review in between.

The tool name alone is not enough. The `user_input.requested` event that signals a pending
question arrives about a second *after* the `tool.execution_start` that raised it, so it cannot
catch a review that the question itself triggers — hence both guards. Conversely the tool name
alone cannot catch a review triggered by an earlier call that happens to finish while the question
is on screen, which is the same crash with different timing.

A question is not the only thing that stops the session on a human. Tool-permission prompts and
MCP elicitations block it just as completely, and permission prompts have been measured sitting
open for six and seven minutes — a wide window to announce a concern into. So the hold covers all
three: `user_input`, `permission` and `elicitation`, each tracked by `requestId` across its
`.requested` / `.completed` pair. The three id spaces are independent, so the keys are namespaced
by kind to stop an id in one closing a prompt in another. A permission the hook resolves by itself
is skipped, because it never reaches the user and so blocks nothing.

Nothing expires on a timer. A prompt can legitimately sit unanswered for hours, and a timeout
would fire a notification over a live prompt — the exact bug this avoids. The hold is released
instead by the next user turn, which is positive evidence the user is back and that any prompt
they were shown is moot. That keeps a dropped `.completed` event from silencing the advisor for
the rest of the session.

## Cadence and backoff

Reviews are expensive and most find nothing, so the interval doubles after each quiet review —
`everyNToolCalls` → 2× → 4× — capped at `maxBackoffFactor`. Any `nit` or higher resets it to the
configured cadence immediately. `/advisor` shows the live interval and quiet streak.

## Seeing the advice

Advice is delivered into the agent's context, where you cannot see it. Two things make it visible:

- **The timeline.** Each piece of advice is logged with a banner, at `info` level. Be aware that
  this host currently renders *no* level of extension log in the app window, so the timeline copy
  is effectively write-only here — use the advice log below. `timelineLevel` deliberately does not
  default to `error`: see [Advice is not a session failure](#advice-is-not-a-session-failure).
- **The advice log.** A human-readable record of every outcome: raised, injected, denied, dropped
  as stale, or undelivered. Read it with `/advisor-log`, or tail the path printed at startup.

Log paths are suffixed with the session id, because otherwise concurrent sessions interleave
their entries into a single unreadable file.

## Advice is not a session failure

Advice is logged at `info`. It must never be logged at `error`, and that is not a style
preference — the host treats it as a terminal fault.

An extension log at error level becomes a `session.error` event carrying `errorType:
"notification"`. The host classifies *any* `session.error` whose `errorType` is not `model_call`
as terminal: it sets `hasError`, which stops an autopilot run with reason `"error"` and leaves the
session marked failed. So an advisor that reported at error level halted the very sessions it was
supposed to be helping — every concern it raised ended the run. The symptom is easy to
misdiagnose, because the event stream carries on normally; what dies is the continuation loop and
the session's status, neither of which appears in the transcript.

`warning` is the middle option: non-terminal, except for the two warning types the host reserves
(`compaction_static_context_blocked`, `policy_blocked`), which an extension notification is not.
It is a safe choice on a host that renders warnings.

The trade is visibility. This host renders no level of extension log in the app window — measured,
by emitting at all three — so nothing is lost by dropping to `info` here, and a session that keeps
running is worth more than a banner that never appears. Advice still reaches the agent by
injection on its next tool call, and reaches you through the advice log.

## Prompt injection into the review transcript

The transcript is assembled from the session event log, which contains text the advisor must not
obey: sub-agent prompts, file contents, tool output, pasted issue text. Any of it can be phrased
as an instruction, and once inlined it looks exactly as authoritative as the user's own words.

This is not hypothetical. An advisor read a throwaway probe sub-agent's prompt — *"Reply with
exactly the word: done. Do not use any tools."* — out of a `TOOL_CALL` argument, asserted it as
"the explicit user requirement", and issued a `blocker` that halted unrelated work.

Three layers guard against it:

1. **Instruction-bearing arguments are redacted.** `prompt` and `message` fields in tool arguments
   are replaced with a placeholder before rendering. Scoped deliberately: those two are
   near-universally instructions to another agent, whereas `body`, `content` and `file_text` are
   data the reviewer needs.
2. **The prompt states what carries authority.** Only `<user_goal>` and `USER:` lines are the
   user's words; everything else is data, even when phrased as a command.
3. **Unfounded blockers are downgraded.** A `blocker` claiming a user requirement is checked
   against the actual user prompts. If nothing corroborates it, it becomes a `concern` with an
   explanation appended — a false blocker is the expensive failure, since it stops real work.

Note the asymmetry this corrects: the advisor's *output* was already quarantined (angle brackets
escaped, length capped), but nothing filtered its *input*.

Layer 3 depends on the record of user prompts being genuinely the user's. It was not: a sub-agent's
opening prompt is dispatched to `onUserPromptSubmitted` like any other, so every `task` sub-agent's
brief — and the advisor's own review prompt, which embeds the whole transcript — was being recorded
as something the user had said. That both replaced the goal under review and let arbitrary
transcript text corroborate a blocker claiming to quote the user. Observed in the wild: the advisor
denied a main-agent tool call over a "user requirement" that was a sub-agent's task prompt. Hooks
are now attributed to an agent before they are acted on — see "Only the main agent is watched".

## Development

```
node --check extension.mjs            # syntax
node scripts/test-parse.mjs           # verdict parsing and note sanitisation
node scripts/check-config-keys.mjs    # DEFAULTS vs example vs README table
node scripts/check-config-usage.mjs   # every cfg() key declared, every key used
```

The parsing tests matter more than their size suggests: they cover the path that turns untrusted
model output into a decision that can block a tool call. A real bug lived there — a non-greedy
regex meant any note mentioning code truncated into invalid JSON and the verdict was silently
discarded as "no concerns".

## Design notes

- **Non-blocking.** The review runs as a detached background task; the main agent never waits.
  Advice lands on the next tool call after the advisor finishes.
- **Reply recovery.** The reply is read in order of reliability: `task.result`, then
  `task.latestResponse`, then the session event log. The first two are keyed by the task id the
  extension owns, so they cannot bind to a foreign agent. The event-log fallback exists because
  `tasks.list()` can report the sub-agent as `idle` while leaving `result` null indefinitely; it
  records the event count before dispatching, finds the `subagent.started` event carrying this
  extension's own description, and reads the last `assistant.message` with the same internal
  `agentId` (`bg-…`) once `subagent.completed` appears. Correlation requires an exact match —
  guessing by model or by "first agent after my baseline" will eventually bind to another
  extension's sub-agent and parse its output as a verdict.
- **Only the main agent is watched.** Sub-agent events carry an `agentId`; main-agent events do
  not. Every trigger path filters on it: the transcript, the in-flight set, and the tool-call
  counter that drives the cadence. Extension hooks need more work, because they are dispatched for
  sub-agents too and their payload carries no agent identity — the `invocation` argument holds
  only `sessionId`. The event log brackets each hook dispatch in `hook.start`/`hook.end` events
  that *do* carry `agentId`, so `onUserPromptSubmitted` and `onPreToolUse` resolve their caller
  from the bracket open around them. Without this the advisor reads its own review prompt as the
  user's goal, counts its own file reads as the main agent working, and delivers advice about the
  main agent into a sub-agent that cannot act on it. None of this stands the advisor down while a
  sub-agent runs: advice stays pending and is delivered on the main agent's next tool call.
- **Untrusted output.** The advisor's note is injected into the main agent's context and can deny
  a tool call, so it is stripped of control characters, has angle brackets escaped so it cannot
  forge a structural tag, and is capped at 800 characters. It is wrapped in an `<advisor>` block
  that tells the main agent the source is fallible.
- **Failures are loud.** Every give-up path raises an error rather than returning an empty
  verdict, because an empty verdict reads as "no concerns" — which both hides the failure and,
  by counting as a quiet review, widens the backoff so reviews become rarer. Errors surface once
  per distinct message; failures that cannot succeed on retry disable the advisor and say so.
- **Emission guard.** One piece of advice per review; no new review starts while one is in flight
  or while advice is still pending. Identical advice is suppressed for five minutes, but never
  for a `blocker`, so a genuine repeat of the same mistake is not silenced.
- **Incremental transcript.** Each review sees only what happened since the previous one, plus
  the user's original goal.
- **Advice is never silently lost.** Delivery normally happens on the next tool call, but a turn
  that ends without one would drop it, so anything still pending is flushed to the timeline on
  `session.idle`.
- **Transcripts are sent unredacted.** Tool results reach the advisor as-is, including anything
  sensitive that appeared in their output. This is deliberate: the advisor is an ordinary
  sub-agent of the same session, running on the same provider under the same trust boundary, so
  redacting for it would protect nothing the main agent has not already seen. oh-my-pi obfuscates
  secrets before handing them to its advisor; that only matters where the advisor is less trusted
  than the agent it watches, which is not the case here.
- **Self-cleanup.** A sub-agent parks in `idle` forever and would accumulate in the task list,
  so each review's task is cancelled and removed once its reply has been read.

## Known limitations

- **Review is retrospective, not preventive.** Reviews take 10–60 seconds while the agent keeps
  working, and advice is delivered at the next tool-call boundary. The action under review has
  usually finished by then. See "What a blocker actually does".
- **Cadence is a poor proxy for risk.** Triggering every N tool calls means most reviews land on
  routine work and return nothing, while a genuinely risky action gets no more scrutiny than a
  file read. Deterministic risk signals would be a better trigger; this does not implement them.
- **Reasoning effort cannot be controlled.** `startAgent` takes a `model` but no effort
  parameter, and it accepts only built-in agent types — `explore`, `task`, `general-purpose`,
  `rubber-duck`, `code-review`, `research`, `security-review`. A custom agent on disk can carry
  its own `model` and `reasoningEffort`, but is rejected with `Unknown agent type`, so it cannot
  be used to pin the advisor's effort. The review therefore runs at the backend's default effort
  for the chosen model; per the SDK, the parent session's effort is *not* inherited. The only
  remaining levers are `subagents.agents["rubber-duck"].effortLevel` in `settings.json` or a live
  override via `rpc.tools.updateSubagentSettings`, both of which also affect any `rubber-duck`
  agent you dispatch yourself.
- Every review emits an "agent finished" system notification into the main agent's context.
  This is runtime behaviour for background agents and cannot currently be suppressed.
- An agent that stops calling tools and answers directly will not be reviewed before it replies.
- There is no backlog stall: if the advisor falls behind, reviews are skipped rather than
  pausing the main agent.
- Reloading extensions mid-review orphans that review's sub-agent in the `idle` state.
- Some sessions have no agent executors at all (`Cannot start subagent: agent executors are not
  available for this session`). There is no capability flag to detect this up front, so the
  advisor discovers it on its first review, disables itself for that session and says so.
  `/advisor-on` re-enables it.
- The `session.idle` flush is implemented but has not been observed firing in a real session.

## Debugging

Set `debugLog` (default `~/.copilot/logs/advisor.log`) to trace the review loop: check start,
sub-agent id and model, per-poll task status, reply recovery, parsed verdict, and delivery. When
a review settles without a reply, the extension dumps the event types and `subagent.*` payloads
seen since the baseline so the correlation can be diagnosed without rebuilding.
