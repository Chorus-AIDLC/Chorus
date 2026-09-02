# chorus-pi — Chorus AI-DLC extension for the Pi coding agent

Chorus AI-DLC collaboration platform extension for [Pi](https://pi.dev). Ported from the Claude Code plugin (`public/chorus-plugin/`) and the Codex port (`plugins/chorus/`) following the same methodology documented in `docs/codex-plugin-plan.md`.

## What this package provides

- **12 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`, `/skill:brainstorm`, `/skill:orchestrate`, `/skill:docs`, `/skill:chorus-cli`, `/skill:openspec-aware`
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`
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
├── agents/                   # 3 reviewer sub-agents — discovered package-relative by extensions/subagent/agents.ts (no manual copy)
│   ├── chorus-proposal-reviewer.md
│   ├── chorus-task-reviewer.md
│   └── chorus-code-reviewer.md
├── bin/
│   └── chorus-mcp-call.sh    # stateless MCP-over-HTTP wrapper (from the Codex port) for OpenSpec byte-exact document mirroring
└── README.md
```
## Status

**Complete port** of the Claude Code / Codex plugins to Pi. All 12 skills, all 3 reviewer sub-agents, the session-aware extension, the bundled official subagent pattern, and the OpenSpec wrapper are implemented and validated (TS transpiles, JSON valid, all skill/agent names compliant with the Agent Skills standard, no Claude/Codex-specific references remain).

The extension goes beyond the Codex port in one key way: by using Pi's `tool_call` event (pre-execution, mutable input), it **auto-injects the Chorus session UUID + workflow into each dispatched worker's task** — the Pi-native equivalent of Claude's `SubagentStart` hook. The Codex port has no pre-spawn mutation channel, so its workers must manage sessions manually. On Pi, dispatch a worker via the `subagent` tool and the extension handles session creation + context injection, then closes the session when the (ephemeral) tool call returns.

## License

AGPL-3.0
