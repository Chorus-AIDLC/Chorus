## Why

The daemon wakes Claude Code in single-message mode. It writes the prompt to stdin as plain text and closes stdin straight away. In that mode the running turn cannot be interrupted over the protocol, and a tool call outside the `--chorus-only` allowlist is denied without the daemon ever seeing it. Interrupts therefore rely only on signals. Codex already moved to a bidirectional protocol, the App Server (Idea `5e62d13f`, PR #580). The owner asked for the same kind of mechanism for Claude Code (Idea `ec066e74-d6f6-4e39-8b3e-c30e6584f36f`) and answered the seven clarification questions on 2026-09-29.

Claude Code has no separate server command. The equivalent is `claude -p --input-format stream-json --output-format stream-json`: NDJSON user frames plus `control_request` / `control_response` frames over stdio. The official Agent SDK "Streaming Input Mode" runs on this protocol, and the docs recommend it because it supports interruption and permission requests ([docs](ref:ca0e45c1-2d6f-4d89-8e77-00472a12e677)). Multica drives Claude this way, one process per run, keeping stdin open for control frames ([reference](ref:721c07d4-ef1b-4ce7-821c-97f3095a952c)).

We probed Claude Code 2.1.283 locally:
- One process ran three turns with a stable `session_id`.
- `control_request{subtype:"interrupt"}` ended the running turn with `result:error_during_execution`, and the process survived.
- `--permission-prompt-tool stdio` emits `control_request{subtype:"can_use_tool"}`. A `deny` reply reaches the model as the tool result and is listed in `result.permission_denials`.
- `--resume <id>` works in stream-json mode.

## What Changes

- **BREAKING (internal transport):** Claude daemon wakes always use `--input-format stream-json --output-format stream-json`. There is no fallback to text-input mode and no setting to switch back (owner q6).
- Still one `claude` process per wake (owner q1). The daemon writes the prompt as one stream-json user frame and keeps stdin open. After the turn's first terminal `result` frame it closes stdin, and the process exits normally. There is no long-lived or cross-wake process.
- **Interrupt** (owner q2): the spawner registers a process stop hook that sends `control_request{subtype:"interrupt"}` and waits for the turn to end, then closes stdin. The hook runs inside the existing `killProcessTree` graceful deadline; if the process stays alive, the existing process-tree force cleanup applies. No new timeout or configuration is added (#569).
- **Permissions** (owner q4): the allowlist boundary is unchanged. In `--chorus-only` mode, `--permission-prompt-tool stdio` routes every non-allowlisted tool request to the daemon. The daemon answers it with an explicit `deny` and a Chorus-specific message, and logs it visibly. In yolo mode behavior is unchanged (`--dangerously-skip-permissions`). Any unexpected or unsupported control request, in either mode, gets an immediate error/deny response so the turn cannot hang.
- **AskUserQuestion** (owner q7): every Claude daemon wake passes `--disallowedTools AskUserQuestion`. This reverses the earlier "soft guidance only" decision in `daemon-headless-interaction-guard`, for the Claude daemon spawn only. Interactive sessions and skill bodies are untouched.
- Messages that arrive while a turn runs keep the current wake-queue coalescing into the next turn (owner q3). Control frames are consumed by the spawner and never forwarded to the transcript/usage consumers.
- Implementation is a hand-written client in Node with no new dependency (owner q5). The observed wire behavior is recorded as test fixtures pinned to the verified CLI version.

## Capabilities

### New Capabilities

- `daemon-claude-stream-json`: the Claude daemon backend's stream-json session. Covers turn completion, the protocol interrupt, control-request handling, frame filtering and version pinning.

### Modified Capabilities

- `cli-daemon`: the Claude wake requirement and the cross-platform spawn requirement now describe a stream-json user frame over stdin, with stdin held open until the terminal result.
- `daemon-headless-interaction-guard`: the Claude daemon spawn denies `AskUserQuestion` at the tool layer, in addition to the prompt guidance.

## Impact

- Code: `cli/claude-spawner.mjs` (args, input framing, control handling, stop hook); tests in `cli/__tests__/claude-spawner.test.mjs` plus the waker/control-handler integration suites. No changes to `waker.mjs`, `wake-queue.mjs`, `control-handler.mjs`, `process-killer.mjs` or `upload-hooks.mjs` are expected; the existing `registerProcessStopHook` seam from the Codex migration is reused.
- Docs: `docs/DAEMON.md` (Claude backend transport, interrupt, permission denials, AskUserQuestion).
- No server, database, UI or API change. No new npm dependency. Linux/macOS/Windows spawn rules (`.cmd` shim via `cmd.exe /d /s /c`, POSIX process group) are preserved.
- Out of scope: long-lived or cross-wake processes, injecting new messages into a running turn, bridging permission approval to the Chorus UI, and adopting `@anthropic-ai/claude-agent-sdk`.
