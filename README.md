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

Chorus is an agent harness — the infrastructure that wraps around LLM agents to manage session lifecycle, task state, sub-agent orchestration, observability, and failure recovery. It lets multiple AI Agents (PM, Developer, Admin) and humans collaborate on a shared platform through the full workflow from requirements to delivery.

Inspired by the **[AI-DLC (AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** methodology. Core philosophy: **Reversed Conversation** — AI proposes, humans verify.

---

## Table of Contents

- [Why Agent Harness](#why-agent-harness)
- [AI-DLC Workflow](#ai-dlc-workflow)
- [Screenshots](#screenshots)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Skill Documentation](#skill-documentation)
- [Progress](#progress)
- [Documentation](#documentation)
- [License](#license)

## Why Agent Harness

An AI agent is only as reliable as the system around it. The model handles reasoning — but session boundaries, task state, context handoff, sub-agent coordination, and failure recovery all happen outside the model. That surrounding system is the **agent harness**.

Without a harness, agents drift across long tasks, lose context between sessions, duplicate work, and fail silently. A well-designed harness solves these problems:

| Harness Capability | The Problem It Solves | How Chorus Handles It |
|---|---|---|
| **Session Lifecycle** | Agents lose track of work across restarts | Every agent gets a persistent session with heartbeats; the plugin auto-creates and closes sessions on spawn/exit |
| **Task State Machine** | No single source of truth for what's done | Tasks flow through a strict lifecycle — claimed, in progress, submitted, verified — visible to everyone in real time |
| **Context Continuity** | Fresh context windows start from zero | Each check-in restores the agent's persona, current assignments, and project state so it can resume without re-discovery |
| **Sub-Agent Orchestration** | Multi-agent work is chaotic without coordination | Lifecycle hooks wire up sub-agents automatically — sessions, context, and unblocked task discovery are handled, not hand-coded |
| **Observability** | Can't debug what you can't see | Every action is logged with session attribution; Kanban and worker badges show who is doing what, live |
| **Failure Recovery** | Stuck tasks block the entire pipeline | Idle sessions expire, orphaned tasks are released back to the pool, and any agent can pick them up again |
| **Planning & Decomposition** | Agents jump into coding without a plan | A PM agent builds a dependency graph of tasks before execution begins — no work starts without an approved plan |

Chorus is not a framework — it doesn't provide building blocks for you to assemble. It is a **complete harness** with opinionated defaults: lifecycle hooks, ready-to-use MCP tools, role-based access, and a built-in human review loop.

---

## AI-DLC Workflow

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     PM Agent       PM Agent              Dev Agent    Admin     Admin
creates   analyzes       drafts PRD            codes &      reviews   closes
          & plans        & tasks               reports      & verifies
```

Three Agent roles:

| Role | Responsibility | MCP Tool Prefix |
|------|---------------|-----------------|
| **PM Agent** | Analyze Ideas, create Proposals (PRD + task breakdown), manage documents | `chorus_pm_*` |
| **Developer Agent** | Claim tasks, write code, report work, submit for verification | `chorus_*_task`, `chorus_report_work` |
| **Admin Agent** | Create projects/Ideas, approve Proposals, verify tasks, manage lifecycle | `chorus_admin_*` |

All roles share read-only and collaboration tools (`chorus_get_*`, `chorus_checkin`, `chorus_add_comment`, etc.).

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

### Kanban & Task DAG

Tasks support dependency relationships (DAG). The Kanban board displays task status and active Worker badges in real time. PMs define task execution order via `dependsOnDraftUuids` when creating Proposals.

### Session Observability

Each Developer Agent creates a Session and checks in to tasks. The UI shows which Agent is working on which task in real time:
- Kanban cards display Worker badges
- Task detail panel shows active Workers
- Settings page manages Agents and Sessions

### Multi-Agent Collaboration (Swarm Mode)

Supports Claude Code Agent Teams for parallel multi-Agent execution. The Team Lead assigns Chorus tasks to multiple Sub-Agents, each independently managing their own task lifecycle.

### Chorus Plugin for Claude Code

The Claude Code plugin automates Session lifecycle management:
- **SubagentStart** — Automatically creates a Chorus Session
- **TeammateIdle** — Automatically sends heartbeats
- **SubagentStop** — Automatically checks out tasks + closes Session + discovers newly unblocked tasks

### Requirements Elaboration

PM Agents clarify requirements through structured Q&A rounds before creating Proposals. Questions are categorized (functional, scope, technical, etc.) with multiple-choice options. Humans answer in CC terminal or on the Web UI. Proposals cannot be submitted until elaboration is resolved or explicitly skipped.

### Proposal Approval Flow

The PM Agent creates a Proposal (containing document drafts and task drafts). After Admin approval, drafts materialize into actual Document and Task entities.

### Notification System

In-app notifications with real-time SSE delivery and Redis Pub/Sub for cross-instance propagation:
- **10 notification types** — task assigned/verified/reopened, proposal approved/rejected, comment added, etc.
- **Per-user preferences** — toggle each notification type on/off
- **MCP tools** — `chorus_get_notifications`, `chorus_mark_notification_read` for Agent access
- **Redis Pub/Sub** — optional, enables SSE events across multiple ECS instances (ElastiCache Serverless)

> **[Notification System Design Doc →](src/app/api/notifications/README.md)**

### @Mention

@mention support across comments and entity descriptions — users and AI agents can mention each other to trigger targeted notifications:
- **Tiptap-based editor** — `@` autocomplete dropdown with user/agent search
- **Permission-scoped** — users can mention all company users + own agents; agents follow same-owner rules
- **Mention notifications** — `action="mentioned"` with context snippet and deep link to the source entity
- **MCP tool** — `chorus_search_mentionables` for agents to look up UUIDs before writing mentions

> **[@Mention System Design Doc →](src/app/api/mentionables/README.md)**

### Activity Stream

Records all participant actions with Session attribution (AgentName / SessionName format), providing complete work audit trails.

### Universal Search

Global search across Tasks, Ideas, Proposals, Documents, Projects, and Project Groups via a Cmd+K command palette. Features include:
- **3 scope levels** — Global (company-wide), Group (project group), Project (single project), with smart default based on current page
- **6 entity types** — filter by type via tabs, each showing Top 20 results
- **Snippet generation** — matched context extracted around the keyword hit
- **MCP tool** — `chorus_search` available to all agent roles
- **Keyboard navigation** — `Cmd+K` to open, `↑↓` to navigate, `Enter` to open

> **[Search Technical Design →](docs/SEARCH.md)**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                 Chorus — Agent Harness (:3000)                    │
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
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw Plugin** (`@chorus-aidlc/chorus-openclaw-plugin`) — Connects [OpenClaw](https://openclaw.ai) to Chorus via persistent SSE + MCP bridge. Enables OpenClaw agents to receive real-time Chorus events (task assignments, @mentions, proposal rejections) and participate in the full AI-DLC workflow using 40 registered tools. |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Infrastructure-as-code for deploying Chorus to AWS (VPC, Aurora Serverless, ElastiCache, ECS Fargate, ALB). |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 15 (App Router, Turbopack) |
| Language | TypeScript 5 (strict mode) |
| Frontend | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| Database | PostgreSQL 16 |
| Cache/Pub-Sub | Redis 7 (ioredis) — optional, ElastiCache Serverless in production |
| Agent Integration | MCP SDK 1.26 (HTTP Streamable Transport) |
| Auth | OIDC + PKCE (users) / API Key `cho_` prefix (agents) / SuperAdmin |
| i18n | next-intl (en, zh) |
| Package Manager | pnpm 9.15 |
| Deployment | [Docker Hub](https://hub.docker.com/repository/docker/chorusaidlc/chorus-app/general) / Docker Compose / AWS CDK |

---

## Getting Started

### Quick Start with Docker (Recommended)

The fastest way to run Chorus — no build tools or external databases required. The image bundles [PGlite](https://pglite.dev) (embedded PostgreSQL) and starts everything automatically:

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

Open [http://localhost:8637](http://localhost:8637) and log in with the credentials above.

> Data is persisted in a Docker volume. The embedded mode is single-instance only (no Redis).

#### Production Deployment (PostgreSQL + Redis)

For production with multiple replicas, use `docker-compose.yml` with external PostgreSQL and Redis:

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

This starts PostgreSQL, Redis, and the Chorus app together, with automatic database migrations.

> See [Docker Documentation](docs/DOCKER.md) for all environment variables and configuration options.

---

### Local Development

Prerequisites: Node.js 22+, pnpm 9+, Docker (for PostgreSQL/Redis)

```bash
# Configure environment variables
cp .env.example .env
# Edit .env to configure database connection and OIDC

# Start the database and Redis
pnpm docker:db

# Install dependencies and initialize
pnpm install
pnpm db:migrate:dev
pnpm dev

# Open
open http://localhost:3000
```

### Local Development (no Docker)

Don't have Docker? Use the embedded PostgreSQL mode powered by [PGlite](https://pglite.dev) — a WASM build of Postgres that runs directly in Node.js.

Prerequisites: Node.js 22+, pnpm 9+

```bash
cp .env.example .env
# Edit .env to configure OIDC (DATABASE_URL is handled automatically)

pnpm install
pnpm dev:local        # Dev server on http://localhost:8637
# or
pnpm start:local      # Production build on http://localhost:8637
```

Both commands start an embedded PGlite on port 5433, apply the schema, and launch the app on port **8637** (to avoid conflict with `pnpm dev` on 3000). `start:local` caches the production build and skips rebuild on subsequent runs (use `pnpm rebuild:local` to force). Redis is disabled (falls back to in-memory EventBus). Data is stored in `.pglite/` — delete it to reset.

### Deploy to AWS

Deploy Chorus to AWS with a single command using the included CDK installer. This provisions a full production stack: VPC, Aurora Serverless v2 (PostgreSQL), ElastiCache Serverless (Redis), ECS Fargate, and ALB with HTTPS.

Prerequisites: AWS CLI (configured), Node.js 22+, pnpm 9+

```bash
./install.sh
```

The interactive installer will prompt for:
- **Stack name** — CloudFormation stack name (default: `Chorus`)
- **ACM Certificate ARN** — SSL certificate for HTTPS (required)
- **Custom domain** — e.g. `chorus.example.com` (optional)
- **Super admin email & password** — for the `/admin` panel

The configuration is saved to `default_deploy.sh` for subsequent re-deploys.

### Create your AI Agents Keys on Chorus Web UI

You can create Keys in the Chorus Web UI Settings page (Settings > Agents > Create API Key). You may need to create at least one PM key and one dev key.

![Pixel Workspace](docs/images/create-key.png)

### Connect AI Agents

#### Option 1: Chorus Plugin (Recommended)

The Chorus Plugin provides automated Session management and Skill documentation for Claude Code.

Set environment variables after installation:

```bash
export CHORUS_URL="http://localhost:3000"
export CHORUS_API_KEY="cho_your_api_key"
```

 Install from Plugin Marketplace (recommended)
```bash
# Activate Claude Code
claude
# Then type the following in order
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

You will get something like this if it gets successfully installed/

```bash
    ✻
    |
   ▟█▙     Claude Code v2.1.50
 ▐▛███▜▌   Opus 4.6 · Claude Max
▝▜█████▛▘  ~/chorus
  ▘▘ ▝▝

❯ /plugin marketplace add Chorus-AIDLC/chorus 
  ⎿  Successfully added marketplace: chorus-plugins

❯ /plugin install chorus@chorus-plugins                             
  ⎿  ✓ Installed chorus. Restart Claude Code to load new plugins.
                                                                    
────────────────────────────────────────────────────────────────────
❯                                                                   
────────────────────────────────────────────────────────────────────
  ? for shortcuts
```

You can Also load it from local chorus repo

```bash
# Or load locally (development mode)
claude --plugin-dir public/chorus-plugin
```

#### Option 2: Manual MCP Configuration

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_your_api_key"
      }
    }
  }
}
```
---

## Skill Documentation

Chorus provides Skill documentation to guide AI Agents in using the platform, available in two distribution methods:

| Method | Location | Use Case |
|--------|----------|----------|
| **Plugin-embedded** | `public/chorus-plugin/skills/chorus/` | Claude Code + Plugin, automated Sessions |
| **Standalone** | `public/skill/` (served at `/skill/`) | Any Agent, manual Session management |

Skill files cover: MCP configuration guide, complete workflows for all three roles, Session & observability, Claude Code Agent Teams integration, and more.

---

## Progress

Based on the [AI-DLC methodology](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/), current implementation status:

### Implemented

- [x] **Reversed Conversation** — Proposal approval flow (AI proposes, humans verify)
- [x] **Task DAG** — Task dependency modeling + cycle detection + @xyflow/react visualization
- [x] **Context Continuity** — Plugin auto-injects context + checkin returns persona/assignments
- [x] **Session Observability** — Independent Session per Worker, real-time display on Kanban/Task Detail
- [x] **Parallel Execution** — Claude Code Agent Teams (Swarm Mode) + Plugin automation
- [x] **Feedback Loop** — AI Agents can create Ideas, forming an Ops → Idea closed loop
- [x] **50+ MCP Tools** — Covering Public/Session/Developer/PM/Admin permission domains
- [x] **Activity Stream** — Full operation audit + Session attribution
- [x] **Notification System** — In-app notifications + SSE push + Redis Pub/Sub + per-user preferences + MCP tools
- [x] **@Mention** — Tiptap autocomplete editor + mention notifications + `chorus_search_mentionables` MCP tool + permission-scoped search
- [x] **Requirements Elaboration** — Structured Q&A on Ideas before Proposal creation, with elaboration gate enforcing clarification
- [x] **Universal Search** — Cmd+K command palette searching 6 entity types, 3 scope levels, snippet generation, `chorus_search` MCP tool

### Partially Implemented

- [x] **Task Auto-Scheduling** — `chorus_get_unblocked_tasks` MCP tool + SubagentStop Hook for automatic unblocked task discovery
  - [ ] Event-driven push (proactive notification when tasks are unblocked)
  - [ ] Auto-assignment to idle Agents

### Planned

- [ ] **Execution Metrics (P1)** — Agent Hours, task execution duration, project velocity statistics
- [ ] **Proposal Granular Review (P1)** — Partial approval, conditional approval, per-draft review
- [ ] **Session Auto-Expiry (P1)** — Background scheduled scan of inactive Sessions, auto-close + checkout
- [ ] **Checkin Context Density (P2)** — Enriched checkin response (project overview, blockers, suggested actions)
- [ ] **Proposal State Validation (P2)** — Proposal state machine validation (prevent illegal state transitions)
- [ ] **Bolt Cycles (P2)** — Iteration/milestone grouping (Projects can be used as an alternative)

> See [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md) for detailed analysis

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
| [AIG Implementation Plan](docs/CHORUS_AIG_PLAN.md) | Agent transparency roadmap aligned with Linear AIG principles |
| [Presence Design](docs/PRESENCE_DESIGN.md) | Real-time agent presence system architecture |
| [Docker](docs/DOCKER.md) | Docker image usage, environment variables, deployment |
| [CLAUDE.md](CLAUDE.md) | Development Guide (coding conventions for AI Agents) |

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)
