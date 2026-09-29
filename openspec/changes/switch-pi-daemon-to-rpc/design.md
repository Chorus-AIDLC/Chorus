## Context

`PiSpawner.wake()` (`cli/pi-spawner.mjs`) spawns one process per wake:
- Command: `pi --mode json --session-id <anchor> [operator args] -p`. `--session-id` is pi's create-or-resume flag, scoped to the cwd's session directory.
- Input: the prompt is written to stdin as plain text and stdin is closed immediately.
- Output: stdout JSONL is parsed by `parseNdjsonChunk` and forwarded unchanged to `onMessage`. `upload-hooks.extractTranscriptText` keeps assistant `message_end` text. Pi reports no token usage.
- Settlement: `awaitChildSettled` on process exit; `exitCode` is the raw code. `isNew` is echoed from the waker's Claude transcript probe, which never matches a Pi session (`sessionDecision.probeIsAuthoritative = false`).
- Interrupt/shutdown: no stop hook, so `killProcessTree` sends SIGINT to the POSIX group (or `taskkill` on Windows) and escalates after `sigintTimeoutMs`.

The Codex (PR #580) and Claude (PR #582) migrations share the `registerProcessStopHook(child, hook)` seam: the killer calls `hook({ deadline, protocolDeadline, reason, beforeClose })`, waits for exit inside the same deadline and force-cleans any remaining tree (Windows via `WindowsProcessTree`). This change reuses it unchanged.

Pi RPC facts this design depends on were read from the Pi 0.85.1 package (`docs/rpc.md`, `dist/modes/rpc/rpc-mode.js`, `dist/main.js`) and probed live (see proposal):
- stdin EOF → `shutdown()` → exit 0, even mid-run.
- `prompt` → `response` after preflight (`success:false` if rejected before acceptance). Later failures only appear in the event stream.
- `agent_end` may carry `willRetry`; `agent_settled` is the only "nothing more will run" signal.
- `abort` aborts the run, waits for idle, then responds. Tool processes are terminated by pi.
- Dialog `extension_ui_request`s block until an `extension_ui_response` with the same `id` (or the request's own `timeout`).
- `--session-id` without a parseable matching session in the cwd's session dir → new session with that id plus a stderr warning.

Owner decisions (round 1, all recommended): behaviour-preserving replacement (q1); no fallback switch (q2); per-wake process (q3); resume first, new session with a visible notice only when resume is impossible (q4); cancel dialogs (q5); keep wake-queue scheduling (q6); `agent_settled` completion + abort → bounded cleanup, no watchdog (q7); Pi ≥ 0.85.x on all three platforms (q8).

## Goals / Non-Goals

**Goals**
- Run the per-wake Pi process over RPC and settle on `agent_settled`.
- Cancel over the protocol inside the existing graceful deadline.
- Never leave a blocking extension dialog waiting for a terminal.
- Report `isNew` truthfully and make lost history visible.
- Refuse unsupported Pi versions with an actionable message.
- Preserve everything else: anchor, cwd, env/credentials, operator args, forwarded event stream, exit-code semantics, Windows `.cmd` spawn, POSIX process group.

**Non-Goals**
- Process reuse across wakes, `steer` / `follow_up`, a Chorus UI bridge for extension dialogs, Pi token usage, any new timeout (#569), server/UI/API changes.

## Decisions

### D1. Arguments

```
--mode rpc --session-id <anchor> [operator cliConfig.args]
```

`-p` is gone, so there is no trailing positional to protect; operator args are appended last. `agent-cli-config` already protects `mode`, `print`, `session-id`, `session`, `no-session`, `continue`, `resume` and `fork` for Pi, so operator config cannot override the transport. `--no-session` is never passed.

### D2. Channel lifecycle and completion

After spawn the spawner writes, one JSON object per line (`JSON.stringify(obj) + "\n"`; all writes check `writable`/`destroyed` and are try/caught, keeping the EPIPE-safe stdin error listener):

1. `{"id":"chorus-state-1","type":"get_state"}`.
2. On its `response`: record `messageCount`, `sessionFile` and `sessionId` (D5), then — unless a stop has started — write `{"id":"chorus-prompt-1","type":"prompt","message":<prompt>}`. If the `get_state` response is `success:false` or lacks `data`, log a warning, treat continuity as unknown (`isNew` falls back to the input value) and still send the prompt.
3. On the prompt `response`: `success:false` → log the error text, mark the wake failed (D6) and close stdin. `success:true` → write `{"id":"chorus-state-2","type":"get_state"}` (the idle check below).
4. On the first `agent_settled` after the prompt was sent: close stdin (unless a stop owns the close, D4). Pi then disposes and exits.
5. Idle check. Pi accepts some prompts without starting an agent run: a leading `/` handled as an extension command, or an extension `input` handler returning `handled` (`agent-session.js` `prompt()` calls `preflightResult(true)` and returns). No `agent_start` / `agent_settled` follows, so step 4 would never fire. For a prompt that starts a run, `preflightResult(true)` is followed synchronously by `_runAgentPrompt`, which sets `_isAgentRunActive` (`isStreaming`) before pi can read our next stdin line. So when the `chorus-state-2` response reports `isStreaming: false` and neither `agent_start` nor `agent_settled` has been seen, the prompt was handled without a run: log `info("[Chorus] pi handled the prompt without an agent run")` and close stdin. The wake settles with the raw exit code, which matches JSON print mode (`await session.prompt()` returned and pi exited 0). If the check reports `isStreaming: true`, or `agent_start` was already seen, nothing changes and step 4 closes stdin. A failed or unusable `chorus-state-2` response is logged and ignored (step 4 still applies).

`agent_end` never closes stdin, whatever its `willRetry` value. Settlement stays on process exit via `awaitChildSettled`. If the child exits or errors before `agent_settled`, the wake settles with the raw exit outcome. `parseNdjsonChunk` already splits on `\n` only (Pi's framing rule: not `readline`, which also splits on U+2028/U+2029) and strips a trailing `\r`.

### D3. Frame routing

| stdout frame | Handling | Forwarded to `onMessage`? |
|---|---|---|
| `response` | correlate by `id` with `chorus-state-1`, `chorus-state-2`, `chorus-prompt-1`, `chorus-abort-1`; unknown ids ignored (`command:"parse"` errors logged) | no |
| `extension_ui_request`, method `select`/`confirm`/`input`/`editor` | write `{"type":"extension_ui_response","id":<id>,"cancelled":true}` + `warn("[Chorus] cancelled pi extension <method> dialog (headless daemon)")` — method only, never title/message/options | no |
| `extension_ui_request`, any other method | consumed, no reply (fire-and-forget) | no |
| `agent_settled` | D2 step 4 / ends a stop wait (D4) | yes |
| everything else (`agent_start`, `message_*`, `turn_*`, `tool_execution_*`, `agent_end`, `compaction_*`, `auto_retry_*`, `extension_error`, unknown future types) | untouched | yes |

`extension_error` stays forwarded and is also logged as a warning (no-silent-errors). A cancelled dialog resolves to `undefined` / `false` in the extension, which is what pi's own dialog `timeout` would yield.

### D4. Protocol stop through the stop hook

On spawn the spawner calls `registerProcessStopHook(child, hook)` and unregisters on settle. `stop({ protocolDeadline, beforeClose })` (repeated calls share one promise):

1. If the prompt was sent, `agent_settled` has not been seen and stdin is open: write `{"id":"chorus-abort-1","type":"abort"}` once and wait for the first of: `agent_settled`, the abort `response`, child exit, or `protocolDeadline` (the killer's existing deadline — not a new timer).
2. If the prompt was not sent yet (stop latched while waiting for `get_state`), the prompt is never written and no abort is sent.
3. On every path: `await beforeClose?.()` (Windows tree capture needs the root alive), logging and continuing on failure; then close stdin. Pi exits on EOF.

The killer then waits for exit within the same deadline and force-cleans any remaining tree, as for Codex/Claude. Waker semantics are unchanged: the control handler's `interrupting` flag maps the exit to `interrupted(user)`, shutdown to `interrupted(shutdown)`. `reason: "cleanup"` needs no special case because a normal run already exits after D2 step 4.

### D5. Session continuity

`get_state.data.messageCount === 0` ⇒ pi created a new session; `> 0` ⇒ resumed. The wake result reports `isNew` from this (input value if unknown), and the waker's existing `backend started new / resumed session` log line becomes accurate.

When the session is new, the spawner lists the directory of `get_state.data.sessionFile` for other files whose name ends with `_<anchor>.jsonl` (pi's `<timestamp>_<id>.jsonl` naming). If one exists, the previous history for this anchor could not be restored (the probe showed an unparseable file is treated as absent). The spawner then:
- logs `warn("[Chorus] Previous pi history for session <anchor> could not be restored; continuing in a new pi session with Chorus context.")`, and
- forwards one synthetic `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":<notice>}]}}` to `onMessage` before the prompt is sent, so the transcript shows the notice (same approach as Codex's `adapter.notice`). This is intentional: the notice is shown in the conversation as assistant text, as with Codex, so the human reading the transcript sees that history was lost.

A directory listing error is logged and treated as "no evidence of lost history". The anchor is only used when it is a UUID. A session that pi resumes after a cwd change is out of reach (pi scopes sessions by cwd, unchanged from today).

### D6. Exit code

Pi RPC exits 0 on stdin EOF. To keep "early failure is not success", a rejected `prompt` (D2 step 3) or a `get_state`/prompt write that fails because stdin is gone settles with `exitCode: 1` when the raw exit code is 0; a non-zero raw code is always kept. Otherwise the raw exit code is reported, which matches JSON mode (a model error inside a run exited 0 there too).

### D7. Version gate

Before the first spawn for a resolved executable path, the spawner runs `pi --version` (same `resolveSpawnCommand`, env and `shell:false`) and parses the first `x.y.z`. The result is cached per path for the spawner's lifetime.
- `< 0.85.0` → `logger.error("[Chorus] pi <v> is too old for RPC daemon wakes (need >= 0.85.0). Upgrade: npm install -g @earendil-works/pi-coding-agent@latest")`, return `{ exitCode: null, backendSessionId: null }` without spawning.
- Unparseable output or a failed probe → warn and proceed (do not block unknown builds).

The probe is injectable (`versionProbeFn`) for tests.

### D8. Fixtures

Frames under `cli/__tests__/fixtures/pi-rpc/` carry a `provenance` field: live captures from Pi 0.85.1 for a normal run (get_state → prompt → events → `agent_settled`), a resumed run, and an abort during a running `bash` tool, and a prompt handled by a temporary extension slash command (no agent run); synthetic (labelled) where a live capture is impractical, e.g. a rejected prompt. A dialog `extension_ui_request` is captured live from a temporary extension that calls `ctx.ui.confirm` when possible, otherwise synthetic and labelled. Spawner tests replay them through the existing fake-child pattern.

## Risks / Trade-offs

- **Pi changes its RPC wire format** → fixtures pinned to 0.85.1 plus the version floor; unknown event types are forwarded, unknown responses ignored.
- **Pi never emits `agent_settled` and never exits** → same exposure as today's JSON mode; per #569 no watchdog. User interrupt and shutdown still stop it via D4 and the killer.
- **Session-file naming is a pi convention** → only used to decide whether to show a notice; a miss means no notice, never a failed wake.
- **Extension dialogs that expect answers now get `cancelled`** → intended (q5); the warning makes it visible.
- **`pi --version` adds one short process per spawner lifetime per path** → cached; failures never block a wake.
- **macOS / Windows** → same spawn and stop-hook paths as Codex/Claude (POSIX group; `.cmd` via `cmd.exe /d /s /c` + `WindowsProcessTree`). This Linux host can only verify them through injected contracts, so owner q8's three-platform gate is a separate human-run verification task (T3) with its own acceptance criteria. The change is not done until that task is verified or the owner explicitly accepts the gap.

## Migration Plan

Direct replacement; no data migration. Existing sessions (created by JSON mode) resume unchanged — verified live. Rollback = revert the commit.

## Open Questions

None blocking. macOS and Windows live verification is task T3 and is run by a human on those machines.
