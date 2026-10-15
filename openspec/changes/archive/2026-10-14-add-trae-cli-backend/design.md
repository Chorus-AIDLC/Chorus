# Design: TRAE CLI (traecli) backend and plugin target

## Context

TRAE CLI 2 (`traecli`, 0.209.1 locally; binary `~/.local/share/traecli/current/traex`, symlinked as `traecli` / `trae-cli` / `trae-agent`) is a fork of Codex. Its plugin loader is the `codex_core_plugins` module. Requester decisions from elaboration:

| Decision | Choice |
|---|---|
| Scope | Plugin + daemon backend (full) |
| Daemon transport | Reuse Codex App Server approach |
| Code shape | Parameterize the Codex backend (shared implementation) |
| Plugin distribution | Reuse the Codex plugin package + marketplace as-is |
| Incompatible hooks | Fork a TRAE-specific copy; leave shared Codex scripts unchanged |
| Headless permissions | Follow the daemon permission mode (same mapping as Codex) |
| Advertising | Public: menus, docs, landing page |

### Verified facts (local probes, 2026-10-13)

- **Plugin:** `TRAE_HOME=<tmp> traecli plugin marketplace add <repo-root>` reads `.agents/plugins/marketplace.json`. `traecli plugin install chorus@chorus-plugins --yes` installs to `$TRAE_HOME/plugins/cache/chorus-plugins/chorus/<version>`. `plugin validate chorus` reports 17 skills and 4 hooks. `traecli.toml` gains `[marketplaces.chorus-plugins]` (`source_type`, `source`, `last_updated`) and `[plugins."chorus@chorus-plugins"] enabled = true`.
- **Plugin sources:** local / marketplace / git / tarball. Marketplace entries support `Local | Url | GitSubdir`. **No npm source.** Accepted plugin roots: `traecli.yaml`, `coco.yaml`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`. Marketplace discovery also knows `.trae-plugin/marketplace.json` and `.coco-plugin/marketplace.json`.
- **App Server:** `traecli app-server --listen stdio://` completed `initialize` (`codexHome` = `~/.trae`), `initialized`, `thread/start {cwd, approvalPolicy:"never", sandbox:"read-only", ephemeral:true}`, and `turn/start {threadId, cwd, approvalPolicy:"never", sandboxPolicy:{type:"readOnly",networkAccess:false}, input:[{type:"text",text,text_elements:[]}]}`. It streamed `thread/started`, `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed` (agentMessage), and `turn/completed` (status `completed`). Every method the Codex client and spawner use is present in `traecli app-server generate-json-schema`. `ThreadStartParams` / `ThreadResumeParams` field sets match Codex. `TurnStartParams` lacks some optional Codex-only fields that we do not send.
- **Hooks:** the hook runner recognizes `PLUGIN_ROOT` (and `CLAUDE_PLUGIN_ROOT`). Events include SessionStart, PostToolUse, Stop, etc.
- **Env:** `TRAE_HOME` (also `TRAECLI_HOME`) overrides `~/.trae`. traecli also has `TRAE_CLI` and Codex-legacy env names.

### Unverified (must be checked during implementation)

1. Whether `[mcp_servers.chorus]` with `bearer_token_env_var = "CHORUS_API_KEY"` authenticates under traecli.
2. Whether traecli loads `$TRAE_HOME/.env` (Codex loads `~/.codex/.env`) and filters key prefixes.
3. Whether hooks actually fire in interactive and headless App Server sessions, and the exact SessionStart stdin and `additionalContext` contract.
4. Whether `traecli app-server daemon restart` mirrors Codex's restart, if a restart step is wanted.
5. A reliable runtime marker that distinguishes TRAE from Codex inside a hook (candidate: `TRAE_CLI` env var).

## Goals / Non-Goals

**Goals:** a first-class `trae` backend that inherits Codex behavior through one shared implementation; a `chorus agents add` TRAE adapter reusing the Codex plugin package; TRAE-correct hooks; public docs and UI.

**Non-Goals:** ACP or `exec --json` transports; a separate TRAE plugin directory or manifest; npm/tarball plugin distribution; supporting TRAE's legacy `traecli.yaml` / `coco.yaml` config; bundling traecli.

## Decisions

### D1. Codex-family profile

Introduce `cli/codex-family.mjs` exporting frozen profiles:

