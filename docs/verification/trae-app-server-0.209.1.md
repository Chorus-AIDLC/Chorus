# TRAE CLI App Server baseline — traecli 0.209.1

Verified 2026-10-13 on Linux x86_64 with **traecli 0.209.1** (`installation: public`),
for the `trae` daemon backend (OpenSpec change `add-trae-cli-backend`, design D1–D3).
This is the minimum verified version; earlier versions are untested. Codex's own
contract is in [codex-app-server-protocol.md](./codex-app-server-protocol.md).

Evidence:

- `traecli --help`, `traecli exec --help`, `traecli app-server --help`.
- `traecli app-server generate-json-schema --out <dir>`. The extracted field sets are in
  `cli/__tests__/fixtures/trae-app-server/schema-fields-0.209.1.json`.
- Live `traecli app-server --listen stdio://` probes against a logged-in `~/.trae`. The
  sanitized transcript is in `cli/__tests__/fixtures/trae-app-server/live-0.209.1.json`.
  - A fresh thread and turn in yolo posture.
  - Resume of that thread in a new process under chorus posture.
  - Resume rejections for an unknown thread id.

## Transport and argv

- The spawn is `traecli app-server --listen stdio://`. `--listen` defaults to `stdio://`
  (`unix://`, `ws://`, and `off` are also accepted). The daemon spawns it with
  `shell:false`, like Codex.
- `app-server` accepts the global `-c/--config key=value`, `--enable/--disable <FEATURE>`
  and `--strict-config` flags. The daemon still translates only `-m/--model` and `-c`
  (`codexAppServerArgs`). Any other configured arg fails before spawn.
- `--permission-mode` is listed for the interactive CLI and `exec` only. It is **not** used:
  posture is applied by RPC, as with Codex.
- Executable resolution order: `CHORUS_TRAE_PATH`, then `traecli` on PATH
  (`traecli.cmd`, `traecli.exe` and `traecli` on Windows).
- The config path is `$TRAE_HOME/traecli.toml`, falling back to `~/.trae/traecli.toml`.
  The `[mcp_servers.chorus]` probe is diagnostic only.

## RPC used by Chorus

Every method the shared client and spawner use is in the 0.209.1 schema:

- Client requests: `initialize`, `thread/start`, `thread/resume`, `turn/start` and
  `turn/interrupt`.
- Client notification: `initialized`.
- Consumed server notifications: `thread/started`, `turn/started`, `item/completed`,
  `thread/tokenUsage/updated` and `turn/completed`.

The ten server→client requests are identical to the ten that `headlessResponseFor`
handles. They are the approval, elicitation, permissions, tool-call, user-input,
token-refresh and attestation requests.

| Call | Params sent (all fields exist in the schema) |
| --- | --- |
| `initialize` | `{clientInfo:{name,version}, capabilities:{experimentalApi:false}}`. The result includes `codexHome` (= `~/.trae`) |
| `thread/start` | `{cwd, approvalPolicy:"never", sandbox}` |
| `thread/resume` | `{cwd, approvalPolicy:"never", sandbox, threadId}`, **without** `excludeTurns` |
| `turn/start` | `{threadId, cwd, approvalPolicy:"never", sandboxPolicy, input:[{type:"text",text,text_elements:[]}]}` |
| `turn/interrupt` | `{threadId, turnId}` |

### Permission mapping (identical to Codex)

| Daemon mode | `sandbox` (SandboxMode) | `sandboxPolicy` (SandboxPolicy) | `approvalPolicy` |
| --- | --- | --- | --- |
| `yolo` | `danger-full-access` | `{type:"dangerFullAccess"}` | `never` |
| `chorus` | `read-only` | `{type:"readOnly", networkAccess:false}` | `never` |

- Schema enums: SandboxMode is `read-only | workspace-write | danger-full-access`.
  AskForApproval includes `never`. SandboxPolicy types are
  `dangerFullAccess | readOnly | externalSandbox | workspaceWrite`. `readOnly` has
  `networkAccess`.
- Live check: in yolo posture, the `thread/start` response echoed
  `sandbox:{type:"dangerFullAccess"}` and `approvalPolicy:"never"`. The turn completed
  without any server request. The chorus-posture resume turn also completed.

## Differences from Codex 0.157.1 that Chorus handles

1. **`excludeTurns` is experimental on TRAE.** `thread/resume` with `excludeTurns:true`
   returns `-32600 "thread/resume.excludeTurns requires experimentalApi capability"`.
   Chorus does not opt into experimental APIs, so the TRAE profile sets
   `resumeExcludeTurns:false` and omits the field. The resume response then includes
   prior turns (one turn here, about 2.8 KB). These responses are ignored and fall under
   the existing 32 MiB frame limit. The rejection is deliberately not classified as
   "history unavailable", so no silent fallback happens.
2. **History-unavailable error text matches Codex exactly:**
   `-32600 "no rollout found for thread id <id>"`. The existing narrow fallback to
   `thread/start` and its one-time notice apply unchanged.
3. **The cache-write counter is spelled `cacheCreationInputTokens`** in
   `TokenUsageBreakdown` (Codex spells it `cacheWriteInputTokens`). The events adapter
   reads it as an alias only when the Codex field is absent, so Codex is unaffected.
   `inputTokens` includes cached reads and writes, as on Codex, so exclusive input is
   `input - cached - cacheCreation`.
4. **Thread and turn ids are time-ordered UUID-shaped strings** (e.g.
   `01a135e0-89f8-74d3-…`). They still match the spawner's `8-4-4-4-12` display check.
5. **No `thread/started` notification on resume.** The authoritative `thread/resume`
   response carries the id. A restored `thread/tokenUsage/updated` for the *previous* turn
   id arrives before `turn/started`. The adapter's turn-id filter drops it.
6. **`TurnStartParams` lacks some optional Codex fields.** Chorus does not send them.

## Local state (separate from Codex)

| | Codex | TRAE CLI |
| --- | --- | --- |
| Session map | `~/.chorus/codex-sessions.json` | `~/.chorus/trae-sessions.json` |
| Usage map | `~/.chorus/codex-usage.json` | `~/.chorus/trae-usage.json` |
| Wake-error source / clientType | `codex` | `trae` |

Because the files are separate, a Codex thread id is never resumed on TRAE and a TRAE
thread id is never resumed on Codex. The same holds for usage baselines.

## Daemon `-c` denylist

TRAE reuses the Codex `-c` denylist (`mcp_servers`, `sandbox*`, `approval_policy`,
`approvals_reviewer`, `cwd`, `permissions`, instruction keys, etc.) and adds
`permission_mode`, which appears in the binary's config keys. Protected TRAE-only
switches are `--permission-mode`, `-y/--dangerously-bypass-approvals-and-sandbox`,
`-w/--worktree*`, `--session-id`, `--session-source`, `--acp`, `--stdio`, `--no-daemon`
and `--allowed-tool/--disallowed-tool/--disabled-tool`.

## Re-verification on a version bump

```sh
traecli --version
traecli app-server generate-json-schema --out /tmp/trae-schema
# diff the field sets against cli/__tests__/fixtures/trae-app-server/schema-fields-<ver>.json
# re-check: excludeTurns acceptance, history error text, TokenUsageBreakdown names
```
