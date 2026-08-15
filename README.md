<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>The Agent Harness for AI-Human Collaboration</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><strong>English</strong> · <a href="README.zh.md">中文</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a></p>

<p align="center"><a href="https://doc.chorus-ai.dev"><strong>📖 Documentation</strong></a></p>

Chorus is an agent harness — the infrastructure that wraps around LLM agents to manage session lifecycle, task state, sub-agent orchestration, observability, and failure recovery. It lets multiple AI Agents (with fine-grained, configurable permissions) and humans collaborate through the full workflow from requirements to delivery.

Inspired by the **[AI-DLC (AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** methodology. Core philosophy: **Reversed Conversation** — AI proposes, humans verify.

---

## AI-DLC Workflow

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     idea:write     proposal:write         task:write   *:admin    *:admin
creates   + elaborate    + drafts                + reports   + verifies + closes
```

The labels under each stage are the **permissions** an actor needs at that stage — granted to a human, an Agent (preset or Custom), or both. There are no fixed roles; any combination of the 5 × 3 permission matrix is possible. See [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).

---

## What's New

**[v0.16.1](https://chorus-ai.dev/blog/chorus-v0.16.1-release/)** — One `chorus daemon` now serves many independent agents at once — each with its own key, working directories, backend, and permissions via an `agents[]` array — and agents can hand work to each other by @-mention, with each wake landing in that agent's own project directory.

**[v0.16.0](https://chorus-ai.dev/blog/chorus-v0.16.0-release/)** — A `docs` skill that points agents at the live docs site ([doc.chorus-ai.dev](https://doc.chorus-ai.dev)), so they answer from the current docs instead of reciting from memory.

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — Project-level Agent working directories: each user can bind every Agent in a project to a host and cwd, browse only daemon-approved roots, and use the same target across assignment, wake, resume, and later turns without moving active sessions. Codex now persists its resumable backend thread ID separately and drops obsolete Chorus session-management steps.

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI is the fourth way to connect (Kiro CLI v2): a one-command `install-kiro.sh` plugin and a `--agent kiro` daemon backend, plus daemon fixes.

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — Dark mode across the app (light / dark / system). Reference artifacts: attach docs, repos, issues, and articles to any idea, proposal, or task, readable inline and over MCP. Korean and Japanese locales (Korean contributed by the community). **Theme** ideas for grouping, plus daemon Start Development / Yolo buttons, conversational idea entry, crash-resume, and `chorus daemon install`.

> Full changelog: [CHANGELOG.md](CHANGELOG.md)

---

## Quick Start

Run Chorus locally with two commands — no database, no Docker, no config files needed.

```bash
npm install -g @chorus-aidlc/chorus
chorus
```

That's it. Chorus starts with an embedded PostgreSQL (PGlite), runs migrations automatically, and opens at **http://localhost:8637**.

> **Note:** PGlite is an embedded, single-process PostgreSQL — great for local single-user usage, but its connection handling has limits under concurrent load. If you plan to run multiple agents or users simultaneously, use an external PostgreSQL via `DATABASE_URL=postgresql://...` or the full [Docker Compose](#quick-start-with-docker-recommended) stack.

Default login: `admin@chorus.local` / `chorus`

### Options

```bash
# Custom port
chorus --port 3000

# Custom data directory (default: ~/.chorus-data)
chorus --data-dir /path/to/data

# Custom credentials
DEFAULT_USER=me@example.com DEFAULT_PASSWORD=secret chorus

# Use an external PostgreSQL instead of embedded PGlite
DATABASE_URL=postgresql://user:pass@host:5432/chorus chorus
```

### Other deployment options

| Method | Command |
|--------|---------|
| **npm** (simplest) | `npm i -g @chorus-aidlc/chorus && chorus` |
| **Docker (standalone)** | [`docker compose -f docker-compose.local.yml up`](#quick-start-with-docker-recommended) |
| **Docker (full stack)** | [`docker compose up`](#quick-start-with-docker-recommended) (PostgreSQL + Redis + Chorus) |
| **AWS CDK** | [Deploy to AWS](#deploy-to-aws) |

### `chorus daemon` — Connect as Agent Runtime

The `chorus daemon` connects your local machine to a remote Chorus server as an agent runtime and executes tasks assigned by Chorus.

> **Agent backends:** **Claude Code** (default) and **Codex** are supported — select with `--agent codex` (or `CHORUS_AGENT=codex`). Support for other agent CLIs (Copilot, etc.) is planned for future releases.

```bash
chorus login                     # Authenticate (opens browser)
chorus daemon                    # Start daemon in foreground
chorus daemon -d                 # Start daemon in background (detached)
chorus daemon install            # Install as a boot-autostart service (Linux) — recommended
chorus daemon uninstall          # Remove the installed service
chorus daemon stop               # Stop the daemon (delegates to systemd when installed)
chorus daemon stop --force       # Force-clean the pidfile if a stuck pid blocks stop
chorus daemon status             # Check daemon status
chorus daemon restart            # Restart the daemon
chorus daemon logs               # View daemon logs
```

**Key features:**

- **Claude Code & Codex backends** — Auto-detects the `claude` (or `codex`) CLI on your PATH; pick with `--agent codex`
- **Background mode** — Run with `-d` flag; manage with `stop/restart/logs`
- **Boot-autostart service** — `chorus daemon install` generates a correct `systemd --user` unit and starts it (see below); `status/stop/restart/logs` then transparently delegate to systemd
- **Permission modes** — Default is full access (yolo); use `--chorus-only` to restrict to Chorus MCP tools only
- **Multi-path** — Serve several working directories from one daemon with repeatable `--cwd` (see below)
- **Interactive setup** — Prompts for credentials on first start if not already configured

The daemon requires authentication. Run `chorus login` first, or it will prompt for credentials interactively on first start (if running in a terminal).

#### Run at boot / login — `chorus daemon install`

```bash
chorus daemon install --cwd ~/work/repo-a --cwd ~/work/repo-b   # install + start now, autostart at login
chorus daemon uninstall                                         # disable + remove the service
```

On Linux, `install` generates a `systemd --user` unit that runs the daemon in the **foreground** (`Type=simple`, no `-d`) so systemd owns the process directly, then `daemon-reload` + `enable --now`. It captures the `--cwd`/`--agent`/`--chorus-only` flags you pass. Do **not** hand-write a `Type=forking` unit around `chorus daemon -d` — the daemon self-daemonizes, which systemd can't track and which loops on restart; let `install` write the right unit. On macOS/Windows, `install` prints a correct template you install manually. Run `chorus login` first so the unit can see your credentials. See [docs/DAEMON.md](docs/DAEMON.md) for details.

#### Serve multiple working directories

One daemon can serve several local working directories at once — each declared path registers as an independent connection (its own session + wake loop) under the same agent. A path is **just** a directory the daemon serves; it carries no project binding.

```bash
chorus daemon --cwd ~/work/repo-a --cwd ~/work/repo-b   # repeatable flag
CHORUS_DAEMON_CWDS="~/work/repo-a:~/work/repo-b" chorus daemon   # or env (`:`- or `,`-separated)
```

With no `--cwd`, the daemon serves the single directory it was launched from.

#### Configuration file — `~/.chorus/daemon.json`

`chorus login` writes credentials here (mode `0600`). You can also add daemon tunables to the **same** file. Every field is optional; flags and environment variables always take precedence over the file.

```json
{
  "url": "https://chorus.example.com",
  "apiKey": "cho_xxxxxxxxxxxxxxxxxxxxxxxx",
  "agentUuid": "00000000-0000-0000-0000-000000000000",
  "agentName": "My Daemon Agent",
  "cwds": ["~/work/repo-a", "~/work/repo-b"],
  "agent": "codex",
  "sigintTimeoutMs": 10000
}
```

| Field | Type | Written by / used for | Precedence (highest first) |
|-------|------|-----------------------|----------------------------|
| `url` | string | Remote Chorus server URL | `--url` flag → `CHORUS_URL` → file |
| `apiKey` | string | Agent API key (`cho_…`) | `--api-key` flag → `CHORUS_API_KEY` → file |
| `agentUuid` / `agentName` | string | Authenticated identity (recorded at login) | written by `chorus login` |
| `cwds` | string[] | Working directories the daemon serves (multi-path) | `--cwd` flag(s) → `CHORUS_DAEMON_CWDS` → file → launch dir |
| `browseRoots` | string[] | Roots allowed for project and temporary directory browsing | `--browse-root` flag(s) → `CHORUS_DAEMON_BROWSE_ROOTS` → file → user home |
| `agent` | string | Local agent backend to wake (`claude-code` / `codex` / `kiro`) | `--agent` flag → `CHORUS_AGENT` → file → `claude-code` |
| `sigintTimeoutMs` | number | Grace window (ms) after SIGINT before a forceful kill (default `10000`) | `--sigint-timeout` flag → `CHORUS_DAEMON_SIGINT_TIMEOUT` → file → `10000` |
| `yoloAckAt` | string | Internal — timestamp of a TTY yolo confirmation (managed automatically) | — |

On startup the daemon banner prints the **exact `daemon.json` path it read** (and whether the file exists), so you always know which file to edit.

---

## Screenshots

### Remote Agent Wake — Dispatch to a Directory, Watch It Run

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

Assign an idea to a specific directory on a remote agent, then open the conversation and watch the local Claude Code pick up the work and run in real time — no terminal, no manual resume.

### Project Resource Graph — The Whole Project as a Live Mind-Map

![Project Resource Graph](packages/landing/public/images/mind-map.png)

Chorus auto-organizes the entire project into a mind-map — Ideas, Proposals, Documents, and Tasks laid out as one connected tree — and reflects what the agents are doing in real time, with each card's status updating live as work progresses.

### Proposal — AI Agent Generates Plans in Real Time

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

Watch a PM Agent analyze requirements and generate a proposal with PRD and task DAG — with real-time presence indicators showing agent activity.

### Pixel Workspace — Real-time Agent Status

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

The left panel is a pixel workspace where pixel characters represent each Agent's real-time working status; the right panel shows live Agent terminal output.

### Kanban — Real-time Task Flow

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

The Kanban board updates automatically as Agents work, with task cards flowing between To Do → In Progress → To Verify in real time. Agent presence indicators highlight which resources are being worked on.

### Kanban & Task DAG

![Kanban & Task DAG](packages/landing/public/images/kanban-dag.png)

Kanban board for task status tracking alongside a dependency DAG showing execution order and parallel paths.

### Idea & Requirements Elaboration

![Idea & Elaboration](packages/landing/public/images/idea-elaborate.png)

PM Agents clarify requirements through structured Q&A rounds before creating Proposals. The panel shows idea details alongside completed elaboration rounds with answers and category tags.

### Proposal Review

![Proposal Review](packages/landing/public/images/proposal.png)

Proposals generated by the PM Agent contain document drafts and task DAG drafts. Admins review and approve or reject on this panel.

### Acceptance Criteria — Dual-Path Verification

![Acceptance Criteria](packages/landing/public/images/task-ac.png)

Dev Agent self-checks and Admin reviews each acceptance criterion independently, with structured pass/fail evidence for every item.

### Universal Search — Cmd+K Command Palette

![Universal Search](packages/landing/public/images/universal-search.png)

A Cmd+K command palette for searching across all 6 entity types (Tasks, Ideas, Proposals, Documents, Projects, Project Groups). Supports scope filtering (Global / Group / Project), filter tabs per entity type, and keyboard navigation. Both the Web UI and AI agents (via `chorus_search` MCP tool) share the same search backend.

---

## Features

- **Session Lifecycle** — Persistent sessions with heartbeats, auto-expiry, and failure recovery
- **Task DAG** — Dependency modeling, cycle detection, and interactive visualization
- **Kanban** — Real-time task flow with Worker badges and agent presence
- **Multi-Agent Collaboration** — Claude Code Agent Teams (Swarm Mode) for parallel execution
- **Fine-Grained Agent Permissions** — 5 resources × 3 actions grid with preset + custom combinations ([details](docs/PERMISSIONS.md))
- **Chorus Plugin** — Lifecycle hooks automate session create/close, heartbeats, and context injection
- **Requirements Elaboration** — Structured Q&A rounds before proposal creation
- **Proposal Approval Flow** — PM drafts, Admin approves, drafts materialize into real entities
- **Notifications** — In-app + SSE push + Redis Pub/Sub with per-user preferences ([design doc](src/app/api/notifications/README.md))
- **@Mention** — Tiptap autocomplete, permission-scoped search, mention notifications ([design doc](src/app/api/mentionables/README.md))
- **Activity Stream** — Full audit trail with session attribution
- **Universal Search** — Cmd+K across 6 entity types, 3 scope levels, snippet generation ([design doc](docs/SEARCH.md))
---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                 Chorus — Agent Harness (:8637)                    │
│                                                                  │
│  ┌── Harness Capabilities ───────────────────────────────────┐   │
│  │  Session Lifecycle │ Task State Machine │ Context Inject   │   │
│  │  Sub-Agent Orchestration │ Observability │ Failure Recovery│   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Chorus Plugin (lifecycle hooks) ────────────────────────┐   │
│  │  SubagentStart/Stop │ Heartbeat │ Skill & Context Inject  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── API Layer ──────────────────────────────────────────────┐   │
│  │  /api/mcp  — MCP Streaming (50+ tools, permission-gated)  │   │
│  │  /api/*    — REST API (Web UI + SSE push)                 │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Service Layer ──────────────────────────────────────────┐   │
│  │  AI-DLC Workflow │ UUID-first │ Multi-tenant              │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Web UI (React 19 + Tailwind + shadcn/ui) ──────────────┐   │
│  │  Kanban │ Task DAG │ Proposals │ Activity │ Sessions      │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
     ↑              ↑              ↑              ↑
  Agent w/      Agent w/       Agent w/         Human
  idea+proposal  task:write    *:admin perms   (Browser)
   :write perms    perms      (proxy approval)
   (LLM)          (LLM)         (LLM)
                     │
          ┌──────────▼──────────┐   ┌─────────────────────┐
          │  PostgreSQL + Prisma │   │  Redis (optional)   │
          └─────────────────────┘   │  Pub/Sub for SSE    │
                                    └─────────────────────┘
```

### Packages

| Package | Description |
|---------|-------------|
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw Plugin** — Connects [OpenClaw](https://openclaw.ai) to Chorus via persistent SSE + MCP bridge. |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Infrastructure-as-code for deploying Chorus to AWS. |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 15 (App Router, Turbopack) |
| Language | TypeScript 5 (strict mode) |
| Frontend | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| Database | PostgreSQL 16 |
| Cache/Pub-Sub | Redis 7 (ioredis) — optional |
| Agent Integration | MCP SDK 1.26 (HTTP Streamable Transport) |
| Auth | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| Deployment | [Docker Hub](https://hub.docker.com/r/chorusaidlc/chorus-app) / Docker Compose / AWS CDK |

---

## Getting Started

### Quick Start with Docker (Recommended)

No build tools or external databases required. The image bundles [PGlite](https://pglite.dev) (embedded PostgreSQL):

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

Open [http://localhost:8637](http://localhost:8637) and log in with the credentials above.

> Data is persisted in a Docker volume. The embedded mode is single-instance only (no Redis).

#### Production Deployment (PostgreSQL + Redis)

For production with multiple replicas:

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

> See [Docker Documentation](docs/DOCKER.md) for all environment variables and configuration options.

---

### Local Development

Prerequisites: Node.js 22+, pnpm 9+, Docker (for PostgreSQL/Redis)

```bash
cp .env.example .env
pnpm docker:db
pnpm install
pnpm db:migrate:dev
pnpm dev
# Open http://localhost:8637
```

### Local Development (no Docker)

Prerequisites: Node.js 22+, pnpm 9+

```bash
cp .env.example .env
pnpm install
pnpm dev:local        # Dev server on http://localhost:8637
```

PGlite runs embedded PostgreSQL on port 5433. Data stored in `.pglite/` — delete to reset.

### Deploy to AWS

```bash
./install.sh
```

The interactive installer provisions VPC, Aurora Serverless v2, ElastiCache Serverless, ECS Fargate, and ALB with HTTPS. Configuration saved to `default_deploy.sh` for re-deploys.

### Connect AI Agents

The fastest path is the in-app setup wizard: open the Web UI, go to **Settings → Setup Guide → Open setup guide**, and follow the step-by-step instructions for your client (Claude Code, Codex, Kiro, OpenCode, OpenClaw, or other agents). The wizard creates the API key for you, shows the exact commands, and walks through verifying the connection.

If you'd rather read the full docs:

| Client | Guide |
|--------|-------|
| Claude Code | [CONNECT_CLAUDE_CODE.md](docs/CONNECT_CLAUDE_CODE.md) |
| Codex CLI | [CONNECT_CODEX.md](docs/CONNECT_CODEX.md) |
| Pi coding agent | [CONNECT_PI.md](docs/CONNECT_PI.md) |
| Kiro CLI | [CONNECT_KIRO.md](docs/CONNECT_KIRO.md) |
| OpenCode † | [CONNECT_OPENCODE.md](docs/CONNECT_OPENCODE.md) |
| Other MCP agents (Cursor, Continue, custom, …) | [CONNECT_OTHER_AGENTS.md](docs/CONNECT_OTHER_AGENTS.md) |

† OpenCode support is provided by the community-maintained [`opencode-chorus`](https://github.com/etnperlong/opencode-chorus) plugin (npm: [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus)), authored by [@etnperlong](https://github.com/etnperlong). Thanks!

Create API Keys in the Web UI under **Settings → Agents → Create API Key**. Keys start with `cho_` and are shown only once.

![Create API Key](packages/landing/public/images/create-key.png)

---

## Skill Documentation

| Method | Location | Use Case |
|--------|----------|----------|
| **Plugin-embedded (Claude Code)** | `public/chorus-plugin/skills/` | Claude Code + Chorus plugin, automated Sessions and lifecycle hooks |
| **Plugin-embedded (Codex CLI)** | `plugins/chorus/skills/` | Codex CLI + Chorus plugin, ported skills with `$`-prefixed slash commands |
| **Package-embedded (Pi)** | `packages/chorus-pi/skills/` | Pi + Chorus package, automated Sessions and lifecycle hooks |
| **Standalone** | `public/skill/` (served at `/skill/`) | Any other MCP-capable Agent (Cursor, Continue, custom), manual Session management |

### OpenSpec mode (opt-in, plugin 0.8.1+)

PM agents that have the [OpenSpec](https://github.com/Fission-AI/OpenSpec)
CLI installed can author proposals in a structured `proposal.md` +
`design.md` + `specs/<capability>/spec.md` layout. Local files are the
working copy and Chorus `documentDrafts` are the mirror; reviewers see a
predictable shape (`## ADDED Requirements`, `### Requirement:`,
`#### Scenario:`) instead of free-form Markdown. A PostToolUse hook on
`chorus_admin_verify_task` injects an `openspec archive <slug>` reminder
when the last task of an OpenSpec idea is verified, so finalized specs
are merged into the long-term spec set right after sign-off. The mode is
strictly opt-in: when `openspec` is not installed, behavior is unchanged.
Master switch on Claude Code is `enableOpenSpec` (plugin userConfig,
default `true`); both clients also honor `CHORUS_OPENSPEC_MODE=off`. No
new MCP tools or schema changes ship in this mode; the canonical skill
reuses the existing `chorus_pm_*` draft and document tools, with mirror
calls routed through the `chorus-api.sh` wrapper to keep multi-thousand-
line markdown out of LLM context. See
[OPENSPEC_MODE.md](docs/OPENSPEC_MODE.md) for the full guide.

---

## Documentation

| Document | Description |
|----------|------------|
| [PRD](docs/PRD_Chorus.md) | Product Requirements Document |
| [Architecture](docs/ARCHITECTURE.md) | Technical Architecture Document |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP Tools Reference |
| [Permissions](docs/PERMISSIONS.md) | Agent permission model (5 × 3 matrix, presets, Custom mode) |
| [Chorus Plugin](docs/chorus-plugin.md) | Plugin Design & Hook Documentation |
| [OpenSpec Mode](docs/OPENSPEC_MODE.md) | Opt-in OpenSpec authoring mode for PM agents (Plugin 0.8.1+) |
| [Search](docs/SEARCH.md) | Global Search Technical Design |
| [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md) | AI-DLC Methodology Gap Analysis |
| [AIG Implementation Plan](docs/CHORUS_AIG_PLAN.md) | Agent transparency roadmap |
| [Presence Design](docs/PRESENCE_DESIGN.md) | Real-time agent presence system |
| [Docker](docs/DOCKER.md) | Docker image usage & deployment |
| [Logging](docs/LOGGING.md) | Structured logging architecture |
| [CLAUDE.md](CLAUDE.md) | Development Guide |

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)

## FAQ

### What is Chorus?

Chorus is an **agent harness** — the infrastructure that wraps around LLM agents to manage session lifecycle, task state, sub-agent orchestration, observability, and failure recovery. It enables multiple AI Agents (with fine-grained, configurable permissions) and humans to collaborate through the full workflow from requirements to delivery.

### How does Chorus differ from other agent frameworks?

| Feature | Chorus | Others |
|---------|--------|--------|
| **Permission System** | 5×3 matrix (idea/proposal/task/document × write/admin) | Fixed roles (PM/Dev/Admin) |
| **Workflow** | AI-DLC (Idea → Proposal → Execute → Verify) | Single agent execution |
| **Collaboration** | Multi-agent + Human collaboration | Agent-only |
| **Reversed Conversation** | AI proposes, humans verify | Human instructs, AI executes |

### What is the AI-DLC methodology?

**AI-DLC (AI-Driven Development Lifecycle)** is the core philosophy: **Reversed Conversation** — AI proposes, humans verify.

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     idea:write     proposal:write         task:write   *:admin    *:admin
creates   + elaborate    + drafts                + reports   + verifies + closes
```

### How to install Chorus?

**npm (simplest):**
```bash
npm install -g @chorus-aidlc/chorus
chorus
```

**Docker (standalone):**
```bash
docker compose -f docker-compose.local.yml up
```

**Docker (full stack):**
```bash
docker compose up
```

### What are the default credentials?

Default login: `admin@chorus.local` / `chorus`

### What deployment options are available?

| Method | Command |
|--------|---------|
| npm (simplest) | `npm i -g @chorus-aidlc/chorus && chorus` |
| Docker (standalone) | `docker compose -f docker-compose.local.yml up` |
| Docker (full stack) | `docker compose up` |
| AWS CDK | Deploy to AWS |

### What is PGlite mode?

PGlite is an embedded, single-process PostgreSQL — great for local single-user usage. If you plan to run multiple agents or users simultaneously, use an external PostgreSQL via `DATABASE_URL=postgresql://...`.

### What permissions are available?

The permission system is a **5 × 3 matrix**:

| Resource | Write | Admin |
|----------|-------|-------|
| Idea | Create + Elaborate | Verify + Close |
| Proposal | Draft | Approve/Reject |
| Task | Report | Verify |
| Document | Write | Manage |
| Project | Create | Admin |

### What are the key features?

- **IdeaTracker Dashboard** — Track ideas through elaboration
- **Proposal Review** — AI-generated plans with PRD + Task DAG
- **Kanban Board** — Real-time task flow with presence indicators
- **Pixel Workspace** — Visual agent status representation
- **Agent Team** — Parallel execution with multiple agents
- **OpenSpec Integration** — Claude Code OpenSpec-aware mode

### What is the `/yolo` skill?

`/yolo` skill enables full-auto AI-DLC pipeline: **Idea → Proposal → Execute → Verify** with Agent Team parallel execution.

### Where can I find help?

- **Documentation**: [chorus-ai.dev](https://chorus-ai.dev)
- **Discord**: [Join us](https://discord.gg/SwcCMaMmR)
- **GitHub Issues**: [Issues](https://github.com/Chorus-AIDLC/Chorus/issues)
- **Blog**: [Changelog](https://chorus-ai.dev/blog/)

### License

MIT License — Open source with full code reuse.
