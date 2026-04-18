<p align="center">
  <img src="docs/images/chorus-slug.png" alt="Chorus" width="240" />
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

<p align="center"><a href="README.zh.md">中文</a></p>

Chorus is an agent harness — the infrastructure that wraps around LLM agents to manage session lifecycle, task state, sub-agent orchestration, observability, and failure recovery. It lets multiple AI Agents (PM, Developer, Admin) and humans collaborate through the full workflow from requirements to delivery.

Inspired by the **[AI-DLC (AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** methodology. Core philosophy: **Reversed Conversation** — AI proposes, humans verify.

---

## AI-DLC Workflow

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     PM Agent       PM Agent              Dev Agent    Admin     Admin
creates   analyzes       drafts PRD            codes &      reviews   closes
          & plans        & tasks               reports      & verifies
```

---

## What's New

**[v0.6.2](https://chorus-ai.dev/blog/chorus-v0.6.2-release/)** — Embedded PGlite mode (zero-dependency deployment), structured logging with Pino, stateless MCP for horizontal scaling, default port changed to 8637.

**[v0.6.1](https://chorus-ai.dev/blog/chorus-v0.6.1-release/)** — `/yolo` skill: full-auto AI-DLC pipeline (Idea → Proposal → Execute → Verify) with Agent Team parallel execution.

**[v0.6.0](https://chorus-ai.dev/blog/chorus-v0.6.0-release/)** — IdeaTracker dashboard, independent review agents (proposal-reviewer + task-reviewer), real-time agent presence indicators, cross-column Kanban animation.

**v0.5.1** — New user onboarding wizard, UI animation system, quick-dev skill (skip-proposal workflow).

**v0.5.0** — Universal search (Cmd+K across 6 entity types), rich claim/assign response.

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

---

## Screenshots

### Proposal — AI Agent Generates Plans in Real Time

![Proposal Presence](docs/images/proposal-presence.gif)

Watch a PM Agent analyze requirements and generate a proposal with PRD and task DAG — with real-time presence indicators showing agent activity.

### Pixel Workspace — Real-time Agent Status

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

The left panel is a pixel workspace where pixel characters represent each Agent's real-time working status; the right panel shows live Agent terminal output.

### Kanban — Real-time Task Flow

![Kanban Presence](docs/images/kanban-presence.gif)

The Kanban board updates automatically as Agents work, with task cards flowing between To Do → In Progress → To Verify in real time. Agent presence indicators highlight which resources are being worked on.

### Kanban & Task DAG

![Kanban & Task DAG](docs/images/kanan-dag.png)

Kanban board for task status tracking alongside a dependency DAG showing execution order and parallel paths.

### Idea & Requirements Elaboration

![Idea & Elaboration](docs/images/idea-elaborate.png)

PM Agents clarify requirements through structured Q&A rounds before creating Proposals. The panel shows idea details alongside completed elaboration rounds with answers and category tags.

### Proposal Review

![Proposal Review](docs/images/proposal.png)

Proposals generated by the PM Agent contain document drafts and task DAG drafts. Admins review and approve or reject on this panel.

### Acceptance Criteria — Dual-Path Verification

![Acceptance Criteria](docs/images/task-ac.png)

Dev Agent self-checks and Admin reviews each acceptance criterion independently, with structured pass/fail evidence for every item.

### Universal Search — Cmd+K Command Palette

![Universal Search](docs/images/universal-search.png)

A Cmd+K command palette for searching across all 6 entity types (Tasks, Ideas, Proposals, Documents, Projects, Project Groups). Supports scope filtering (Global / Group / Project), filter tabs per entity type, and keyboard navigation. Both the Web UI and AI agents (via `chorus_search` MCP tool) share the same search backend.

---

## Features

- **Session Lifecycle** — Persistent sessions with heartbeats, auto-expiry, and failure recovery
- **Task DAG** — Dependency modeling, cycle detection, and interactive visualization
- **Kanban** — Real-time task flow with Worker badges and agent presence
- **Multi-Agent Collaboration** — Claude Code Agent Teams (Swarm Mode) for parallel execution
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
│  │  /api/mcp  — MCP HTTP Streamable (50+ tools, role-based)  │   │
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
  PM Agent    Developer Agent  Admin Agent      Human
   (LLM)         (LLM)          (LLM)        (Browser)
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
| i18n | next-intl (en, zh) |
| Deployment | [Docker Hub](https://hub.docker.com/repository/docker/chorusaidlc/chorus-app/general) / Docker Compose / AWS CDK |

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

Create API Keys in the Web UI (Settings > Agents > Create API Key).

![Create API Key](docs/images/create-key.png)

#### Option 1: Chorus Plugin (Recommended)

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

Install from Plugin Marketplace:

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

Or load locally:

```bash
claude --plugin-dir public/chorus-plugin
```

#### Option 2: Manual MCP Configuration

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_your_api_key"
      }
    }
  }
}
```

---

## Skill Documentation

| Method | Location | Use Case |
|--------|----------|----------|
| **Plugin-embedded** | `public/chorus-plugin/skills/chorus/` | Claude Code + Plugin, automated Sessions |
| **Standalone** | `public/skill/` (served at `/skill/`) | Any Agent, manual Session management |

---

## Documentation

| Document | Description |
|----------|------------|
| [PRD](docs/PRD_Chorus.md) | Product Requirements Document |
| [Architecture](docs/ARCHITECTURE.md) | Technical Architecture Document |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP Tools Reference |
| [Chorus Plugin](docs/chorus-plugin.md) | Plugin Design & Hook Documentation |
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
