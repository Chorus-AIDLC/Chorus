# Proposal: Add TRAE CLI (traecli) as a Chorus agent backend

## Why

Users run TRAE CLI 2 (`traecli`) next to Claude Code and Codex. Chorus cannot use it today: `chorus agents add` has no TRAE adapter, and the daemon cannot wake a `traecli` session. TRAE CLI is a Codex fork. Its App Server JSON-RPC protocol, plugin/marketplace system and `traecli.toml` layout match Codex closely, so we can support it fully at low cost by **parameterizing** the existing Codex backend instead of writing a new one.

Local evidence (traecli 0.209.1, verified 2026-10-13 on the requester's machine):

- `traecli plugin marketplace add <repo>` reads Chorus's existing Codex marketplace (`.agents/plugins/marketplace.json`). `traecli plugin install chorus@chorus-plugins` then loads all 17 skills and 4 hooks from `plugins/chorus/.codex-plugin/plugin.json` without changes. traecli has no npm plugin source; supported sources are local, marketplace, git and tarball.
- `traecli app-server --listen stdio://` accepts the same `initialize` → `initialized` → `thread/start` → `turn/start` sequence the Codex spawner sends. In a live probe it streamed `turn/started` / `item/completed` / `turn/completed` and answered a prompt. Every method the Codex client uses appears in traecli's generated JSON schema.
- Config lives under `~/.trae` (override: `TRAE_HOME`) in `traecli.toml`. After a plugin install it contains the same `[marketplaces.chorus-plugins]` / `[plugins."chorus@chorus-plugins"]` tables Codex writes. The hook runner exposes `PLUGIN_ROOT`.

## What Changes

- **Daemon backend `trae`**: a new agent type that wakes `traecli app-server --listen stdio://`, built on the existing Codex App Server spawner with a parameterized *Codex-family profile*: binary name / path override env, home dir + env var, config file name, display name, wake-error source, session-map namespace. Session anchoring, permission-mode → sandbox mapping, MCP-via-user-config + `CHORUS_URL`/`CHORUS_API_KEY` env, cancellation, transcript and token usage behave as they do for Codex.
- **Agent selection**: `trae` becomes a valid `--agent` / `agentType` value and appears in the shared backend menu (claude-code, codex, kiro, pi, **trae**).
- **`chorus agents add` TRAE adapter**: detects `traecli` / `~/.trae`. Installs the **existing Codex plugin package and marketplace** through `traecli plugin marketplace add` + `traecli plugin install chorus@chorus-plugins`, then writes a keyless `[mcp_servers.chorus]` block to `traecli.toml`, mirroring the Codex adapter. Idempotent with a backup. `chorus upgrade-plugins` refreshes it (marketplace upgrade + reinstall).
- **Hook compatibility**: hook scripts that turn out to be incompatible under traecli get a **TRAE-specific copy**. The shared Codex scripts stay unchanged (requester decision). The SessionStart routing text must point at TRAE's skill paths, not `~/.codex/skills`.
- **Advertise publicly**: README(s), docs, landing page and in-app install guide list TRAE CLI next to the other supported agents. Both locales are updated.

## Capabilities

### New Capabilities

- `daemon-trae-backend`: The daemon can wake TRAE CLI through its stdio App Server. Covers session anchoring, permission posture, MCP/env credentials, lifecycle bounds, headless request handling, transcript delivery, cancellation, and parity with Codex through a shared Codex-family profile.
- `trae-plugin-install`: `chorus agents add` installs the Chorus plugin surface and MCP connection into TRAE CLI by reusing the Codex plugin package. Covers TRAE-specific hook copies where needed.

### Modified Capabilities

- `daemon-agent-selection`: adds `trae` as a selectable backend.
- `daemon-add-agent-type`: the shared backend menu advertises `trae`.

## Impact

- **CLI (`cli/`)**: `codex-spawner.mjs` and related Codex modules (profile parameterization), `spawner-select.mjs`, agent-type registry/menu, `init/adapters.mjs`, `init/install-methods.mjs`, `init/codex-mcp-config.mjs` (target-file parameter), `upgrade-plugins.mjs`, session-map namespace, tests under `cli/__tests__/`.
- **Plugin (`plugins/chorus/`)**: only TRAE-specific hook copies, if a shared script proves incompatible. No new plugin directory or manifest.
- **Server/UI (`src/`, `messages/`)**: agent-type labels / install guide entries for TRAE (en + zh), with both themes checked.
- **Docs**: README*, `docs/`, landing page, skill docs (`public/skill/`, plugin skill) where the supported-agent list appears.
- **No DB schema change. No new dependency.** traecli must be installed by the user; Chorus does not bundle it.
- **Risk**: traecli is a moving fork. Protocol drift is limited by schema-verified field names and a minimum-version note. Error messages are TRAE-branded.
