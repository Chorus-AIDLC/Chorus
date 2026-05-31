# Technical Design: refactor-openclaw-plugin

## Overview

Port `packages/openclaw-plugin` from OpenClaw's legacy `api`-object plugin model to the 2026.5.x **Plugin SDK**. The refactor has four independent surfaces — SDK entry/packaging, native MCP integration, the SSE→wake event bridge, and the skill/agent bundle — that share one entry file but otherwise touch disjoint code. The tool-wrapping layer (`src/tools/`) is deleted outright; everything the agent needs comes from the natively-connected Chorus MCP server.

All API facts below are grounded in the OpenClaw source at `../openclaw` (version `2026.5.30`, per `../openclaw/package.json`). Where the public docs and source disagree (e.g. `compat.minGatewayVersion`), the **installed SDK is authoritative** and the implementer must confirm against it before committing the manifest.

## Architecture

### Module map (after change)

```
packages/openclaw-plugin/
├── openclaw.plugin.json        # manifest: id + JSON-Schema configSchema + skills + activation
├── package.json                # openclaw block: extensions, runtimeExtensions, compat, build
├── tsconfig.json               # emits dist/ (runtimeExtensions target)
├── src/
│   ├── index.ts                # definePluginEntry({ ..., register }) default export
│   ├── config.ts               # zod schema for in-code typing + validateConfig (manifest is canonical)
│   ├── mcp-registration.ts     # NEW: ensureChorusMcpServer() via runtime.config.mutateConfigFile
│   ├── mcp-client.ts           # SLIM: plugin's own MCP calls only (checkin, get_my_assignments, get_notifications)
│   ├── sse-listener.ts         # KEEP: SSE reader + backoff reconnect
│   ├── event-router.ts         # CHANGED: dispatch → enqueueSystemEvent (was triggerAgent→/hooks/wake)
│   └── commands.ts             # KEEP: /chorus status|tasks|ideas|skills
│   └── tools/                  # DELETED entirely
├── skills/                     # 9 skills ported from public/chorus-plugin/skills/
└── agents/                     # proposal-reviewer.md, task-reviewer.md
```

### Entry contract

`src/index.ts` exports the result of `definePluginEntry`. Signature confirmed at `../openclaw/src/plugin-sdk/plugin-entry.ts:305`:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { chorusConfigSchema, resolveConfig } from "./config.js";
import { ensureChorusMcpServer } from "./mcp-registration.js";
import { ChorusMcpClient } from "./mcp-client.js";
import { ChorusSseListener } from "./sse-listener.js";
import { ChorusEventRouter } from "./event-router.js";
import { registerChorusCommands } from "./commands.js";

export default definePluginEntry({
  id: "chorus-openclaw-plugin",
  name: "Chorus",
  description: "Chorus AI-DLC collaboration platform — native MCP + SSE real-time events",
  configSchema: { jsonSchema: CHORUS_JSON_SCHEMA },   // see §Config schema
  register(api) {
    // 1. discovery-mode guard
    if (api.registrationMode !== "full") return;

    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.ok) { api.logger.warn(cfg.message); return; }

    // 2. ensure the Chorus MCP server is connected (async, fire-and-log)
    ensureChorusMcpServer(api, cfg.value).catch((e) =>
      api.logger.error(`MCP registration failed: ${e}`));

    // 3. slim client for the plugin's own calls
    const client = new ChorusMcpClient({ ...cfg.value, logger: api.logger });

    // 4. background SSE service
    let listener: ChorusSseListener | null = null;
    const router = new ChorusEventRouter({ client, config: cfg.value, api });
    api.registerService({
      id: "chorus-sse",
      async start() { listener = new ChorusSseListener({ ...cfg.value, onEvent: e => router.dispatch(e), ... }); await listener.connect(); },
      async stop() { listener?.disconnect(); await client.disconnect(); },
    });

    // 5. /chorus command
    registerChorusCommands(api, client, () => listener?.status ?? "disconnected");
  },
});
```

**`registrationMode` guard**: `api.registrationMode` can be `"full" | "discovery" | "setup-only" | "setup-runtime" | "cli-metadata"` (`../openclaw/src/plugins/types.ts`). Heavy work (MCP connect, SSE socket) must run only in `"full"` mode; discovery/cli-metadata loads must not open sockets. The command registration itself is cheap and may stay outside the guard if it only declares metadata — but to keep behavior simple and safe, the implementer SHALL gate all runtime wiring behind `mode === "full"`.

### Config schema

The **manifest** `configSchema` (JSON Schema) is canonical and validated before code runs. `src/config.ts` keeps a zod schema purely for in-code typing of `api.pluginConfig` and to produce friendly missing-field messages; the two MUST stay aligned. Shape (unchanged fields from v0.4.1):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "chorusUrl":    { "type": "string", "description": "Chorus server URL (https://...)" },
    "apiKey":       { "type": "string", "description": "Chorus API Key (cho_ prefix)" },
    "projectUuids": { "type": "array", "items": { "type": "string" }, "default": [] },
    "autoStart":    { "type": "boolean", "default": true }
  }
}
```

