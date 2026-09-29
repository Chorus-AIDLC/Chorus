## Context

`ClaudeSpawner.wake()` (`cli/claude-spawner.mjs`) spawns one process per wake:
- Command: `claude -p --output-format stream-json --verbose` plus `--session-id <id>` for a new session or `--resume <id>` for an existing one. The disk-transcript probe decides which. The command also carries `--mcp-config`, and either `--allowedTools mcp__chorus__*` (`--chorus-only`) or `--dangerously-skip-permissions` (default yolo). Operator `cliConfig.args` are appended after these flags.
- Input: the prompt is written to stdin as **plain text**, then stdin is closed at once.
- Output: stdout NDJSON is parsed by `parseNdjsonChunk` and forwarded unchanged to `onMessage`. The consumers are `upload-hooks` for transcript and usage, and operation events.
- Settlement: `awaitChildSettled` settles the wake on process exit. `exitCode` is the raw process code. The `session_conflict` classification comes from stderr.
- Interrupt and shutdown: `killProcessTree` sends SIGINT to the POSIX process group (or runs `taskkill` on Windows), then escalates after `sigintTimeoutMs` (default 10 s, layered config).

The Codex migration (PR #580) added a backend-neutral seam: `registerProcessStopHook(child, hook)`. When a stop hook is registered, `killProcessTree` calls `hook({ deadline, protocolDeadline, reason, beforeClose })` instead of SIGINT. It waits for exit within the same deadline, then force-cleans any remaining tree. On Windows it uses the verified `WindowsProcessTree` identity-preserving cleanup. This change reuses that seam unchanged.

Owner decisions (elaboration round 1, all recommended options): per-wake process (q1); protocol interrupt with the existing signal fallback (q2); keep wake-queue coalescing (q3); explicit visible deny, boundary unchanged (q4); hand-written client, no new dependency (q5); direct replacement, no switch (q6); `--disallowedTools AskUserQuestion` (q7).

## Goals / Non-Goals

**Goals**
- Drive the per-wake Claude process over the bidirectional stream-json protocol.
- Interrupt a running turn over the protocol, inside the existing graceful deadline.
- Make `--chorus-only` permission denials explicit and visible, and make it impossible for an unexpected control request to hang a turn.
- Block `AskUserQuestion` at the tool layer for daemon wakes.
- Preserve every other behavior: session anchoring and resume, cwd, env/credentials, MCP config, operator args, transcript/usage delivery, exit-code semantics, session-conflict classification, and Windows `.cmd` spawn.

**Non-Goals**
- A long-lived or cross-wake process, or process reuse.
- Injecting coalesced messages into a running turn.
- A permission-approval UI bridge.
- `@anthropic-ai/claude-agent-sdk`.
- Any new timeout, watchdog or duration limit (#569).
- Server, DB, UI or API changes.

## Decisions

### D1. Arguments

`buildArgs` becomes:

```
-p --input-format stream-json --output-format stream-json --verbose
(--session-id <id> | --resume <id>)
[--mcp-config <path>]
--disallowedTools AskUserQuestion
chorus-only: --allowedTools mcp__chorus__* --permission-prompt-tool stdio
yolo:        --dangerously-skip-permissions
```

`--disallowedTools` takes several values, so it must never be the last flag before a positional or before operator args that could be read as tool names. It is therefore emitted as `--disallowedTools AskUserQuestion` before the permission flags, and operator args are still appended last. `agent-cli-config` already protects `input-format`, `permission-prompt-tool`, `disallowedTools`, `allowedTools` and related controls, so operator config cannot override them. No change there.

*Alternative rejected:* `--permission-prompts host`. On 2.1.283 it produced no control request for a denied `touch` (probe). `--permission-prompt-tool stdio` does, and it is what the SDK uses.

### D2. Input framing and turn completion

After spawn, the spawner writes exactly one line:

```
{"type":"user","message":{"role":"user","content":<prompt string>},"parent_tool_use_id":null}\n
```

stdin **stays open**. The spawner closes stdin (`end()`) after the first stdout frame with `type:"result"`, whatever its subtype. The process then drains Stop hooks and exits, and settlement is unchanged: raw exit code, `awaitChildSettled`, `session_conflict`.

- If the process exits or errors before a result arrives, the result is the raw exit as today. No synthetic success is produced.
- The existing EPIPE-safe stdin error listener remains. Every write, including control responses, checks `writable`/`destroyed` and is try/caught.
- A stdout line longer than any fixed buffer is fine: `parseNdjsonChunk` concatenates strings without a cap. Multica's Go `bufio` overflow problem does not apply.

### D3. Control frames

The spawner handles stdout frames with `type` `control_request`, `control_response` and `control_cancel_request` itself and **does not forward them to `onMessage`**. They are protocol plumbing, not conversation, and upload-hooks and operation events must see the same stream as before.

| Incoming | Mode | Response |
|---|---|---|
| `control_request` `can_use_tool` | chorus-only | `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"deny","message":"<Chorus deny text>"}}}` plus `logger.warn("[Chorus] denied tool <name> (--chorus-only permission mode)")` |
| `control_request` `can_use_tool` | yolo (unexpected) | same deny response plus warn (fail closed: yolo never routes permission prompts, so receiving one is a protocol surprise) |
| any other `control_request` subtype | any | `{"type":"control_response","response":{"subtype":"error","request_id":…,"error":"unsupported by Chorus daemon"}}` plus warn |
| `control_response` | any | correlate with the pending interrupt `request_id` (D4); otherwise ignore |
| `control_cancel_request` | any | ignore (debug-level; nothing pending on our side) |

The deny message tells the model the tool is blocked by the daemon's `--chorus-only` policy and that it should use Chorus MCP tools or ask the human through a Chorus comment. The warn line contains only the tool name and never the tool input, which could hold secrets. Visibility in turn events is already provided by the forwarded stream: the denied call surfaces as the `tool_result` inside a forwarded `user` frame, and it is listed in `result.permission_denials`. Both reach `onMessage` and the transcript unchanged, so this change adds no new turn-event type.

### D4. Protocol interrupt through the stop hook

On spawn the spawner calls `registerProcessStopHook(child, hook)` and unregisters it on settle. The hook receives `{ deadline, protocolDeadline, reason, beforeClose }` (the same contract Codex uses):

1. If a result was already seen or stdin is already closed, skip steps 2–3 (no interrupt write, no wait), because the process is already finishing, but **still run step 4**. Stop hooks may still be spawning descendants, and Windows cleanup needs their identities captured while the root is alive.
2. Otherwise write `{"type":"control_request","request_id":"chorus-interrupt-<n>","request":{"subtype":"interrupt"}}` once. Repeated invocations reuse the same in-flight promise.
3. Wait for the **first** of these: a `result` frame; a `control_response` with `subtype:"error"` for that request id; child exit; or the supplied `protocolDeadline`. This is the **existing** killer deadline, derived from `sigintTimeoutMs`, not a new timer.
4. `await beforeClose?.()` (the killer's Windows `WindowsProcessTree.capture()`; it must run while the root is still alive so surviving descendants keep their verified identities — `codex-spawner.mjs` awaits it the same way), wrapped so a throw/rejection is logged and does not skip step 5.
5. Close stdin if it is still open, and resolve. `beforeClose` is awaited on **every** path, exactly as `codex-spawner.mjs` does.

`killProcessTree` then waits for exit inside the same deadline and force-cleans any remaining tree, as it already does for Codex. A `cleanup` reason is not used, because a normal Claude completion already exits after D2's stdin close. Waker semantics are unchanged: the control handler's `interrupting` flag still maps the exit to `interrupted(user)`, shutdown still maps to `interrupted(shutdown)`, and resume still uses `--resume <anchor>`.

If the interrupt lands before the turn starts, the CLI may still run the queued user frame after acknowledging. The hook then waits until `protocolDeadline`, the killer finds the process alive, and force cleanup runs. The whole stop stays inside the existing single deadline.

Windows: with a hook registered, the killer uses the Codex-verified `WindowsProcessTree` path instead of plain `taskkill /T /F`. It still has the same limit: it is injected-contract verified on Linux and not live-verified on Windows.

### D5. Fixtures and version pinning

Frames are recorded as JSON fixtures under `cli/__tests__/fixtures/claude-stream-json/`, each carrying a `provenance` field. Three are captured live from CLI 2.1.283: an init + assistant + result turn; an interrupt ack followed by `result:error_during_execution`; a `can_use_tool` request. The unknown-control-request fixture is **synthesized** and labelled `provenance: "synthetic"`, because the CLI emits no such frame on demand. The frame shapes rest on SDK-level docs plus local probes; task 3's live permission-denial and interrupt scenarios are the required re-confirmation. Spawner unit tests replay them through the existing fake-child pattern. `docs/DAEMON.md` states the verified version. No runtime version gate is added: there is no evidence of a minimum, and the flags already exist on the 2.1.2xx line the daemon targets.

## Risks / Trade-offs

- **CLI wire protocol is documented only at the SDK level** → mitigate with pinned fixtures, a live verification task and a docs note. Unknown frame types pass through to `onMessage` as today, except the three `control_*` types.
- **The process never emits a result and never exits** (hang) → same exposure as today's single-message mode. By owner rule #569 no watchdog is added; user interrupt and shutdown still stop it through D4 and the killer.
- **Denied tools that used to be silent now log warnings** → intended (q4). The log carries the tool name only.
- **AskUserQuestion is disallowed even in yolo** → intended (q7). Headless yolo previously received empty answers.
- **Windows path now goes through `WindowsProcessTree`** → the same code path Codex ships. The documented limits carry over.

## Migration Plan

This is a direct replacement with no data migration. Existing Claude sessions resume unchanged: the same transcript files and the same `--resume` anchor, verified live. Rollback means reverting the commit; there is no persisted state to undo.

## Open Questions

None blocking. Live Windows verification remains a known gap, as it is for the Codex backend.
