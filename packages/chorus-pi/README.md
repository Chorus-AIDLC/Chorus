# chorus-pi — Chorus AI-DLC extension for the Pi coding agent

Chorus AI-DLC collaboration platform extension for [Pi](https://pi.dev). Ported from the Claude Code plugin (`public/chorus-plugin/`) and the Codex port (`plugins/chorus/`) following the same methodology documented in `docs/codex-plugin-plan.md`.

## What this package provides

- **12 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`, `/skill:brainstorm`, `/skill:orchestrate`, `/skill:docs`, `/skill:chorus-cli`, `/skill:openspec-aware`
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`
- **1 worker sub-agent** — `chorus-worker`, a general-purpose Chorus implementer that claims and completes ONE task via the develop workflow (dispatch it with the `subagent` tool, single or parallel mode, for wave-based execution)
- **1 session-aware extension** (`extensions/chorus.ts`) — subscribes to Pi native events to automate checkin, context injection, reviewer nudges, and session lifecycle
- **The official pi subagent pattern** bundled at `extensions/subagent/` (the `subagent` tool + package-relative agent discovery)

## Install

```bash
# MCP adapter (exposes the Chorus chorus_* tools to pi)
pi install npm:pi-mcp-adapter

# this package
pi install npm:@chorus-aidlc/chorus-pi
```

That is the whole install. The `subagent` tool ships inside this package (pi's
official subagent reference pattern, at `extensions/subagent/`), and the three
reviewer agents are discovered directly from the package's own `agents/` dir —
there is **no** separate subagents dependency and **no** manual copy of agent
files into `~/.pi/agent/agents/`.

Then configure `mcp.json` and env vars — see [`docs/CONNECT_PI.md`](../../docs/CONNECT_PI.md).

`chorus init` (a.k.a. `chorus agents add`) automates this: select **Pi** in the agent
checklist and it runs both installs (`pi install npm:pi-mcp-adapter && pi install
npm:@chorus-aidlc/chorus-pi`, degrading to the manual commands if the `pi` CLI is absent)
**and** writes pi's global `~/.pi/agent/mcp.json` with an `mcpServers.chorus` entry whose
`Authorization` header references the key by environment variable (`Bearer ${CHORUS_API_KEY}`)
— the resolved endpoint URL is a literal, and **no `cho_` key is written to disk** (the same
keyless model Claude Code and Codex use). You still export `CHORUS_API_KEY` (and
`CHORUS_AGENT_PROFILE`) in the shell that launches interactive pi — pi has no settings env-file
to persist them into; the daemon spawner injects them for the wake path.

## Wakeable daemon backend (`--agent pi`)

pi is a first-class **wakeable** Chorus daemon backend. The Chorus daemon can wake a
headless pi session on remote dispatch (assigned idea/task, `@mention`, proposal decision),
so pi joins the reversed-conversation loop like the Claude Code / Codex / Kiro backends:

```bash
chorus daemon --agent pi
```

The daemon resolves `pi` from PATH (override with `CHORUS_PI_PATH`), runs it headless
(`pi --mode json -p`), and exports `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`
into the woken session. pi has no permission system, so no sandbox flag is involved. `chorus init`
seeds a selected pi agent as wakeable in `~/.chorus/daemon.json` and can install the boot daemon
that wakes it. See [`docs/CONNECT_PI.md`](../../docs/CONNECT_PI.md#run-pi-as-a-wakeable-daemon-backend).

## Why Pi is the lowest-friction target

- **MCP: adapter path, keyless config.** `pi-mcp-adapter` reads the `mcp.json` `chorus agents add` writes at `~/.pi/agent/mcp.json` (or a project-root `.mcp.json`) and exposes all 40+ `chorus_*` tools — the extension never registers tools itself. The `Authorization` header references the key by env var (`Bearer ${CHORUS_API_KEY}`, which the adapter interpolates at connect time), so no `cho_` key lands on disk. A literal Bearer also works, but the env-referenced form is what the CLI writes.
- **Hooks: TypeScript, not bash.** The extension replaces ~10 bash hook scripts with one TS file. No `curl`/`jq`, no Bash 3.2 compatibility traps (the `${2:-{}}` JSON-parse bug that plagued the Codex port is structurally impossible here).
- **Sub-agent sessions: automatic.** By monitoring `subagent` tool events, the extension auto-creates a Chorus session for each worker task in a dispatch and closes it when the tool call returns — a capability the Codex port lacks (Codex has no sub-agent lifecycle events, so its workers manage sessions manually).
- **Skills: same standard.** Pi implements the Agent Skills standard, so the skill bodies port with find/replace only (Claude's `Task` tool → the `subagent` tool; `/chorus:develop` → `/skill:develop`).

## Structure

```
packages/chorus-pi/
├── package.json              # pi manifest (extensions + skills) + peerDeps
├── extensions/
│   ├── chorus.ts             # session_start / before_agent_start / tool_call / tool_result / tool_execution_end / session_shutdown
│   └── subagent/             # pi's official subagent pattern (copied from earendil-works/pi)
│       ├── index.ts          # registers the `subagent` tool (single / parallel / chain)
│       └── agents.ts         # agent discovery — incl. this package's own agents/ dir (package-relative, zero copy)
├── skills/                   # 12 Agent Skills standard SKILL.md (ported from public/chorus-plugin/skills)
│   ├── chorus/                # core overview + routing
│   ├── idea/ proposal/ develop/ review/  # AI-DLC stage workflows
│   ├── quick-dev/ yolo/       # shortcut + full-auto pipelines
│   ├── brainstorm/ orchestrate/  # divergent prelude + multi-agent orchestration
│   ├── docs/ chorus-cli/      # docs router + CLI reference
│   └── openspec-aware/        # opt-in spec-driven authoring sub-procedure
├── agents/                   # 4 sub-agents — discovered package-relative by extensions/subagent/agents.ts (no manual copy)
│   ├── chorus-proposal-reviewer.md   # read-only reviewers
│   ├── chorus-task-reviewer.md
│   ├── chorus-code-reviewer.md
│   └── chorus-worker.md              # general-purpose task implementer (inherits full tools)
├── bin/
│   └── chorus-mcp-call.sh    # stateless MCP-over-HTTP wrapper (from the Codex port) for OpenSpec byte-exact document mirroring
└── README.md
```
## Status

**Complete port** of the Claude Code / Codex plugins to Pi. All 12 skills, all 3 reviewer sub-agents plus the `chorus-worker` implementer, the session-aware extension, the bundled official subagent pattern, and the OpenSpec wrapper are implemented and validated (TS transpiles, JSON valid, all skill/agent names compliant with the Agent Skills standard, no Claude/Codex-specific references remain).

The extension goes beyond the Codex port in one key way: by using Pi's `tool_call` event (pre-execution, mutable input), it **auto-injects the Chorus session UUID + workflow into each dispatched worker's task** — the Pi-native equivalent of Claude's `SubagentStart` hook. The Codex port has no pre-spawn mutation channel, so its workers must manage sessions manually. On Pi, dispatch a worker via the `subagent` tool and the extension handles session creation + context injection, then closes the session when the (ephemeral) tool call returns.


### Subagent run modes: blocking (bundled) vs async (nicobailon `pi-subagents`)

The bundled `subagent` tool (pi's official reference pattern) is **blocking**:
spawn → run → exit within one tool call, so the extension closes the Chorus
session at `tool_result`. If you instead use the nicobailon `pi-subagents`
package's `subagent` tool, top-level launches are **async (detached)** by
default: `tool_result` returns immediately with `details.asyncId` and the run
completes later. The extension detects this case (`asyncId`/`runId` in
`details`) and defers session close to `subagent:async-complete` /
`subagent:process-terminal` (with `session_shutdown` sweep as a final guard).
Tasks that already carry an injected `--- Chorus session` block (e.g. a
main-agent wave template) are never re-injected.

### Coexistence with nicobailon `pi-subagents`: load-order rule

The bundled subagent (pi's official reference pattern, at `extensions/subagent/`)
registers a tool named `subagent`. The nicobailon `pi-subagents` package registers
a tool with the **same name**. pi's extension loader rejects a duplicate tool
registration with a conflict error (verified on pi 0.84.4:
`Tool "subagent" conflicts with ...`), so the two cannot both register.

**Recommended setup (keep nicobailon, zero conflicts)**: exclude the bundled
subagent extension via a package filter in `settings.packages` — pi's package
entries accept an object form with per-resource glob patterns:

```json
"packages": [
  "npm:pi-subagents",
  {
    "source": "git:github.com/Chorus-AIDLC/chorus/packages/chorus-pi",
    "extensions": ["!extensions/subagent/**"]
  }
]
```

This keeps `chorus.ts` (session hooks) and the `agents/*.md` files (discovered
via `pi.subagents.agents`) while the bundled `subagent` tool never registers —
no conflict error, nicobailon wins deterministically.

| Setup | What happens |
|-------|--------------|
| Only `@chorus-aidlc/chorus-pi` (no external subagents) | Bundled subagent registers and handles dispatch (single/parallel/chain, blocking) |
| Both installed, with the filter above | nicobailon's `subagent` tool is the only one. Chorus session hooks keep working (they match on the tool name) |
| Both installed, no filter: `npm:pi-subagents` listed **before** chorus-pi | nicobailon wins; the bundled subagent reports a conflict error at load (harmless inside an interactive session, noisy for CLI commands like `pi packages list`) |
| Both installed, no filter: `npm:pi-subagents` listed **after** chorus-pi | Bundled subagent wins (it loaded first); nicobailon's tool is rejected. Flip the order to switch |
**How to verify which implementation is active**: run
`subagent({ action: "list" })`. nicobailon output shows `Package agents /
Builtin agents / User agents` sections; the bundled subagent's output has no
such sections.

### Tips when combining with nicobailon `pi-subagents`

- **Sessions work with either tool.** Chorus hooks match on the tool name,
  so `checkin → in_progress → report → checkout → submit_for_verify` flows are
  identical; only close timing differs (blocking closes at `tool_result`, async
  closes on `subagent:async-complete`/`process-terminal`).
- **Why the packaged agents do not set `async: false`.** Under nicobailon
  0.65 a foreground (`async: false`) child runs inside the parent process
  and never loads the parent's ambient extensions — tools registered by an
  ambient adapter such as `pi-mcp-adapter` (`mcp`, `mcpScript`) are
  unavailable, and nicobailon's child-tool diagnostic treats an allowlist
  that declares them as a failed run (exit 1) even if the agent never
  called them. The Chorus reviewers/worker need `mcp` to post verdicts and
  check in, so they run as background children (nicobailon default). Wait
  for completion with `bg_wait`/the run notification; the bundled subagent
  is unaffected because its child is a separate `pi --mode json` process
  that loads extensions.
- **`workflowScript` / `runs.run` / `runs.all`**: nicobailon-only. The bundled
  subagent has no `workflowScript` mode — use `parallel`/`chain` via its own
  schema, or keep nicobailon for scripted waves.
- **Model selection per reviewer**: nicobailon honors `subagent({..., model})`
  per call, `subagents.agentOverrides.<name>.model` in settings, and agent
  frontmatter `model:`. The bundled subagent honors only agent frontmatter
  `model:` (it reads `name`/`description`/`tools`/`model`; its schema has no
  per-call model parameter) — set it in `~/.pi/agent/agents/chorus-*-reviewer.md`.
- **Agent files**: bundled subagent reads package `agents/*.md` + `~/.pi/agent/agents/*.md`
  (user overrides package). nicobailon reads builtin/package/user/project with
  richer frontmatter (`excludeTools`, `thinking`, `inheritSkills`, `extensions`,
  per-agent `tools` allowlists, `model`, ...).
- **Tool-name clash**: both register a `subagent` tool and pi rejects a duplicate
  registration with a conflict error. To keep nicobailon (needed for its
  async/`workflowScript` features), use the package filter above (exclude
  `extensions/subagent/**`); if you instead rely on ordering, list
  `npm:pi-subagents` **before** chorus-pi. Either way, verify with
  `subagent({ action: "list" })` (nicobailon shows `Package/Builtin/User agents`
  sections; bundled does not).
## License

AGPL-3.0
