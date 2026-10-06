## Why

Nous Research Hermes Agent is a long-running, self-hosted agent with its own messaging gateway, plugin system, MCP client and skills. Chorus already supports Claude Code, Codex, Kiro, Pi, dsh, OpenClaw and opencode, but a Hermes user today has no way to join the AI-DLC pipeline — no check-in, no Chorus skills, no reviewer agents, and no way for Chorus to assign work to a Hermes instance. Because Hermes already runs as an always-on gateway service, it can be scheduled online directly by a plugin (the OpenClaw model) without depending on the Node `chorus daemon`.

## What Changes

- Add `packages/chorus-hermes/` to the monorepo with two installable directories:
  - `chorus/` — a **native Hermes plugin** (`plugin.yaml` + Python `register(ctx)`) carrying lifecycle hooks, a packaged copy of the Chorus skills, three read-only reviewer workflows, a `chorus` gateway platform adapter, and a Chorus-backed approval transport.
  - `chorus-mcp/` — a **portable Agent Plugin** (`plugin.json` + `mcp.json`) that declares the Chorus MCP server over streamable HTTP with `Authorization: Bearer ${CHORUS_API_KEY}`. Required because native `plugin.yaml` plugins cannot ship MCP servers (Hermes only loads `mcp.json` from portable packages, `hermes_cli/plugins_discovery.py:164-180`).
- **Distribution**: Hermes-native git-subdirectory install pinned to a Chorus release tag. Hermes `--ref` accepts only a full 40-character commit SHA (`hermes_cli/plugins_cmd_git.py:103-107`), so the tag `v<version>` is first resolved to its peeled commit SHA (`git ls-remote https://github.com/Chorus-AIDLC/Chorus.git 'refs/tags/v<version>^{}'`), then installed with `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/<dir> --ref <sha> --enable`. `chorus agents add` performs the resolution; the README documents the same two-step command. No new npm or PyPI artifact, and no SHA is stored in the repo (a commit cannot contain its own SHA).
- **Hooks aligned with the Codex plugin** (not Claude Code): session-start check-in + Chorus context/Spec Mode injection (re-injected after session reset or context compression, matching Codex's `startup|resume|clear|compact` matcher), and post-tool reminders after `chorus_pm_submit_proposal`, `chorus_submit_for_verify` and `chorus_admin_verify_task` (reviewer spawn, OpenSpec archive, code-review gateway, completion report).
- **Online scheduling without the daemon**: the `chorus` platform adapter runs inside `hermes gateway`, registers a `hermes` daemon connection over `/api/events/notifications`, acknowledges heartbeats, routes wake notifications into per-Idea gateway sessions, honours directed wakes (`targetConnectionUuid` / `suppressWake`), and reports turn lifecycle (running / ended / interrupted / wakeError), so Chorus shows the instance online and Start Development / Yolo work. The adapter authorises its own events: the gateway allowlist for the `chorus` platform is seeded at connect time with the agent owner's uuid from check-in, so no manual allowlist setup is needed.
- **Fixed working directory**: one Hermes gateway serves one repository (`terminal.cwd` = repo root); the adapter registers that cwd as its AgentInstance.
- **Unattended approvals through Chorus**: a `chorus` approval transport posts dangerous-command approval requests as Chorus comments @mentioning the owner and resolves them from the owner's reply; timeout denies. Approval replies are consumed by the transport and never become model turns, including when they are replayed as pending turns after a reconnect.
- **Server**: accept `hermes` as a daemon client type.
- **`chorus agents add`**: new `hermes` adapter — detects the `hermes` binary, installs and enables both directories at the matching release ref, and prints `CHORUS_URL` / `CHORUS_API_KEY` and gateway setup guidance. Daemon agent type is `offline` (the plugin owns presence).
- **Docs**: package README (install, development, troubleshooting), `docs/CONNECT_HERMES.md` + `.zh.md`, a Hermes tab in the in-app agent install guide, and plugin-maintenance skill updates.

## Capabilities

### New Capabilities

- `hermes-plugin-distribution`: Package layout, the native + portable directory split, MCP declaration with env-only secrets, git-subdirectory install pinned to release tags, and version synchronisation.
- `hermes-session-lifecycle`: Codex-parity hooks — session-start check-in/context injection and post-tool reviewer / archive / code-review / report reminders.
- `hermes-skill-bundle`: Packaged Chorus skills rewritten for Hermes tooling and three read-only reviewer workflows executed via `delegate_task`.
- `hermes-gateway-scheduling`: The `chorus` gateway platform adapter — connection registration, heartbeat ack, wake routing, session keying, directed-wake suppression, turn reporting, and the fixed-cwd model.
- `hermes-chorus-approval`: The Chorus comment-backed approval transport.
- `hermes-agents-add`: The `chorus agents add` Hermes adapter and the server-side `hermes` client type.

### Modified Capabilities

None as delta specs. The `agent-install-guide` and `daemon-connection-registry` changes are additive (new tab / new enum value) and are captured inside the new capabilities above.

## Impact

- New: `packages/chorus-hermes/` (Python plugin + portable MCP package + tests + README).
- Server: `src/services/daemon-connection.service.ts` (`DAEMON_CLIENT_TYPES`) and any validator/label that enumerates client types.
- CLI: `cli/init/adapters.mjs`, `cli/init/install-methods.mjs`, `cli/init/agent-type-map.mjs` and their tests.
- UI: `src/components/install-guide/AgentInstallGuide.tsx`, `messages/en.json`, `messages/zh.json`, `docs/design.pen`.
- Docs: `docs/CONNECT_HERMES.md`, `docs/CONNECT_HERMES.zh.md`, `.claude/skills/plugin-maintenance`.
- External compatibility pinned to Hermes Agent commit `2b52acc2d` (local test instance at `~/.hermes/hermes-agent`).