`uiHints.apiKey.sensitive = true` is added to the manifest so the value is masked in setup UIs.

### Native MCP integration (`mcp-registration.ts`)

There is **no** `api.registerMcpServer` method on the Plugin API (confirmed: the 40+ `register*` methods in `../openclaw/src/plugins/types.ts` contain none for MCP). The supported path is to write a `mcp.servers.<name>` entry into OpenClaw config; OpenClaw then auto-discovers and exposes its tools as `chorus__*` (`../openclaw/docs/cli/mcp.md`, `../openclaw/src/agents/agent-bundle-mcp-materialize.ts:77`).

```ts
export async function ensureChorusMcpServer(api, cfg) {
  const desired = {
    url: new URL("/api/mcp", cfg.chorusUrl).toString(),
    transport: "streamable-http" as const,
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  };
  const current = api.runtime.config.current();
  const existing = current.mcp?.servers?.chorus;
  if (existing && shallowMcpEqual(existing, desired)) return;   // idempotent

  await api.runtime.config.mutateConfigFile({
    update: (c) => ({
      ...c,
      mcp: { ...c.mcp, servers: { ...c.mcp?.servers, chorus: desired } },
    }),
    afterWrite: { mode: "auto" },   // reload so tools appear without manual restart
  });
  api.logger.info("Registered mcp.servers.chorus (streamable-http)");
}
```

`McpServerConfig` fields (`url`, `transport: "sse" | "streamable-http"`, `headers`, `connectionTimeoutMs`) are confirmed at `../openclaw/src/config/types.mcp.ts:12`. Transport spelling is `"streamable-http"` (canonical; `type: "http"` is normalized by `openclaw mcp set` but we write the canonical form directly).

**Sandbox caveat** (documented, not coded): in sandbox modes `"all"`/`"non-main"`, MCP tools are owned by the `bundle-mcp` plugin and filtered unless the user adds `bundle-mcp` (or the `chorus__` glob) to `tools.sandbox.tools.alsoAllow` (`../openclaw/docs/gateway/config-tools`). README must call this out.

**Secret-in-config note**: writing the Bearer token into `openclaw.json` mirrors how `openclaw mcp set` stores MCP auth today; the token is already in the plugin's own `pluginConfig`, so no new exposure surface is created. Documented in the design's Risks.

### Event bridge: SSE → in-process wake

`sse-listener.ts` is kept as-is (reader + exponential backoff 1s→30s). `event-router.ts` changes only the **trigger** mechanism. Old:

```ts
triggerAgent(message) → fetch(`${gatewayUrl}/hooks/wake`, { ... })   // REMOVED
```

New (`../openclaw/src/infra/system-events.ts:102`, usage pattern `../openclaw/extensions/signal/src/monitor/event-handler.ts:545`):

```ts
api.runtime.system.enqueueSystemEvent(message, {
  sessionKey: resolveSessionKey(api),                 // main agent session
  contextKey: `chorus:${notification.action}:${notification.entityUuid}`,  // dedupe
});
```

