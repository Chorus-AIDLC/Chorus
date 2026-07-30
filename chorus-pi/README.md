# chorus-pi — Chorus AI-DLC extension for the Pi coding agent

Chorus AI-DLC collaboration platform extension for [Pi](https://pi.dev). Ported from the Claude Code plugin (`public/chorus-plugin/`) and the Codex port (`plugins/chorus/`) following the same methodology documented in `docs/codex-plugin-plan.md`.

## What this package provides

- **7 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`
- **1 session-aware extension** (`extensions/chorus.ts`) — subscribes to Pi native events to automate checkin, context injection, reviewer nudges, and session lifecycle

## Install

```bash
# runtime deps
pi install npm:pi-mcp-adapter
pi install npm:@narumitw/pi-subagents

# this package (from repo)
pi install ./chorus-pi
# or once published
pi install npm:@chorus-aidlc/chorus-pi
```

### Install the reviewer agents

Pi's `pi-subagents` loads custom agents from `~/.pi/agent/agents/*.md` (user-level) or `.pi/agents/*.md` (project-level) — **not** from the package manifest. Copy the bundled reviewer agent definitions so `subagent_spawn` can find them:

```bash
mkdir -p ~/.pi/agent/agents
cp chorus-pi/agents/*.md ~/.pi/agent/agents/
```

> The package ships all three reviewer agents (`chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`). Without this copy step the reviewer skills cannot spawn and the YOLO / review pipelines fail at their first review gate.

Then configure `.mcp.json` and env vars — see `docs/CONNECT_PI.md`.

## Why Pi is the lowest-friction target

- **MCP: zero installer.** `pi-mcp-adapter` auto-discovers the repo's `.mcp.json` (literal URL + Bearer — no `${VAR}` expansion needed, unlike Codex). The main agent gets all 40+ `chorus_*` tools with no setup script.
- **Hooks: TypeScript, not bash.** The extension replaces ~10 bash hook scripts with one TS file. No `curl`/`jq`, no Bash 3.2 compatibility traps (the `${2:-{}}` JSON-parse bug that plagued the Codex port is structurally impossible here).
- **Sub-agent sessions: automatic.** By monitoring `subagent_spawn` / `subagent_manage` tool events, the extension auto-creates and closes Chorus sessions — a capability the Codex port lacks (Codex has no sub-agent lifecycle events, so its workers manage sessions manually).
- **Skills: same standard.** Pi implements the Agent Skills standard, so the skill bodies port with find/replace only (Claude's `Task` tool → `subagent_spawn`; `/chorus:develop` → `/skill:develop`).

## Structure

```
chorus-pi/
├── package.json              # pi.extension entry + peerDeps
├── extensions/
│   └── chorus.ts             # session_start / before_agent_start / tool_execution_end / session_shutdown
├── skills/                   # 8 Agent Skills standard SKILL.md (ported from public/chorus-plugin/skills)
│   ├── chorus/                # core overview + routing
│   ├── idea/ proposal/ develop/ review/  # AI-DLC stage workflows
│   ├── quick-dev/ yolo/       # shortcut + full-auto pipelines
│   └── openspec-aware/        # opt-in spec-driven authoring sub-procedure
├── agents/                   # 3 reviewer sub-agents — copy to ~/.pi/agent/agents/ (pi-subagents loads from there, NOT the package manifest)
│   ├── chorus-proposal-reviewer.md
│   ├── chorus-task-reviewer.md
│   └── chorus-code-reviewer.md
├── bin/
│   └── chorus-mcp-call.sh    # stateless MCP-over-HTTP wrapper (from the Codex port) for OpenSpec byte-exact document mirroring
└── README.md
```
## Status

**Complete port** of the Claude Code / Codex plugins to Pi. All 8 skills, all 3 reviewer sub-agents, the session-aware extension, and the OpenSpec wrapper are implemented and validated (TS transpiles, JSON valid, all skill/agent names compliant with the Agent Skills standard, no Claude/Codex-specific references remain).

The extension goes beyond the Codex port in one key way: by using Pi's `tool_call` event (pre-execution, mutable input), it **auto-injects the Chorus session UUID + workflow into each spawned worker's task** — the Pi-native equivalent of Claude's `SubagentStart` hook. The Codex port has no pre-spawn mutation channel, so its workers must manage sessions manually. On Pi, `subagent_spawn` a worker and the extension handles session creation + context injection; `subagent_manage close` the agent and it closes the session.

## License

AGPL-3.0
