## Why

`packages/openclaw-plugin` (currently v0.4.1) targets OpenClaw's **old `api`-object plugin model**: a plain `{ id, register(api) }` object that calls `api.registerService` / `api.registerTool` / `api.registerCommand`, reads `api.pluginConfig`, and wakes the agent by POSTing to the gateway's HTTP `/hooks/wake` endpoint. It hand-wraps ~40 Chorus MCP tools across `src/tools/*.ts`, each one re-declaring a parameter schema that duplicates the server-side tool.

OpenClaw has since shipped **2026.5.30**, which replaces that model with a formal **Plugin SDK**:

- Entry is a `definePluginEntry({ id, name, description, configSchema, register })` default export from `openclaw/plugin-sdk/plugin-entry` (verified at `../openclaw/src/plugin-sdk/plugin-entry.ts:305`).
- Discovery uses an `openclaw.plugin.json` manifest whose `configSchema` is **JSON Schema** (not a zod object), read **before** plugin code executes (`../openclaw/docs/plugins/manifest.md`).
- `package.json` carries an `openclaw` block (`extensions` / `runtimeExtensions`, `compat.pluginApi`, `build`) — not `peerDependencies` — for install-time compatibility gating.
- The agent is woken **in-process** via `api.runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey })` (`../openclaw/src/infra/system-events.ts:102`); the HTTP `/hooks/wake` path is gone.
- OpenClaw natively connects to remote MCP servers (`mcp.servers.<name>` config, `transport: "streamable-http"`, per-server `headers` for Bearer auth — `../openclaw/src/config/types.mcp.ts:12`). A plugin can ensure such an entry programmatically via `api.runtime.config.mutateConfigFile`.

The current plugin will not load on 2026.5.30 (wrong entry shape, wrong manifest, dead wake path), and even if patched, hand-wrapping 40 tools is now pure liability: every tool's schema must be maintained in lockstep with the server, and the model's tool-selection surface is doubled for zero capability gain.

In parallel, the Claude Code Chorus plugin (`public/chorus-plugin/`) has grown to **9 skills** (chorus, idea, brainstorm, proposal, develop, quick-dev, review, **yolo**, **openspec-aware**) plus two reviewer agents (proposal-reviewer, task-reviewer). The OpenClaw plugin still ships only the **7 older skills** and no agents — it is missing the full-auto pipeline (`yolo`), spec-driven authoring (`openspec-aware`), and the adversarial review loop. The skills it does ship predate the current Claude Code skill capabilities.

## What Changes