`contextKey` gives the queue's built-in dedupe (`findDuplicateInQueue`) a stable key so a burst of identical notifications collapses to one wake. The router's per-action message templates (task_assigned, mentioned, proposal_approved/rejected, elaboration_*, task_verified/reopened, idea_claimed) are unchanged in content; only the delivery call changes. `sessionKey` resolution uses the runtime's main-session helper; if no session key is resolvable (headless/cron with no active agent), the router logs and drops the wake rather than throwing (no silent crash, no fake session).

`autoStart` semantics are preserved: on `task_assigned`, if `autoStart` is true the router still calls `chorus_claim_task` via the slim client before enqueuing the wake.

### Slim MCP client

`mcp-client.ts` keeps the `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` connection to `<chorusUrl>/api/mcp` with the Bearer header, lazy-connect, and 404-reconnect logic — but is now called **only** by the plugin itself: `chorus_checkin` / `chorus_get_my_assignments` (the `/chorus` command), `chorus_get_notifications` (SSE reconnect back-fill), and `chorus_claim_task` (autoStart). It no longer backs any agent-facing tool. This is intentional duplication with the agent's MCP path: the plugin runs in the gateway process and needs synchronous answers for its command/router logic independent of the agent's tool loop.

### Skills & agents

The 9 skills are ported from `public/chorus-plugin/skills/` (the current source of truth) into `packages/openclaw-plugin/skills/<name>/SKILL.md`, declared via `"skills": ["./skills"]` in the manifest (`../openclaw/docs/plugins/manifest.md`). The two agents go in `agents/`.

Each skill's **content** is rewritten where it references Claude-Code-only machinery. Adaptation matrix:

| Claude Code mechanism | Used by | OpenClaw status | Adaptation |
|---|---|---|---|
| `chorus_*` bare tool names | all skills | tools are `chorus__*` when MCP-sourced | Skills reference tools by base name but note the `chorus__` namespace prefix under OpenClaw. |
| PostToolUse hook injects "spawn reviewer" | proposal/develop/yolo | no per-tool PostToolUse context injection in plugin SDK | Skill text instructs the agent to spawn the reviewer **inline** right after submit; no reliance on an injected reminder. |
| SubagentStart hook auto-injects session UUID | develop/yolo sub-agents | no equivalent auto-injection | Skill text has sub-agents call `chorus_create_session` / pass `sessionUuid` explicitly; documented as manual. |
| `chorus:proposal-reviewer` / `chorus:task-reviewer` typed sub-agents (foreground) | review/develop/yolo | depends on OpenClaw subagent API (`runtime.subagent.run`) | Use `runtime.subagent.run` where the host supports it; otherwise the skill runs the review as a focused single-agent read-only pass and records the VERDICT comment itself. |
| Agent Teams (`TeamCreate` + parallel `Agent`) | yolo Phase 3 | no Agent Teams primitive | yolo degrades to **sequential** main-agent wave execution (the existing documented fallback), looping `chorus_get_unblocked_tasks`. |
| `AskUserQuestion` interactive elaboration | idea/brainstorm | OpenClaw has no identical primitive | Skills present elaboration questions as plain prompts and collect free-text answers; yolo self-answers as today. |

`openspec-aware` ports cleanly — it depends on the `openspec` CLI and the `chorus-api.sh` wrapper, not on Claude Code internals — but its §1 detection block changes from "read SessionStart-injected `CHORUS_OPENSPEC_ACTIVE`" to "run the three-check probe yourself" because OpenClaw does not run the Claude Code SessionStart hook. The wrapper-vs-direct-MCP byte-equality rule (§2 Rule 1) is preserved.

Frontmatter uses the Claude Code SKILL.md format (`name`, `description`, `license`, `metadata.{author,version,category,mcp_server}`); OpenClaw reads `name`/`description` and ignores the rest, so the shared format is safe across both hosts.

### Packaging & build

