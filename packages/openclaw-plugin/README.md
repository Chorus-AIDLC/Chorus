<p align="center">
  <img src="images/slug.png" alt="@chorus-aidlc/chorus-openclaw-plugin" width="240" />
</p>

<p align="center"><strong>@chorus-aidlc/chorus-openclaw-plugin</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
</p>

OpenClaw plugin for [Chorus](https://github.com/Chorus-AIDLC/Chorus) — the AI-DLC (AI-Driven Development Lifecycle) collaboration platform.

This plugin lets an OpenClaw agent participate in the full Chorus Idea → Proposal → Task → Execute → Verify workflow. It does two things at activation:

1. **Auto-registers the Chorus MCP server** in your OpenClaw config so the agent gains native `chorus__*` tools (no hand-wrapped tools — OpenClaw connects to Chorus over MCP directly).
2. **Opens a persistent SSE connection** to Chorus and wakes the agent in-process (runs an embedded agent turn via `runEmbeddedAgent`) the moment a task is assigned, you are @mentioned, a proposal is approved/rejected, and more.

It also ships **11 skills** — 9 workflow skills plus 2 read-only reviewer skills (`/proposal-reviewer`, `/task-reviewer`) that run inside spawned sub-agents.

> **Requires OpenClaw `>=2026.4.27`.** This package uses the OpenClaw Plugin SDK (`definePluginEntry` + native MCP auto-registration + `runEmbeddedAgent` wake + `activation.onStartup`). The binding floor is the newest API it depends on: `activation.onStartup` shipped in **2026.4.27** (`definePluginEntry` ~2026.3.28, `runEmbeddedAgent` 2026.4.10, `mutateConfigFile` 2026.4.26). The floor is enforced by `package.json` → `openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` (both `>=2026.4.27`). On older hosts the SDK entry subpath / `activation.onStartup` are unavailable and the plugin will not load (or won't start its SSE service).
>
> **`activation.onStartup` is required.** This plugin has no channel or provider, so it would NOT be activated at gateway cold-boot without `activation: { onStartup: true }` in `openclaw.plugin.json`. That flag is what tells OpenClaw to import the plugin (and start its SSE service) on startup — without it the plugin shows as "enabled" but its background service never runs.

---

## Installation

### From npm

```bash
openclaw plugins install npm:@chorus-aidlc/chorus-openclaw-plugin
openclaw plugins enable chorus-openclaw-plugin
```

Restart the OpenClaw gateway if it was already running so it picks up the new plugin and the MCP server entry the plugin writes on first activation.

### Local development (link the repo checkout)

```bash
# from the repo: packages/openclaw-plugin
openclaw plugins install --link .              # link this directory instead of copying
openclaw plugins enable chorus-openclaw-plugin
```

A **linked** install does **not** need a build step. OpenClaw treats a linked
local plugin as a source checkout (`requireBuiltRuntimeEntry: false` — see
`src/plugins/discovery.ts`) and loads the TypeScript `extensions` entry
(`src/index.ts`) directly through its bundled `jiti` transpiler. `--link` keeps
OpenClaw pointed at your working tree, so editing `src/**` and restarting the
gateway picks up your changes without re-installing or recompiling.

> The compiled `dist/` is only required for the **npm-published** install path
> below — a copied/npm install sets `requireBuiltRuntimeEntry: true`, so OpenClaw
> demands the compiled runtime entry declared in `openclaw.runtimeExtensions`.
> Run `npm run build` before publishing (it also runs automatically via
> `prepublishOnly`). You do not need it for local `--link` development.

> The plugin id is **`chorus-openclaw-plugin`** — that is the argument to `enable` / `disable` / `uninstall`, and the key under `plugins.entries` in your config.

---

## Configuration

### Where config lives

Plugin config lives in **`~/.openclaw/openclaw.json`** under:

```
plugins.entries.chorus-openclaw-plugin.config
```

```json
{
  "plugins": {
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": {
          "chorusUrl": "https://chorus.example.com",
          "apiKey": "cho_your_api_key_here"
        }
      }
    }
  }
}
```

### Config keys

| Key | Type | Required | Default | What it does |
|-----|------|----------|---------|--------------|
| `chorusUrl` | `string` | **Yes** | — | Base URL of your Chorus server. The plugin derives the MCP endpoint (`<chorusUrl>/api/mcp`) and the SSE endpoint from it. |
| `apiKey` | `string` | **Yes** | — | Chorus API Key (`cho_` prefix). Used as the `Bearer` token for both the MCP server entry and the SSE connection. Marked `sensitive` in the UI hints. |

If `chorusUrl` or `apiKey` is missing, the plugin logs a warning naming the missing field, skips MCP registration, and disables its features — it does not crash the gateway.

---

## How tools work now (native MCP)

On activation (full registration mode), the plugin **writes an `mcp.servers.chorus` entry** into your OpenClaw config via the host's `runtime.config.mutateConfigFile` API:

```json
{
  "mcp": {
    "servers": {
      "chorus": {
        "url": "https://chorus.example.com/api/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer cho_your_api_key_here" }
      }
    }
  }
}
```

OpenClaw then connects to the remote Chorus MCP server and **exposes every Chorus tool to the agent under the `chorus__` prefix** — for example `chorus__chorus_get_task`, `chorus__chorus_claim_task`, `chorus__chorus_submit_for_verify`. The plugin never re-declares those tools itself; they come straight from the MCP server.

The write is **idempotent**: if the existing entry already matches (same url + transport + Authorization), the plugin skips the write so it does not trigger a config reload on every activation. If `runtime.config.mutateConfigFile` is unavailable on the host, the failure is logged and swallowed — the SSE service and `/chorus` command still register.

### Migration note: bare `chorus_*` tool names are gone

Earlier versions of this plugin **hand-wrapped** Chorus tools and exposed them to the agent under their bare names (`chorus_get_task`, `chorus_claim_task`, …). **Those registrations have been removed.** Tools now come from the auto-registered MCP server and are namespaced with the server id, so they appear as **`chorus__<tool>`** (double underscore).

If you have macros, prompts, or agent instructions that reference the bare names, update them:

```
chorus_get_task        →  chorus__chorus_get_task
chorus_submit_for_verify  →  chorus__chorus_submit_for_verify
```

(Inside the bundled skills and reviewer-agent prompts the tools are referred to by their logical Chorus names; OpenClaw resolves them through the MCP server.)

### bundle-mcp sandbox caveat

When OpenClaw runs agents in a sandbox (`tools.sandbox.mode` = `"all"` or `"non-main"`), **MCP tools are owned by the built-in `bundle-mcp` plugin** and are filtered out of the agent's tool list by default. The `chorus__*` tools will be missing until you add either the `bundle-mcp` plugin or the `chorus__` glob to the sandbox allow list:

```json
{
  "tools": {
    "sandbox": {
      "tools": {
        "alsoAllow": ["chorus__*"]
      }
    }
  }
}
```

You can broaden this to `["bundle-mcp"]` to allow all MCP tools, or keep it scoped to `["chorus__*"]` to allow only Chorus tools. Restart the gateway after editing the sandbox policy. If you are **not** using sandbox mode, no allow-list change is needed.

---

## Real-time events (SSE → agent wake)

The plugin runs a background service (`chorus-sse`) that holds an SSE connection to Chorus. When an event arrives it fetches the full notification over MCP and **wakes the main agent in-process** by running an embedded agent turn via the host's `runtime.agent.runEmbeddedAgent(...)`, with the event text as the turn's prompt. The turn runs on the main agent's existing session (so it has conversation context and the full `chorus__*` MCP tool set) and is headless (`disableMessageTool: true`) — the agent acts by calling Chorus MCP tools (e.g. `chorus_get_comments`, `chorus_add_comment`) rather than replying to a chat channel.

> **Why not `enqueueSystemEvent`?** An earlier version pushed the wake text onto the session's system-event queue and triggered a heartbeat. That does **not** work for delivering content: the heartbeat prompt builder only renders exec-completion / cron events into a prompt, so a plain notification's queued text is never injected — the agent just runs the generic `[OpenClaw heartbeat poll]`. `runEmbeddedAgent` delivers the prompt directly.

> **The configured model is passed explicitly.** `runEmbeddedAgent` does not auto-resolve the model from config; with no `provider`/`model` it falls back to the built-in default (`gpt-5.5`) and errors with "Unknown model". The plugin reads `agents.defaults.model` (`"provider/model"` or `{ primary: "provider/model" }`) and passes `provider` + `model` to each wake turn.

| Event | Behavior |
|-------|----------|
| `task_assigned` | Wake the agent to review the task and claim it (`chorus_claim_task`) when ready |
| `mentioned` | Wake the agent with the @mention context and a pointer to the conversation |
| `elaboration_requested` | Wake the agent to review elaboration questions |
| `elaboration_answered` | Wake the agent to review answers, then validate or open another round |
| `proposal_rejected` | Wake the agent with the rejection note to fix and resubmit |
| `proposal_approved` | Wake the agent to pick up the newly created tasks |
| `idea_claimed` | Wake the agent when an idea is assigned to it |
| `task_verified` | Wake the agent to check for newly unblocked tasks |
| `task_reopened` | Wake the agent with verification feedback to rework |

**Resilience.** The SSE listener auto-reconnects with exponential backoff (1s → 2s → … → 30s max). After a reconnect it back-fills unread notifications over MCP so nothing is lost while disconnected. If no main agent session key can be resolved, `runEmbeddedAgent` is unavailable on the host, or a wake turn rejects (e.g. a turn is already in flight), the individual wake is **dropped with a warning** — it never throws and never crashes the SSE service. The next SSE event re-triggers.

---

## Skills (11)

Skills are bundled under `skills/` and auto-discovered by OpenClaw. On OpenClaw a skill is invoked as a **bare slash command of its name** — e.g. `/develop`, `/idea` (OpenClaw does **not** use a `chorus:` namespace prefix).

| Skill | Invoke | Description |
|-------|--------|-------------|
| `chorus` | `/chorus` | Platform overview, common tools, setup, and routing to the stage-specific skills |
| `idea` | `/idea` | Claim ideas, run elaboration rounds, and prepare for proposal creation |
| `brainstorm` | `/brainstorm` | Optional divergent-then-convergent dialogue for fuzzy ideas (prelude to elaboration) |
| `proposal` | `/proposal` | Create proposals with document + task drafts, manage the dependency DAG, validate and submit |
| `develop` | `/develop` | Claim tasks, report work, manage sessions, and run wave-based execution |
| `quick-dev` | `/quick-dev` | Skip Idea→Proposal — create tasks directly, execute, and verify |
| `review` | `/review` | Approve/reject proposals, verify tasks, and manage project governance |
| `yolo` | `/yolo` | Full-auto AI-DLC pipeline — from prompt to done |
| `openspec-aware` | `/openspec-aware` | Opt-in OpenSpec authoring for PM workflows when the local `openspec` CLI is present |
| `proposal-reviewer` | `/proposal-reviewer` | Read-only adversarial proposal review; ends with a `VERDICT:` comment |
| `task-reviewer` | `/task-reviewer` | Read-only adversarial task verification (read-only bash for tests); ends with a `VERDICT:` comment |

> Note: `/chorus` (the bare skill) and the `/chorus <subcommand>` command share the same `chorus` prefix. `/chorus status|tasks|ideas|skills` are fast, LLM-free status queries handled by the plugin command (see below); `/chorus` with no recognized subcommand falls through to the command's help/status.

## Reviewer skills (2)

`proposal-reviewer` and `task-reviewer` are bundled **as skills** (not agent definitions — OpenClaw has no Claude-Code-style typed agents). Both are **read-only** and end by posting a structured `VERDICT:` comment.

They are meant to run inside a **spawned sub-agent**: the orchestrating skill (`/proposal`, `/develop`, `/yolo`, `/review`) uses the OpenClaw `sessions_spawn` tool to spawn a sub-agent and instructs it (in the spawn `task`) to invoke `/proposal-reviewer` or `/task-reviewer` against the entity, then waits for the VERDICT. Spawned sub-agents inherit the plugin's skill snapshot, so the slash-commands are available to them. If `sessions_spawn` is unavailable, the orchestrator runs the same review itself as a read-only pass (the reviewer skills are the authoritative checklists).

| Skill | Description |
|-------|-------------|
| `/proposal-reviewer` | Reviews submitted proposals — document completeness, task granularity, AC alignment, cross-task dependencies. No Bash. |
| `/task-reviewer` | Verifies submitted tasks against the AC and proposal documents. Read-only Bash allowed for verification only (tests/build, `cat`/`grep`/`ls`, `git diff`/`log`/`show`). |

---

## Commands

`/chorus` runs fast, LLM-free status queries through the plugin's own slim MCP client:

| Command | Description |
|---------|-------------|
| `/chorus` or `/chorus status` | Connection status, agent identity, assigned-idea count, unread notifications, skill list |
| `/chorus tasks` | List your assigned tasks |
| `/chorus ideas` | List your assigned ideas |
| `/chorus skills` | List the 9 bundled Chorus skills |

---

## Architecture

```
packages/openclaw-plugin/
├── package.json              # npm + openclaw block (extensions / runtimeExtensions, install, compat)
├── openclaw.plugin.json      # plugin manifest (id, activation.onStartup, configSchema, skills dir, uiHints)
├── tsconfig.json             # build config; excludes __tests__ from dist
├── vitest.config.ts          # standalone test runner config (package is outside the root workspace)
├── skills/                   # 11 SKILL.md skills (9 workflow + proposal-reviewer + task-reviewer), auto-discovered
└── src/
    ├── index.ts              # definePluginEntry — wires everything; gated to "full" registration mode
    ├── config.ts             # config contract (chorusUrl, apiKey) + location constants
    ├── mcp-registration.ts   # writes mcp.servers.chorus (idempotent, streamable-http + Bearer)
    ├── mcp-client.ts         # slim MCP client for the plugin's own calls (checkin, assignments, claim)
    ├── sse-listener.ts       # SSE connection + exponential-backoff reconnect
    ├── event-router.ts       # SSE event → wake-message mapping (project-filtered)
    ├── wake.ts               # resolves main session + model, runs an embedded agent turn (runEmbeddedAgent)
    ├── commands.ts           # /chorus status|tasks|ideas|skills
    ├── openclaw-sdk.d.ts     # ambient SDK shim (compile-time only; see below)
    └── __tests__/            # vitest unit tests (config, mcp-registration, wake, event-router, commands, sse-listener)
```

### Note on `openclaw-sdk.d.ts`

The entry imports `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`, a subpath available in OpenClaw `>=2026.4.27` (the plugin's host floor). When the locally resolvable `openclaw` package is an older build, `tsc` cannot resolve that subpath, so `src/openclaw-sdk.d.ts` declares a minimal ambient module to satisfy the type-checker. It is **compile-time only** — at install/runtime the real host (`>=2026.4.27`) provides the actual SDK. The floor is enforced at install time by `openclaw.compat.pluginApi >=2026.4.27` (and `openclaw.install.minHostVersion`); `peerDependencies.openclaw >=2026.0.0` is npm metadata only and is intentionally looser. Once the workspace resolves a `>=2026.4.27` `openclaw` build, delete the shim and rely on the real types.

---

## Validation / Release checklist

The maintainer release gate has four parts. The first (type check + test + build) runs anywhere with Node + the dev dependencies. The last two (SDK validators + smoke) require an installed `openclaw` >=2026.4.27 CLI and a running host.

### 1. Type check, test & build (no OpenClaw CLI required)

```bash
npm run typecheck        # tsc --noEmit  → exit 0, no diagnostics
npm run test             # vitest run    → exit 0, all unit tests pass
npm run build            # tsc           → exit 0, writes dist/index.js
```

These three also run automatically before publish via the `prepublishOnly`
script (`clean → typecheck → test → build`), so `npm publish` cannot ship a
package that fails to type-check, fails its tests, or is missing the compiled
`dist/`. Publishing the compiled runtime is **mandatory** for the npm install
path — a copied/npm install rejects a TypeScript-only entry with *"requires
compiled runtime output"* (see the local-development note above).

`dist/index.js` must exist and its **default export** must be the `definePluginEntry(...)` result — an object with `id: "chorus-openclaw-plugin"` and a `register` function. A direct `import('./dist/index.js')` resolves the `openclaw/plugin-sdk/plugin-entry` peer subpath, so run this on a host where a >=2026.4.27 `openclaw` package is resolvable.

### 2. OpenClaw SDK validators (require `openclaw` >=2026.4.27 CLI)

Run from the package root after `npm run build`:

```bash
openclaw plugins build --entry ./dist/index.js --check    # expect exit 0: "Plugin metadata is up to date."
openclaw plugins validate --entry ./dist/index.js         # expect exit 0: "Plugin chorus-openclaw-plugin is valid."
```

- `plugins build --check` fails (exit 1, "Generated plugin metadata is out of date. Run openclaw plugins build.") if the committed `openclaw.plugin.json` / `package.json` metadata is stale relative to the entry. If it fails, run `openclaw plugins build` (no `--check`) to regenerate, review the diff, and commit.
- `plugins validate` loads the manifest, checks the entry id matches the manifest id, confirms the `configSchema` is present, and verifies `package.json` `openclaw.extensions` includes the entry. Expected success: `Plugin chorus-openclaw-plugin is valid.`

### 3. Manual smoke test (require `openclaw` >=2026.4.27 host)

```bash
openclaw plugins install --link .
openclaw plugins enable chorus-openclaw-plugin
# configure plugins.entries.chorus-openclaw-plugin.config (chorusUrl + apiKey), then restart the gateway
```

Confirm:

1. **`mcp.servers.chorus` is written** — inspect `~/.openclaw/openclaw.json`; the `mcp.servers.chorus` entry should have `url: <chorusUrl>/api/mcp`, `transport: "streamable-http"`, and a `Bearer` Authorization header.
2. **`chorus__*` tools appear** — the agent's tool list includes `chorus__chorus_get_task`, `chorus__chorus_checkin`, etc. (in sandbox mode, after adding `chorus__*` to `tools.sandbox.tools.alsoAllow`).
3. **SSE wake fires** — assign a Chorus task to this agent; the SSE event should wake the agent in-process. Check the gateway log for `[Chorus] Wake enqueued`.
4. **`/chorus status` works** — running `/chorus` returns connection status + checkin data (agent name, assigned-idea count, unread notifications, skill list).

### Status in this repo's CI environment

In the repository CI/dev environment the `openclaw` CLI is **not installed** (and the resolvable `openclaw` peer is an older `2026.3.x` build, which is exactly why the `openclaw-sdk.d.ts` shim is still required), so steps 2–3 above cannot be executed here. Section 1 (`tsc --noEmit`, `vitest run`, and `tsc` build → `dist/index.js` with a valid default export) **is** run and must pass. A maintainer on a >=2026.4.27 host must run sections 2 and 3 before publishing and confirm the expected exit codes / messages above.

---

## License

MIT
