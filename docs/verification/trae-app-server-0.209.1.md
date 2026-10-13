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

## Live end-to-end checkpoint (2026-10-14)

Tasks 1–4 of `add-trae-cli-backend` were exercised together on Linux x86_64 with
**traecli 0.209.1** and **codex-cli 0.162.1**, from the branch source
(`node chorus.mjs …` at `42f4f22f`). Everything was isolated from the real `~/.trae`,
`~/.codex` and `~/.chorus`:

- `HOME=~/.cache/chorus-trae-e2e/home` and `TRAE_HOME=$HOME/.trae`. Only the model
  provider was copied from `~/.trae/traecli.toml`.
- `CHORUS_MARKETPLACE_SOURCE_TRAE=<repo root>`, so the branch plugin with the hook
  dispatcher was installed.
- Served cwds were `~/dev/zz-chorus-{trae,codex}-e2e-work`. They sort after the
  existing daemon's cwd, so un-pinned wakes never narrowed to the test connections.
- **Server:** the running local deployment image predated task 2, so it did not
  register `clientType=trae`. The daemon connected but never logged
  `registered as connection`, and it printed no warning. The test therefore ran
  `next dev --port 18640` from the branch, with `REDIS_URL` empty, against the same
  database. Wakes created on that instance stayed on it.
- Wakes were triggered with the agent's own key through `POST /api/ideas/conversational`
  (idea-anchored root session pinned to the test connection), then
  `POST /api/daemon-sessions/{uuid}/instruction`, `POST /api/daemon-sessions/ad-hoc`
  and `POST /api/daemon/control`. These are all directed to one connection. Notification
  wakes (mentions or assignments) cannot be self-triggered, because the actor is
  excluded from recipients.

### `chorus agents add --agents trae --yes`

- The plugin was installed (`traecli plugin list` → `chorus@chorus-plugins`). The cache
  was `$TRAE_HOME/plugins/cache/chorus-plugins/chorus/0.22.1/`, and its `hooks.json`
  commands use `run-hook.sh <name>`.
- `[mcp_servers.chorus]` was written with `url` and
  `bearer_token_env_var = "CHORUS_API_KEY"`. There is no key in the toml, and
  `traecli.toml.chorus-bak` was created.
- `$TRAE_HOME/.env` (0600) got `CHORUS_URL`, `CHORUS_API_KEY` and `CHORUS_AGENT_PROFILE`.
- The App Server restart was deferred (`--yes` does not authorize a restart), as designed.

**Interactive session:** `traecli --dangerously-bypass-hook-trust` ran in tmux, with
`CHORUS_*` **unset** in the shell, so the credentials came only from `.env`.

- `SessionStart hook (completed)`, with the context headed
  `# Chorus Plugin — Active (TRAE port)`. It carried the checkin JSON (agent Clay
  `00fc5c33-…`) and skill paths under the TRAE plugin cache.
- The model listed all 17 `chorus:*` skills.
- `chorus.chorus_checkin` was called successfully. Interactive TRAE asks for one MCP
  approval per tool unless the user picks "Always allow".

### `chorus daemon` with a `trae` agent (yolo)

| Step | Result |
| --- | --- |
| Wake 1: conversational idea → `idea_creation_requested` | `deliver_turn` → `▶ wake` → `backend started new session` → `✓ wake done (exit=0, 37 s)`. `chorus_edit_idea` set the title, and `e2e-yolo.txt` was written (yolo can edit files). The transcript was uploaded and visible in `GET /api/daemon-sessions/{uuid}`. Turn usage: `source:"trae"`, `cacheCreationTokens:20657` (the `cacheCreationInputTokens` alias works) |
| Wake 2: instruction on the same session | `backend resumed session`. `~/.chorus/trae-sessions.json` maps idea → `01a13628-862b-…`, and turns 1 and 3 both carry that `backendSessionId`. The model answered from the earlier turn ("e2e-yolo.txt: yolo-ok") without tools |
| Wake 3: `sleep 300`, then `POST /api/daemon/control {command:"interrupt", entityType:"idea"}` | `control: interrupting running subprocess … (pid=…)` → `exited non-zero (130)` → turn `interrupted` (`interruptedReason:"user"`). Afterwards no `traecli app-server` or `sleep 300` process was left |

The first wake-2 attempt failed with `DirectoryDiscoveryError: OUTSIDE_ROOT`. This is a
setup artifact: with an isolated `HOME`, the default browse root (`$HOME`) did not contain
the served cwd, and the session's `runtimeCwd` is validated against browse roots. With
`--browse-root <cwd>` it passed. This is general daemon behavior, not TRAE-specific: a
served `--cwd` outside every browse root cannot be resumed with a stored runtime cwd.

### `--chorus-only` (read-only posture)

- A file write was rejected:
  `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`.
  No file was created.
- **Gap:** Chorus MCP calls were also rejected:
  `MCP tool call requires approval, but approval policy is never`. In the read-only
  sandbox TRAE gates MCP tools on approval, and `approvalPolicy:"never"` turns that into
  a refusal.
- **Codex 0.162.1 behaves the same** (live wake, same messages), so this is an existing
  Codex-family gap, not a TRAE regression.
- Adding `default_tools_approval_mode = "approve"` to `[mcp_servers.chorus]` (an
  `AppToolApproval` value; others are `prompt` and `writes`) made `chorus_get_idea`
  succeed in read-only posture, while writes stayed blocked. This was tested only in the
  isolated `traecli.toml` and then reverted.
- Follow-up: have the daemon pass this for the chorus posture, for example
  `-c mcp_servers.chorus.default_tools_approval_mode="approve"`, only when
  `[mcp_servers.chorus]` exists. Verify the same on Codex.

### Plugin refresh

`upgradePlugins()` (the function `chorus upgrade --plugins` calls, `cli/upgrade.mjs`) was
run directly against the isolated `daemon.json`. That skipped the npm-global CLI upgrade
the real command would attempt. Result:
`[{"target":"trae (agents[0])","complete":true,"changed":true,"detail":"Chorus plugin refreshed."}]`.
A new `0.22.1+reinstall.…` cache dir appeared, and `traecli.toml.chorus-upgrade.bak` was
written.

### Codex regression

There was one live wake with a `codex` agent (`--chorus-only`, isolated `CODEX_HOME`)
through an ad-hoc session: `backend started new session`, then `✓ wake done (exit=0)`. The
transcript was uploaded, and usage had `source:"codex"` and `cacheCreationTokens:16239`
(the Codex `cacheWriteInputTokens` field is still read). Codex tests passed: 19 files /
489 tests for `cli/__tests__/{codex-*,init-codex*,trae-*,init-trae*,spawner-select,upgrade*}`.
