## Why

The daemon wakes Pi as a one-shot `pi --mode json --session-id <anchor> -p` run: the prompt is piped to stdin, stdin is closed, and the wake settles when the process exits. There is no protocol-level cancel (interrupt is a signal to the process group), no explicit "the agent is done" signal, and nothing answers an extension that asks the user a question. Codex (PR #580) and Claude Code (PR #582) already moved to bidirectional stdio protocols. The owner asked for the same move for Pi (Idea `74aea8a2-eb13-4792-a6a5-d2697b9afe9b`) and on 2026-09-29 answered all eight elaboration questions with the recommended option.

Pi ships a native RPC mode (`pi --mode rpc`): JSONL commands on stdin (`prompt`, `abort`, `get_state`, …), `response` frames plus the same AgentSessionEvents as JSON mode on stdout, and an `extension_ui_request` / `extension_ui_response` sub-protocol ([Pi RPC docs](ref:a11e7f72-4b5d-448d-bd62-668950dcaa71)). Local probes on Pi 0.85.1 with a real model (Bedrock, Fable 5.1) on 2026-09-29 confirmed:

- `pi --mode rpc --session-id <new-uuid>` creates the session (stderr warning `No project session found … creating a new session with that id`), answers `prompt` with `response{success:true}`, streams events, then emits `agent_end` followed by `agent_settled`.
- A second process with the same `--session-id` resumed the conversation (the model recalled the earlier reply). A session created by the old `--mode json -p` path also resumed in RPC mode.
- `abort` sent while a `bash` tool ran `sleep 60` ended the tool (`Command aborted`), then `agent_settled`, then `response{command:"abort",success:true}`, within ~1.5 s. The process kept running until stdin was closed and then exited 0.
- Closing stdin makes RPC mode shut down immediately (`rpc-mode.js` `onInputEnd → shutdown()`), so stdin must stay open until the run is settled.
- A session file that pi cannot parse is treated as absent: pi silently creates a new session with the same id (same stderr warning).
- No `session` header line is printed in RPC mode (JSON mode printed one; no daemon consumer reads it).

## What Changes

- **BREAKING (internal transport):** Pi daemon wakes always run `pi --mode rpc --session-id <anchor>`. The `--mode json -p` path is removed with no switch (owner q2).
- Still one Pi process per wake (owner q3). The spawner sends `get_state`, then one `prompt` command, keeps stdin open, and closes stdin after the first `agent_settled` (owner q7). A `prompt` response only means "accepted"; it never completes the wake. A rejected prompt (`success:false`) closes stdin and settles the wake as a failure. A prompt pi handles without starting a run (an extension slash command or an extension `input` handler) is detected with a follow-up `get_state` (`isStreaming:false`, no `agent_start`) and closes stdin, as JSON print mode would have exited.
- **Session continuity** (owner q4): the anchor is unchanged, and pi keeps owning create-or-resume. `get_state.messageCount` before the prompt tells the spawner whether pi resumed or started fresh, so `isNew` in the wake result becomes truthful. When pi started fresh although a session file for that anchor already exists next to the new one (history could not be restored), the spawner logs a warning and injects a visible continuity notice into the transcript.
- **Cancel** (owner q7): the spawner registers the existing process stop hook. It sends `abort`, waits for `agent_settled`, the abort response, child exit, or the killer's protocol deadline, then awaits the killer's `beforeClose` and closes stdin. The existing process-tree force cleanup still applies. No new timeout or watchdog (#569).
- **Extension UI** (owner q5): blocking dialog requests (`select`, `confirm`, `input`, `editor`) get an immediate `{"type":"extension_ui_response","id":…,"cancelled":true}` and a warning naming the method. Fire-and-forget requests (`notify`, `setStatus`, …) are consumed without a reply.
- `response` and `extension_ui_request` frames are consumed by the spawner and not forwarded; every other event is forwarded unchanged, so transcript upload and operation events see the same stream as before (owner q1).
- Messages that arrive during a running wake keep the current wake-queue coalescing; `steer` / `follow_up` are not used (owner q6).
- **Version gate** (owner q8): the spawner reads `pi --version` once per resolved executable and refuses to wake (visible error with an upgrade command, `exitCode: null`) when the version is below 0.85.0. Linux, macOS and Windows spawn rules are unchanged. Linux is verified live by an agent; macOS and Windows are verified live by a human in a separate task (owner q8).

## Capabilities

### New Capabilities

- `daemon-pi-rpc`: the Pi daemon backend's RPC session: completion on `agent_settled`, protocol abort through the stop hook, extension-UI handling, frame filtering, continuity detection and the version gate.

### Modified Capabilities

- `pi-daemon-backend`: the "pi spawner implements the wake contract" requirement now describes `pi --mode rpc` with a `prompt` command over stdin instead of `pi --mode json -p` with piped text.

## Impact

- Code: `cli/pi-spawner.mjs` (args, RPC channel, stop hook, version gate); `cli/__tests__/pi-spawner.test.mjs` plus new fixtures under `cli/__tests__/fixtures/pi-rpc/`. `waker.mjs`, `wake-queue.mjs`, `control-handler.mjs`, `process-killer.mjs`, `process-stop-hooks.mjs` and `upload-hooks.mjs` are reused unchanged.
- Docs: `docs/CONNECT_PI.md` (transport, minimum version) and `docs/DAEMON.md` (Pi backend notes).
- No server, database, UI, API or plugin change. No new npm dependency.
- Out of scope: long-lived / pooled Pi processes, `steer` / `follow_up`, bridging extension dialogs to the Chorus UI, and adding Pi token-usage reporting (Pi wakes report no usage today; this change keeps that).