```js
export const CODEX_FAMILY = {
  codex: { agentType: "codex", displayName: "Codex", binaries: { posix: ["codex"], win32: ["codex.cmd","codex.exe","codex"] },
           pathEnv: "CHORUS_CODEX_PATH", homeEnv: "CODEX_HOME", homeDir: ".codex", configFile: "config.toml",
           sessionMapFile: "codex-sessions.json", usageMapFile: "codex-usage.json", wakeErrorSource: "codex",
           clientType: "codex", marketplaceSourceEnv: "CHORUS_MARKETPLACE_SOURCE_CODEX" },
  trae:  { agentType: "trae", displayName: "TRAE CLI", binaries: { posix: ["traecli"], win32: ["traecli.cmd","traecli.exe","traecli"] },
           pathEnv: "CHORUS_TRAE_PATH", homeEnv: "TRAE_HOME", homeDir: ".trae", configFile: "traecli.toml",
           sessionMapFile: "trae-sessions.json", usageMapFile: "trae-usage.json", wakeErrorSource: "trae",
           clientType: "trae", marketplaceSourceEnv: "CHORUS_MARKETPLACE_SOURCE_TRAE" },
};
```

`CodexSpawner` takes `opts.profile` (default `CODEX_FAMILY.codex`). Every hard-coded Codex value in `codex-spawner.mjs` reads from the profile: `hasChorusMcpServer` path, `resolveCodexPath` → `resolveFamilyPath(profile)`, `wakeErrorSource`, `validateAgentCliConfig` backend key, log/notice/error text (`${profile.displayName}`), the session map, the usage map, and the stdio-settle label. `codex-app-server-client.mjs` / `-events.mjs` stay generic. Only error-prefix text takes the display name. `spawner-select.mjs` adds `if (agentType === "trae") return new CodexSpawner({ ...opts, profile: CODEX_FAMILY.trae })`. The existing exported names (`resolveCodexPath`, `buildCodexArgs`) remain as Codex-profile wrappers so current imports and tests do not change.

*Alternative rejected:* a subclass `TraeSpawner extends CodexSpawner`. It still needs the same seams, and requester chose parameterization.

### D2. Session and usage maps

`codex-session-map.mjs` already uses the `createSessionMap` factory. Add `trae-session-map.mjs` (or a profile-keyed factory call) writing `~/.chorus/trae-sessions.json`. Refactor `codex-usage-map.mjs` to accept a file name so TRAE uses `~/.chorus/trae-usage.json`. Separate files guarantee Codex and TRAE thread ids never cross (spec: separate anchoring).

### D3. CLI args / agent-cli-config

`agent-cli-config.mjs` keys managed flags, the denylist, `SUBCOMMANDS` and model aliases by backend. Register `trae` as an alias of the `codex` rules: same `-c` parser and same managed-key denylist (`mcp_servers|sandbox|approval_policy|…`). This applies only where traecli flags match. Verify each flag against `traecli app-server --help` / `traecli exec --help` (`-c`, `--enable/--disable`, `-m` exist; `--permission-mode` is exec-only and is **not** used — posture is applied by RPC as with Codex).

### D4. Agent-type registration (single edits, kept in sync)

- `cli/daemon-agent.mjs`: `KNOWN_AGENTS` += `trae`; `backendCli.trae = { name: "traecli", envVar: "CHORUS_TRAE_PATH" }`; `backendClientType.trae = "trae"`.
- `cli/client-args.mjs`: keep an explicit accepted set and add `trae` (and the already-shipped `pi`). Do **not** import `daemon-agent.mjs`'s `KNOWN_AGENTS` wholesale, because that would also start accepting `offline`. Expected set after the change: `claude-code, codex, kiro, dsh, pi, trae`. Update help text.
- `cli/agent-backend-prompt.mjs` `AGENT_MENU` += `{ value: "trae", label: "TRAE CLI" }` (shared menu → spec delta).
- `cli/daemon.mjs` / `cli/daemon-install-config.mjs`: probe ternaries → a `findAgentCli(agentType)` lookup that covers `trae` via `resolveFamilyPath`.
- `cli/agent-launcher.mjs` `TYPE_TO_BINARY.trae = "traecli"`; `cli/agents.mjs` removal note for `~/.trae`; Note: the `cli/upgrade-plugins.mjs` TRAE host + installer wiring belongs to D5 (task 3), because it needs `installCodexFamily`.
- `cli/wake-error.mjs` `SOURCES` and `src/lib/daemon-wake-error.ts` `WAKE_ERROR_SOURCES` += `trae`; `src/services/daemon-connection.service.ts` `DAEMON_CLIENT_TYPES` += `trae`; `cli/upload-hooks.mjs` usage source becomes profile-driven.
- `src/components/agent-presence/hooks.ts` `case "trae"` → `t("agentConnections.clientTrae")`.