- **BREAKING (packaging)**: Convert `packages/openclaw-plugin/src/index.ts` from the legacy `{ id, register }` object to a `definePluginEntry(...)` default export imported from `openclaw/plugin-sdk/plugin-entry`. Rewrite `openclaw.plugin.json` to the current manifest shape (`id`, JSON-Schema `configSchema`, `name`, `description`, `skills`, optional `activation`/`contracts`). Rewrite the `package.json` `openclaw` block to declare `extensions` + `runtimeExtensions` + `compat.pluginApi` + `build`.
- **BREAKING (tools)**: Delete all hand-wrapped tool modules — `src/tools/pm-tools.ts`, `src/tools/dev-tools.ts`, `src/tools/admin-tools.ts`, `src/tools/common-tools.ts`. Chorus tools instead surface natively as `chorus__*` once the MCP server is registered.
- **New (MCP integration)**: On activation, the plugin reads `chorusUrl` + `apiKey` from its `pluginConfig` and ensures `mcp.servers.chorus = { url: "<chorusUrl>/api/mcp", transport: "streamable-http", headers: { Authorization: "Bearer <apiKey>" } }` exists in OpenClaw config via `api.runtime.config.mutateConfigFile`. Idempotent: re-applies only when the resolved entry differs.
- **Changed (event bridge)**: Keep the SSE listener (`src/sse-listener.ts`) and event router (`src/event-router.ts`) as a background service registered with `api.registerService({ id, start, stop })`. Replace `wakeAgent()`'s HTTP `/hooks/wake` POST with `api.runtime.system.enqueueSystemEvent(...)`. Retain a **slim** MCP client (`src/mcp-client.ts`) used only for the plugin's own internal calls (notification back-fill on reconnect, the `/chorus` status command) — not for re-exposing tools.
- **Changed (commands)**: Keep the `/chorus` command (status / tasks / ideas / skills) registered via `api.registerCommand`, updated for the slim client and the new skill list.
- **New (skills + agents)**: Port the full set of 9 skills from `public/chorus-plugin/skills/` into `packages/openclaw-plugin/skills/`, rewritten to match current Claude Code skill capabilities and adapted for OpenClaw (where a Claude-Code-only mechanism — PostToolUse/SubagentStart context injection, foreground typed sub-agents, Agent Teams — has no OpenClaw equivalent, the skill text instructs the agent to perform the step inline and documents the limitation). Add `agents/proposal-reviewer.md` and `agents/task-reviewer.md`. All skill docs in English.
- **Changed (config schema)**: `configSchema` becomes JSON Schema in `openclaw.plugin.json`; the zod schema in `src/config.ts` is retained only for in-code runtime validation/typing of `pluginConfig`, kept byte-aligned with the manifest.
- **New (docs)**: Rewrite `packages/openclaw-plugin/README.md` for the new install flow (`openclaw plugins install`), the auto-registered MCP server, the `bundle-mcp` sandbox allowlist caveat, and the skill catalog.

## Capabilities

### New Capabilities

- `openclaw-plugin-sdk`: How the plugin declares its entry, manifest, config schema, and package metadata so OpenClaw 2026.5.x can discover, validate, install, and load it.
- `openclaw-mcp-integration`: How the plugin makes the remote Chorus MCP server's tools available to the agent natively, replacing all hand-wrapped tool registrations.
- `openclaw-event-bridge`: How the plugin listens to Chorus SSE notifications in the background and wakes the agent in-process when actionable events arrive.
- `openclaw-skills`: What skills and agent definitions the plugin bundles, and how Claude-Code-only workflow mechanics are adapted to OpenClaw.

### Modified Capabilities

_(none — all four capabilities are introduced fresh; there is no pre-existing OpenSpec spec for the OpenClaw plugin.)_

## Impact

- **Breaking for**: Anyone running the plugin on a pre-2026.5 OpenClaw (the new entry shape requires the new SDK). Agents that referenced the bare `chorus_*` tool names must use the namespaced `chorus__*` names once tools come from the MCP server. The `/hooks/wake`-based wake path is removed.
- **Code**: `packages/openclaw-plugin/src/index.ts` (rewrite), `src/config.ts` (trim), `src/mcp-client.ts` (slim down), `src/sse-listener.ts` (keep), `src/event-router.ts` (wake call swap), `src/commands.ts` (keep/update); **delete** `src/tools/`.
- **Manifest/packaging**: `openclaw.plugin.json`, `package.json`, `tsconfig.json` (emit `dist/` for `runtimeExtensions`).
- **Skills/agents**: `packages/openclaw-plugin/skills/*` (port 9), `packages/openclaw-plugin/agents/*` (add 2).
- **Docs**: `packages/openclaw-plugin/README.md`.
- **Validation**: `tsc --noEmit`; `openclaw plugins build --entry ./dist/index.js --check` + `openclaw plugins validate`; manual `openclaw plugins install --link .` smoke test confirming `mcp.servers.chorus` is written and `chorus__*` tools appear.
- **Out of scope**: Publishing to npm/ClawHub (a separate release step); any change to the Chorus server's MCP surface; the Claude Code / Codex plugins (this change only touches `packages/openclaw-plugin/`).
- **Backward compatibility**: None attempted for the old SDK — OpenClaw 2026.5 is a hard floor. The `peerDependencies.openclaw` range stays `>=2026.0.0` for npm metadata, but `openclaw.compat.pluginApi` enforces `>=2026.5.30` at install time.
