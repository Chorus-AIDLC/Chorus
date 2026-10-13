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

### D6. Hook compatibility (fork, do not alter Codex)

Both CLIs install the **same** plugin package and the same `hooks.json`. A TRAE-specific copy therefore needs a selection point that leaves Codex output byte-identical.

- Change only the affected `hooks.json` commands to a tiny dispatcher, `hooks/run-hook.sh <name>`. The dispatcher `exec`s `hooks/trae/<name>.sh` when a TRAE runtime marker is present and that copy exists. Otherwise it `exec`s the original `hooks/<name>.sh` with the same stdin, args and env, so Codex stdout/stderr/exit code are unchanged. The original Codex scripts are **not edited**.
- Runtime marker: resolve unknown #5 empirically, in this order: an env var traecli sets for hook processes (e.g. `TRAE_CLI`), then `PLUGIN_ROOT` living under `$TRAE_HOME|~/.trae/plugins/`. Bash 3.2 compatible.
- Known copy needed: `on-session-start.sh` → `hooks/trae/on-session-start.sh`, with skill routing paths pointing at the installed TRAE plugin skills (`$PLUGIN_ROOT/skills/<name>/SKILL.md`) instead of `~/.codex/skills/...` and a "TRAE port" banner. `chorus-mcp-call.sh` clientInfo and `on-post-verify-task.sh` `tool_response` parsing get copies only if probes show they break.
- Add shell tests: the dispatcher picks the TRAE copy under the marker, and Codex output is unchanged without it.

*Alternative rejected:* patching the installed plugin cache under `~/.trae/plugins/cache`. A marketplace upgrade overwrites it.

### D7. Docs and UI (public)

- `AgentInstallGuide.tsx`: TRAE tab (`chorus agents add --agents trae`, `chorus daemon --agent trae`), using shadcn components and semantic tokens. Check light and dark.
- `messages/{en,zh}.json` (and the existing `ja`/`ko` files, to keep locale parity): `install.tabs.trae`, `install.trae.*`, `agentConnections.clientTrae`.
- Add `docs/CONNECT_TRAE.md` and `.zh.md`; update `docs/DAEMON.md`, README / README.zh / ja / ko, landing `Integration.astro` plus translations, and the supported-agent lists in **both** `public/skill/` and `public/chorus-plugin/skills/chorus/` (including `public/chorus-plugin/skills/chorus-cli/SKILL.md`'s agent → binary list), plus `plugins/chorus/skills` where agents are listed.
- `docs/design.pen`: updating the install-guide screen via Pencil MCP is **required** by CLAUDE.md. If the Pencil tools are unavailable in the implementing session, the task stays blocked and is escalated to the requester; it is not marked done.

## Module Contracts

- `CODEX_FAMILY[profileKey]` is the only source of TRAE/Codex names, paths and env vars for **runtime spawn, path resolution, config read/write and install logic**. Static registries that already list each backend's literals (`backendCli`, `TYPE_TO_BINARY`, `AGENT_MENU`, the `adapters.mjs` descriptor, `upgrade-plugins` `HOSTS`) may keep their literal entries but must match the profile values; a unit test asserts the match. Tests and docs are exempt.
- `new CodexSpawner({ profile })` implements the existing `Spawner.wake` contract unchanged; `spawner-select` is the only place that maps `agentType` → profile.
- `installCodexFamily(profile, ctx)` returns the existing adapter outcome shape `{ agent, action, detail, codexMcpWritten }`. The field name is kept for compatibility; `init.mjs` treats it as "family MCP written".
- Wake-error source and clientType string = `profile.clientType`. CLI and server enums must both include `trae` (server tests enforce it).

## Implementation Plan

1. Profile + spawner + maps + cli-config (D1–D3), with Codex regression tests green.
2. Agent-type registration CLI + server (D4).
3. `agents add` TRAE adapter and upgrade-plugins wiring (D5), including verification of unknowns 1, 2 and 4.
4. Hook dispatcher + TRAE copies (D6), including unknowns 3 and 5.
5. Docs/UI (D7).
6. Live end-to-end checkpoint on a real `traecli` with an isolated `TRAE_HOME`.

## Risks / Trade-offs

- **Fork drift:** TRAE may diverge from the Codex protocol. Mitigation: commit a `docs/verification/trae-app-server-<version>.md` baseline and schema-checked fixtures, and include the minimum tested version in error text.
- **Hook marker ambiguity:** if no reliable marker exists, TRAE falls back to the shared Codex script (still functional, with Codex-worded routing). This is documented as a limitation rather than guessed.
- **MCP auth form:** if env-var bearer is unsupported, the keyless guarantee may need a different mechanism. That is blocked on verification, never solved by writing the secret to `traecli.toml`.
- **Refactor blast radius on Codex:** mitigated by keeping exported Codex names and running the full existing Codex test suite unchanged.