`clientType` is a free String column, so **no Prisma migration** is needed.

### D5. `chorus agents add` TRAE adapter

- `cli/init/adapters.mjs`: `{ id: "trae", displayName: "TRAE CLI", binaries: ["traecli","trae-cli"], configDirs: ["~/.trae"], readState: readTraeInstallState, install: installTrae }`; `agent-type-map.mjs` `trae → "trae"`.
- `install-methods.mjs`: generalize `readCodexInstallState` / `installCodex` into `readCodexFamilyInstallState(profile)` / `installCodexFamily(profile, ctx)`. The TRAE command differences are `traecli plugin install chorus@chorus-plugins --yes` (Codex uses `plugin add … --json`) and `traecli plugin marketplace upgrade chorus-plugins`. Back up `traecli.toml` before mutation.
- `codex-mcp-config.mjs`: `resolveCodexConfigPath` / `writeCodexMcpServer` take `{ homeEnv, homeDir, configFile }` from the profile. The written block stays keyless (`bearer_token_env_var = "CHORUS_API_KEY"`). **Gate:** verify unknown #1 with a real `traecli` MCP call before finishing. If env-var bearer is unsupported, use TRAE's supported keyless mechanism and update the spec first.
- `steps/credential-seed.mjs`: the Codex `.env` writer becomes profile-aware (`$TRAE_HOME/.env`), **only if** unknown #2 confirms traecli loads it. Otherwise, print an explicit `export CHORUS_API_KEY=…` hint for interactive TRAE use (daemon wakes always get the key via env).
- `cli/upgrade-plugins.mjs`: `HOSTS.trae = { binary: "traecli", variable: "TRAE_HOME", dir: [".trae"] }`, and the installer map routes `trae` to `readCodexFamilyInstallState(CODEX_FAMILY.trae)` / `installCodexFamily(CODEX_FAMILY.trae, …)`, so a Chorus upgrade refreshes the TRAE plugin (marketplace upgrade + reinstall).
- Restart step: `steps/codex-restart.mjs` is generalized only if unknown #4 holds. Otherwise TRAE skips it and the summary says why.