`package.json#openclaw` (the shape below is **verified against real externally-published bundled extensions** — `../openclaw/extensions/acpx/package.json` and `../openclaw/extensions/amazon-bedrock/package.json` declare exactly `compat.pluginApi: ">=2026.5.30"` and `build.openclawVersion: "2026.5.30"`, so the docs-page omission of a `build` block is a docs gap, not a signal that the field is fabricated):

```jsonc
{
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "runtimeExtensions": ["./dist/index.js"],   // observed as `null` in many bundled exts; we ship a built dist, so point at it
    "compat": { "pluginApi": ">=2026.5.30" },
    "build": { "openclawVersion": "2026.5.30" },
    "install": {                                  // required for `openclaw plugins install npm:...`
      "npmSpec": "@chorus-aidlc/chorus-openclaw-plugin",
      "defaultChoice": "npm",
      "minHostVersion": ">=2026.5.30"
    }
  }
}
```

`tsconfig.json` already emits `dist/` (`outDir: "dist"`, `rootDir: "src"`); the build is `tsc`. `peerDependencies.openclaw` stays `>=2026.0.0` (npm metadata only — `compat.pluginApi` is the real gate). `@modelcontextprotocol/sdk` and `zod` remain runtime `dependencies` (pure JS, cross-platform). **No** `postinstall` (npm installs run `--ignore-scripts`).

> **N1 resolved (from proposal review):** The `openclaw.build.openclawVersion` field IS real — confirmed present in `../openclaw/extensions/acpx/package.json` and `../openclaw/extensions/amazon-bedrock/package.json` (both externally-published). The bundled-only providers (anthropic/signal/telegram) omit `build`/`install` because they ship inside core dist and are never npm-installed; an externally-published plugin like ours needs the `build` + `install` blocks. **Implementer MUST still** open one externally-published bundled extension's `package.json` (e.g. `acpx`) right before committing the manifest and match its exact `compat`/`build`/`install` field set against the installed SDK — `minGatewayVersion`/`pluginSdkVersion` were NOT observed in the verified samples, so do not add them unless `openclaw plugins validate` demands them.

## Risks / Trade-offs

- **Config mutation writes a secret.** The Bearer API key lands in `~/.openclaw/openclaw.json` under `mcp.servers.chorus.headers`. Mitigation: this matches the platform's own `openclaw mcp set` behavior; the same key is already in `plugins.entries.*.config`. Documented; not a regression.
- **`afterWrite: "auto"` reload.** Triggering a config reload on activation could surprise a running gateway. Mitigation: the write is idempotent (skipped when the entry already matches), so the reload fires at most once per config change, not on every startup.
- **Doc/source drift on manifest fields.** Mitigated by the "verify against installed SDK" gate above and the `openclaw plugins validate` step in AC.
- **yolo loses parallelism on OpenClaw.** Sequential wave execution is slower but correct; this is the documented fallback path, not a new failure mode.
- **Two MCP connections** (agent's native `chorus__*` path + plugin's slim client). Trade-off accepted: the plugin needs synchronous answers in gateway-process code independent of the agent loop. The slim client makes ≤3 distinct calls and holds one lazily-opened connection.

## Migration Notes

No data migration. Operationally: a user on the old plugin upgrades by reinstalling on OpenClaw 2026.5.x; on first `"full"` load the plugin writes `mcp.servers.chorus` and the agent gains `chorus__*` tools. The old bare `chorus_*` tool names disappear (they were plugin-registered, now gone) — any user macros referencing them must switch to `chorus__*`. README documents the cutover.

## Rollout / Validation

1. `pnpm --filter @chorus-aidlc/chorus-openclaw-plugin typecheck` (`tsc --noEmit`) — green.
2. `tsc` build → `dist/index.js`.
3. `openclaw plugins build --entry ./dist/index.js --check` and `openclaw plugins validate` — manifest/contracts/extensions consistent.
4. `openclaw plugins install --link .` into a local OpenClaw 2026.5.x; confirm: (a) `mcp.servers.chorus` written to config, (b) `chorus__*` tools listed to the agent, (c) assigning a Chorus task fires an SSE event that wakes the agent via `enqueueSystemEvent`, (d) `/chorus status` returns checkin data.