**Resolved (unknowns #1, #2, #4 — probed on traecli 0.209.1 with an isolated `TRAE_HOME` under `~/.cache`):**
- **#1 MCP env-var bearer: works.** With `[mcp_servers.chorus] url=…/api/mcp, bearer_token_env_var="CHORUS_API_KEY"` in `traecli.toml`, app-server `mcpServerStatus/list` reports `authStatus: "bearerToken"` and lists the Chorus tools (83) when the var is set, and 0 tools without it. The keyless Codex block is reused unchanged via `resolveFamilyConfigPath(env, CODEX_FAMILY.trae)`.
- **#2 `$TRAE_HOME/.env`: loaded.** With the key only in `$TRAE_HOME/.env` (unset in the shell), MCP still authenticates. The vars reach child processes (app-server `command/exec`), and the file **overrides** a conflicting shell export, the same as Codex. So the credential-seed `.env` writer is profile-aware (`codexFamilySelection("trae")` → `$TRAE_HOME|~/.trae/.env`) and suppresses the export hint. The outcome is tagged `codexEnvAgentId` so each fork's restart step checks its own write.
- **#4 `traecli app-server daemon restart`: mirrors Codex.** `start`, `version` (`{"status":"running",…}`), `restart` (`{"status":"restarted",…}`) and `stop` all behave like Codex. `codex-restart.mjs` is generalized by profile (binary, `TRAE_HOME`, usage regex, display name). One difference: with no daemon running, `traecli … version` exits 1 ("failed to connect to …app-server-control.sock") instead of printing a stopped status. The step then defers ("daemon state could not be determined") and never starts a daemon.
- **Plugin CLI (from `traecli plugin --help` plus live runs):** a second `marketplace add` on an already-registered marketplace is a no-op success. `plugin install … --yes` reinstalls into a fresh `<version>+reinstall…` cache dir. `marketplace upgrade chorus-plugins` exits 1 with "is not configured as a Git marketplace" for a local-path source. TRAE (only) treats that error as a no-op, so a dev/local `CHORUS_MARKETPLACE_SOURCE_TRAE` still refreshes. The Git source (`Chorus-AIDLC/Chorus`) upgrades normally.

### D6. Hook compatibility (shared scripts, runtime-detected wording)

Both CLIs install the **same** plugin package and the same `hooks.json`, and both run the **same** `hooks/*.sh` scripts. There are no TRAE copies and no dispatcher.

- `hooks.json` commands stay byte-identical to the pre-change Codex commands (`${PLUGIN_ROOT}/hooks/<name>.sh`), so Codex users need no hook re-trust.
- The shared helper `hooks/hook-runtime.sh` (sourced, Bash 3.2 compatible) provides:
  - `chorus_hook_runtime <hooks-dir>`, which prints `trae` or `codex`. Marker: the plugin root (`PLUGIN_ROOT`, or `<hooks-dir>/..` when unset) resolves, via `pwd -P`, inside `${TRAE_HOME:-$HOME/.trae}/plugins/`. Otherwise the result is `codex`, the default. `CHORUS_HOOK_RUNTIME=trae|codex` forces the choice for tests and manual runs.
  - `chorus_event_uuid <event> <field>`, which takes the entity UUID from the `tool_response` `content[0].text` JSON. `tool_response` may be an object or a JSON-encoded string, and the nested `post_tool_use.tool_response` is also accepted. It then falls back to `tool_input.<field>` and `post_tool_use.tool_input.<field>`. No input shape can abort the filter.
- Wording that differs per runtime: the SessionStart banner ("Codex port" / "TRAE port"), the SessionStart skills/reviewer lines, and the reviewer spawn guidance in the three PostToolUse hooks (`spawn_agent` / `wait_agent` / `close_agent` on Codex; the `Agent` tool plus a Skill-load prompt on TRAE). Everything else is shared.
- SessionStart skill routing uses `${PLUGIN_ROOT}/skills/<name>/SKILL.md` (falling back to the script's own plugin root), which is valid for both installs. This replaces the stale Codex `~/.codex/skills/...` paths.
- Shared bug fixes that apply to Codex too: the object/string `tool_response` parsing above, and the unescaped `` `done` `` in the `on-post-verify-task.sh` Branch C heredoc. Under bash it ran as a command substitution and wrote a syntax error to stderr on every code-review reminder.
- Two more shared fixes, found in the live probes: (1) `on-post-verify-task.sh` asked `chorus_list_tasks` / `chorus_get_documents` for `pageSize: 200`. The MCP maximum is 100, so every call failed and the code-review and completion-report reminders never fired on either CLI. It now asks for 100 and keeps the `total > returned` guard. (2) Codex 0.162.1 rejects a `spawn_agent` skill item without `name` (`missing field \`name\``). The SessionStart and Branch C examples lacked it and now include it.
- Tests: `hooks/tests/test-shared-hooks.sh` covers runtime detection, and runs SessionStart and every PostToolUse hook under both runtimes and every `tool_response` shape, with a no-stderr check. The existing `test-session-start.sh`, `test-subagent-contract.sh` and `cli/__tests__/codex-session-start-hook.test.mjs` cover the Codex defaults.

*Alternatives rejected:* (1) patching the installed plugin cache under `~/.trae/plugins/cache`, because a marketplace upgrade overwrites it; (2) a `hooks/run-hook.sh` dispatcher plus `hooks/trae/` copies. That was the first implementation. It changed the `hooks.json` commands, which forced every Codex user to re-trust the hooks, and it duplicated about 500 lines of hook script that would drift.

**Resolved (unknowns #3, #5 — probed on traecli 0.209.1 with an isolated `TRAE_HOME`):**
- traecli exports **no** TRAE-specific env var to hook processes (no `TRAE_CLI`, and `TRAE_HOME` is not exported either). It exports `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. `PLUGIN_ROOT` is the canonical (symlink-resolved) path `<trae-home>/plugins/cache/<marketplace>/chorus/<version>[+reinstall…]`, hence the marker above. Codex 0.162.1 also exports `PLUGIN_ROOT` to hook processes, pointing under `${CODEX_HOME:-~/.codex}/plugins/cache/`, so it never matches the TRAE marker.
- SessionStart stdin is Codex-shaped (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source`). Hooks run only when trusted, or with `--dangerously-bypass-hook-trust`.
- PostToolUse: `tool_name` is `mcp__chorus__<tool>`, so the existing matchers work. The hook fires only on success; failed calls raise `PostToolUseFailure`. The top-level `tool_response` is sometimes a **JSON-encoded string** (seen for code-mode/nested calls) and sometimes an object (direct calls). There is also a nested `post_tool_use.{tool_name,tool_input,tool_response}`. With the old Codex `jq` filter, the string shape raised an error that also killed the `tool_input` fallback, so the UUID was lost. TRAE has no `spawn_agent`; its sub-agent tool is `Agent` (plus `Skill` and `SendMessage`).
- `chorus-mcp-call.sh` works unchanged (the server ignores clientInfo).

### D7. Docs and UI (public)

- `AgentInstallGuide.tsx`: TRAE tab (`chorus agents add --agents trae`, `chorus daemon --agent trae`), using shadcn components and semantic tokens. Check light and dark.
- `messages/{en,zh}.json` (and the existing `ja`/`ko` files, to keep locale parity): `install.tabs.trae`, `install.trae.*`, `agentConnections.clientTrae`.
- Add `docs/CONNECT_TRAE.md` and `.zh.md`; update `docs/DAEMON.md`, README / README.zh / ja / ko, landing `Integration.astro` plus translations, and the supported-agent lists in **both** `public/skill/` and `public/chorus-plugin/skills/chorus/` (including `public/chorus-plugin/skills/chorus-cli/SKILL.md`'s agent → binary list), plus `plugins/chorus/skills` where agents are listed.
- `docs/design.pen`: updating the install-guide screen via Pencil MCP is **required** by CLAUDE.md. If the Pencil tools are unavailable in the implementing session, the task stays blocked and is escalated to the requester; it is not marked done.

### D8. Chorus-only posture pre-approves only the Chorus MCP server (Codex and TRAE)

**Problem (Live E2E findings).** In chorus posture both App Servers run `sandbox: "read-only"` with `approvalPolicy: "never"`. The read-only sandbox gates every MCP tool on approval, and `never` turns that into a refusal (`MCP tool call requires approval, but approval policy is never`). A `--chorus-only` wake could therefore do no Chorus work. This D8 supersedes the "follow-up" note in Live E2E findings: the fix lands in this change, for Codex and TRAE together, because they share one spawner.

**Decision.** In chorus posture only, when the user's family config (`$CODEX_HOME|~/.codex/config.toml` or `$TRAE_HOME|~/.trae/traecli.toml`) declares `[mcp_servers.chorus]`, `CodexSpawner` adds one per-thread override to `thread/start` and `thread/resume` (including the history-unavailable fallback `thread/start`):

```js
config: { "mcp_servers.chorus.default_tools_approval_mode": "approve" }   // CHORUS_MCP_APPROVAL_CONFIG, codex-family.mjs
```

- `turn/start`, `sandbox`, `sandboxPolicy` and `approvalPolicy` are unchanged, so writes stay blocked. Server→client approval requests are still declined by `headlessResponseFor`.
- Nothing else is approved. Other MCP servers keep the default approval mode and stay refused. Shell, file-change and permission approvals are unaffected.
- The override is never written to the user's config file. It lives only in the RPC frame for that thread.
- Yolo posture sends no `config`, so it is byte-identical to before.
- The `[mcp_servers.chorus]` probe (`hasChorusMcpServer`, an exact-header regex) now gates the override. It was diagnostic only before. Yolo still probes once per spawner. Chorus posture re-probes on every wake, because an override under an undeclared server makes `thread/start` fail with `-32600 failed to load configuration: invalid transport in mcp_servers.chorus`. The missing-config warning is still logged once. A config that declares the server some other way (an inline table) is not detected. Such a wake gets no pre-approval and behaves as before, which fails safe.
- The user cannot set this key through daemon `-c` args, because `mcp_servers*` is already on the managed-key denylist (D3).

**Verification (2026-10-14, codex-cli 0.162.1 and traecli 0.209.1, isolated `HOME` under `~/.cache`).** The full record is in `docs/verification/trae-app-server-0.209.1.md` § "Chorus-only MCP pre-approval (D8)", and the extracted schema facts are in `cli/__tests__/fixtures/codex-family-mcp-approval.json`.
- Schema: in both `generate-json-schema` outputs, `ThreadStartParams.config` and `ThreadResumeParams.config` are `{type: object|null, additionalProperties: true}`, so the key itself is not typed. The value enum `AppToolApproval` is `auto | prompt | writes | approve` in both.
- Live: both servers validate the key. A bogus value fails `thread/start` with `unknown variant … in mcp_servers.chorus.default_tools_approval_mode`. The dotted key merges into the declared table rather than replacing it: the pre-approved `chorus_checkin` call reached the server through the configured `url` and env bearer.
- Live A/B in read-only posture, with a second stdio MCP server `echo` as a control: without the override, both `chorus_checkin` and `echo_ping` are refused. With it, `chorus_checkin` succeeds, `echo_ping` is still refused and `printf x > file` fails on the read-only file system, on both CLIs.
- Real `CodexSpawner` wakes (via `selectSpawner`, `permissionMode: "chorus"`, the same construction `chorus daemon --chorus-only` uses), for `codex` and `trae`: a new wake and then a resumed wake of the same thread. Both called Chorus tools successfully (`chorus_checkin`, then `chorus_get_notifications` after resume). The `echo` server was refused, and the write was refused in both wakes.

*Alternatives rejected:* the `-c mcp_servers.chorus.default_tools_approval_mode=…` argv flag. It is process-wide rather than per-thread, it would have to bypass our own `-c` denylist, and it would also apply in yolo. Writing the key to the user's TOML is forbidden. `approvalPolicy: "on-request"` with auto-accepting MCP elicitations would let the adapter grant native approval requests and could reach other servers.

## Module Contracts

- `CODEX_FAMILY[profileKey]` is the only source of TRAE/Codex names, paths and env vars for **runtime spawn, path resolution, config read/write and install logic**. Static registries that already list each backend's literals (`backendCli`, `TYPE_TO_BINARY`, `AGENT_MENU`, the `adapters.mjs` descriptor, `upgrade-plugins` `HOSTS`) may keep their literal entries but must match the profile values; a unit test asserts the match. Tests and docs are exempt.
- `new CodexSpawner({ profile })` implements the existing `Spawner.wake` contract unchanged; `spawner-select` is the only place that maps `agentType` → profile.
- `installCodexFamily(profile, ctx)` returns the existing adapter outcome shape `{ agent, action, detail, codexMcpWritten }`. The field name is kept for compatibility; `init.mjs` treats it as "family MCP written".
- Wake-error source and clientType string = `profile.clientType`. CLI and server enums must both include `trae` (server tests enforce it).

## Implementation Plan

1. Profile + spawner + maps + cli-config (D1–D3), with Codex regression tests green.
2. Agent-type registration CLI + server (D4).
3. `agents add` TRAE adapter and upgrade-plugins wiring (D5), including verification of unknowns 1, 2 and 4.
4. Shared hook scripts with runtime-detected wording (D6), including unknowns 3 and 5. The first implementation used a dispatcher plus TRAE copies; it was replaced per the requester's decision.
5. Docs/UI (D7).
6. Live end-to-end checkpoint on a real `traecli` with an isolated `TRAE_HOME`.

## Risks / Trade-offs

- **Fork drift:** TRAE may diverge from the Codex protocol. Mitigation: commit a `docs/verification/trae-app-server-<version>.md` baseline and schema-checked fixtures, and include the minimum tested version in error text.
- **Hook marker ambiguity:** if no reliable marker exists, TRAE falls back to the shared Codex script (still functional, with Codex-worded routing). This is documented as a limitation rather than guessed.
- **MCP auth form:** if env-var bearer is unsupported, the keyless guarantee may need a different mechanism. That is blocked on verification, never solved by writing the secret to `traecli.toml`.
- **Refactor blast radius on Codex:** mitigated by keeping exported Codex names and running the full existing Codex test suite unchanged.

## Live E2E findings (task 6, 2026-10-14)

Details are in `docs/verification/trae-app-server-0.209.1.md` § "Live end-to-end checkpoint".

- D1–D6 behaved as designed on traecli 0.209.1, with no code changes. That covers the
  agents-add install, the keyless MCP plus `.env`, SessionStart through the (since removed) dispatcher,
  daemon wake, transcript upload, resume of the same thread, user interrupt, the yolo
  write, upgrade-plugins refresh, and Codex regression.
- **Gap shared with Codex (existing):** under `--chorus-only`, TRAE and Codex both refused Chorus MCP tool calls (`MCP tool call requires approval, but approval policy is never`), because the read-only sandbox gates MCP tools on approval. **Fixed in this change by D8**, at the requester's request: in chorus posture the per-thread config pre-approves only the Chorus MCP server.
- **Rollout order:** the server must include task 2 (`trae` in `DAEMON_CLIENT_TYPES`)
  before `chorus daemon` runs with a `trae` agent. Against an older server the daemon
  connects but is never registered, and it gives no warning.
