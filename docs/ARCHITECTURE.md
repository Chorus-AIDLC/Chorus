> [中文版本](./ARCHITECTURE.zh.md)

# Project Chorus - Technical Architecture

**Version**: 2.0
**Updated**: 2026-02-18

---

## 1. System Overview

### 1.1 Positioning

Chorus is a platform for AI Agent and human collaboration, implementing the AI-DLC (AI-Driven Development Lifecycle) methodology. The core philosophy is **Reversed Conversation**: AI proposes, humans verify.

### 1.2 Core Capabilities

| Capability | Description |
|-----|------|
| **Knowledge Base** | Project context storage and querying |
| **Task Management** | Task CRUD, status transitions, Kanban, **Task DAG dependencies** |
| **Assignment Mechanism** | Flexible Idea/Task assignment, supporting human and Agent collaboration |
| **Proposal Approval** | PM Agent creates proposals, humans/Admin approve |
| **MCP Server** | 50+ tools, Agents connect via MCP protocol (Public/Session/Developer/PM/Admin) |
| **Activity Stream** | Real-time tracking of all participant actions (with Session attribution) |
| **Notification System** | In-app notifications with SSE push, preference controls, MCP tools for agents |
| **Session Observability** | Agent Session + Task Checkin, Kanban/Task Detail displays active Workers in real-time |
| **Chorus Plugin** | Claude Code plugin, automating Session lifecycle (create/heartbeat/close) |
| **Task DAG** | Task dependency modeling, cycle detection, @xyflow/react + dagre visualization |

### 1.3 Participants

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Chorus Platform                              │
└─────────────────────────────────────────────────────────────────────┘
        ↑               ↑               ↑               ↑
        │               │               │               │
   ┌────┴────┐    ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
   │  Human  │    │ PM Agent  │   │ Developer │   │  Admin    │
   │         │    │           │   │  Agent    │   │  Agent    │
   └─────────┘    └───────────┘   └───────────┘   └───────────┘
   Web UI access   Claude Code     Claude Code     Claude Code
   Approve proposals  Propose tasks  Execute tasks  Proxy approval
```

**Agent Role Descriptions**:
- **PM Agent**: Requirements analysis, task breakdown, proposal creation
- **Developer Agent**: Execute tasks, report work, submit for verification
- **Admin Agent**: Proxy human actions such as approving Proposals, verifying Tasks, creating Projects, etc. (Warning: dangerous permissions)

---

## 2. Tech Stack

### 2.1 Core Technology Choices

| Layer | Technology | Version | Rationale |
|---|------|------|---------|
| **Framework** | Next.js | 15.x | Full-stack unified, App Router, RSC support |
| **Language** | TypeScript | 5.x | Type safety, frontend-backend consistency |
| **ORM** | Prisma | 7.x | Type safety, migration management, good DX, no foreign key constraint design |
| **Database** | PostgreSQL | 16 | Reliable, JSON support, future pgvector extensibility |
| **UI Components** | shadcn/ui | - | Based on Radix, customizable, elegant |
| **Styling** | Tailwind CSS | 4.x | Atomic CSS, rapid development |
| **Auth** | next-auth | 5.x | OIDC support, deep Next.js integration |
| **MCP SDK** | @modelcontextprotocol/sdk | latest | Official TypeScript SDK |
| **Cache/Pub-Sub** | Redis (ioredis) | 7.x | Cross-instance SSE event delivery via ElastiCache Serverless |
| **Containerization** | Docker Compose | - | One-click local dev setup |

### 2.2 Development Tools

| Tool | Purpose |
|-----|------|
| pnpm | Package management |
| ESLint + Prettier | Code standards |
| Vitest | Unit testing |
| Playwright | E2E testing |

---

## 3. System Architecture

### 3.1 Overall Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clients                                 │
├──────────────────┬──────────────────┬───────────────────────────┤
│    Web Browser   │    PM Agent      │    Personal Agent         │
│    (Human)       │    (Claude Code) │    (Claude Code)          │
└────────┬─────────┴────────┬─────────┴─────────┬─────────────────┘
         │                  │                   │
         │ HTTPS            │ MCP/HTTP          │ MCP/HTTP
         │                  │                   │
┌────────▼──────────────────▼───────────────────▼─────────────────┐
│                     Next.js Application                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Middleware Layer                       │   │
│  │  - OIDC Authentication (Human)                           │   │
│  │  - API Key Authentication (Agent)                        │   │
│  │  - Rate Limiting                                         │   │
│  │  - Request Logging                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────┐  ┌─────────────────────────────────┐   │
│  │ Server Components   │  │        API Routes               │   │
│  │ + Server Actions    │  │      (Agent-only)               │   │
│  │   (Human frontend)  │  │                                 │   │
│  │                     │  │  /api/projects/*                │   │
│  │  - Dashboard        │  │  /api/ideas/*                   │   │
│  │  - Project Overview │  │  /api/documents/*               │   │
│  │  - Ideas List       │  │  /api/tasks/*                   │   │
│  │  - Documents List   │  │  /api/proposals/*               │   │
│  │  - Kanban Board     │  │  /api/agents/*                  │   │
│  │  - Proposal Review  │  │  /api/auth/*                    │   │
│  │  - Activity Feed    │  │  /api/mcp    <- MCP HTTP endpoint│   │
│  └─────────────────────┘  └─────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Service Layer                          │   │
│  │  - ProjectService      - IdeaService                     │   │
│  │  - DocumentService     - TaskService                     │   │
│  │  - ProposalService     - CommentService                  │   │
│  │  - AgentService        - ActivityService                 │   │
│  │  - AssignmentService                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Data Access Layer                      │   │
│  │                    (Prisma Client)                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │    PostgreSQL     │
                    │    Database       │
                    └───────────────────┘
```

### 3.2 Controller-Service-DAO Architecture

Chorus adopts the classic three-layer architecture pattern with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Controller Layer                              │
│                    (Next.js API Routes)                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Responsibilities:                                       │   │
│  │  - Request/response handling                             │   │
│  │  - Auth/authorization checks                             │   │
│  │  - Parameter validation                                  │   │
│  │  - Calling the Service layer                             │   │
│  │  - Response formatting                                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Code location: src/app/api/**/*.ts                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Service Layer                                 │
│                    (Business Logic)                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Responsibilities:                                       │   │
│  │  - Business logic implementation                         │   │
│  │  - Data querying and transformation                      │   │
│  │  - Transaction management                                │   │
│  │  - Cross-entity operation coordination                   │   │
│  │  - State machine validation                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Code location: src/services/*.service.ts                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DAO Layer                                     │
│                    (Prisma Client)                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Responsibilities:                                       │   │
│  │  - Database operation encapsulation                      │   │
│  │  - ORM mapping                                           │   │
│  │  - Connection pool management                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Code location: src/lib/prisma.ts (singleton)                   │
│            src/generated/prisma/ (generated client)              │
└─────────────────────────────────────────────────────────────────┘
```

#### Service Layer Modules

| Service | File | Responsibility |
|-----|------|------|
| ProjectService | `project.service.ts` | Project CRUD |
| IdeaService | `idea.service.ts` | Idea CRUD + status transitions + assignment |
| TaskService | `task.service.ts` | Task CRUD + status transitions + assignment |
| DocumentService | `document.service.ts` | Document CRUD |
| ProposalService | `proposal.service.ts` | Proposal CRUD + approval workflow |
| AgentService | `agent.service.ts` | Agent + API Key management |
| CommentService | `comment.service.ts` | Polymorphic comments |
| ActivityService | `activity.service.ts` | Activity logging (including assignment/release records) |
| AssignmentService | `assignment.service.ts` | Agent self-service queries (my tasks, available, unblocked) |
| NotificationService | `notification.service.ts` | Notification CRUD, preferences, SSE event emission |
| NotificationListener | `notification-listener.ts` | Activity → Notification mapping, recipient resolution |
| SessionService | `session.service.ts` | Agent Session CRUD + Task Checkin/Checkout + heartbeat |

#### Code Examples

**Controller (route.ts)**:
```typescript
// src/app/api/projects/route.ts
import { withErrorHandler, parsePagination } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as projectService from "@/services/project.service";

export const GET = withErrorHandler(async (request) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();

  const { page, pageSize, skip, take } = parsePagination(request);
  const { projects, total } = await projectService.listProjects({
    companyUuid: auth.companyUuid,  // UUID-based
    skip,
    take,
  });

  return paginated(projects, page, pageSize, total);
});
```

**Service (*.service.ts)**:
```typescript
// src/services/project.service.ts
import { prisma } from "@/lib/prisma";

export async function listProjects({ companyUuid, skip, take }) {
  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where: { companyUuid },  // UUID-based query
      skip,
      take,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.project.count({ where: { companyUuid } }),
  ]);
  return { projects, total };
}
```

### 3.3 Frontend Architecture: Server Components + Server Actions

Chorus adopts the Next.js 15 React Server Components (RSC) and Server Actions architecture to maximize server-side rendering and reduce client-side JavaScript.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Server Components (Page layer)                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Responsibilities:                                       │   │
│  │  - Server-side data fetching (directly calling Service)  │   │
│  │  - Server-side auth checks (getServerAuthContext)        │   │
│  │  - Server-side HTML rendering                            │   │
│  │  - Passing data to Client Components                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Code location: src/app/(dashboard)/**/page.tsx                 │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│ Client Components│  │ Server Actions  │  │   Service Layer         │
│ (Interactive)    │  │ (Data mutation) │  │   (Direct calls)        │
│                  │  │                 │  │                         │
│ *-actions.tsx    │  │ actions.ts      │  │ *.service.ts            │
│ *-form.tsx       │  │                 │  │                         │
│ Uses useTransition│  │ "use server"    │  │                         │
└────────┬─────────┘  └────────┬────────┘  └─────────────────────────┘
         │                     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │   Prisma Client     │
         └─────────────────────┘
```

#### Data Flow Patterns

**Reading data (Server Components)**:
```
URL request -> Server Component -> Service Layer -> Prisma -> Render HTML
```

**Writing data (Server Actions)**:
```
User action -> Client Component -> Server Action -> Service Layer -> Prisma -> revalidatePath
```

#### File Organization Pattern

Each feature page follows this file structure:

```
projects/[uuid]/tasks/[taskUuid]/
├── page.tsx           # Server Component (data fetching + rendering)
├── actions.ts         # Server Actions (data mutation)
├── task-actions.tsx   # Client Component (interactive buttons)
└── task-form.tsx      # Client Component (form)
```

#### Code Examples

**Server Component (page.tsx)**:
```typescript
// Server component: directly calls Service to fetch data
import { getServerAuthContext } from "@/lib/auth-server";
import { getTask } from "@/services/task.service";
import { TaskActions } from "./task-actions";

export default async function TaskPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) redirect("/login");

  const { taskUuid } = await params;
  const task = await getTask(auth.companyUuid, taskUuid);

  return (
    <div>
      <h1>{task.title}</h1>
      <TaskActions taskUuid={taskUuid} status={task.status} />
    </div>
  );
}
```

**Server Action (actions.ts)**:
```typescript
"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { claimTask } from "@/services/task.service";

export async function claimTaskAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) redirect("/login");

  await claimTask({
    taskUuid,
    companyUuid: auth.companyUuid,
    assigneeType: auth.type,
    assigneeUuid: auth.actorUuid,
  });

  revalidatePath(`/projects`);
  return { success: true };
}
```

**Client Component (task-actions.tsx)**:
```typescript
"use client";

import { useTransition } from "react";
import { claimTaskAction } from "./actions";

export function TaskActions({ taskUuid, status }: Props) {
  const [isPending, startTransition] = useTransition();

  const handleClaim = () => {
    startTransition(async () => {
      await claimTaskAction(taskUuid);
    });
  };

  return (
    <Button onClick={handleClaim} disabled={isPending}>
      {isPending ? "Processing..." : "Claim Task"}
    </Button>
  );
}
```

#### Architecture Benefits

| Benefit | Description |
|-----|------|
| **Security** | Auth and database operations are server-side, not exposed to the client |
| **Performance** | Reduced client-side JavaScript, faster initial page render |
| **Simplified Code** | No API route middle layer needed, Server Actions directly call Service |
| **Type Safety** | End-to-end TypeScript, compile-time parameter checking |
| **Cache Control** | `revalidatePath` for precise cache invalidation |

#### Scenarios Retaining Client-Side Auth

The following scenarios still use `authFetch` (client-side auth):

| File | Purpose |
|-----|------|
| `layout.tsx` | Dashboard layout session check |
| `auth-context.tsx` | Global auth state Provider |
| `auth-client.ts` | authFetch utility library |

These are auth infrastructure that need to maintain session state on the client side.

### 3.4 Directory Structure

```
chorus/
├── docker-compose.yml          # Local development environment
├── Dockerfile                  # Production image
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── next.config.js
├── tailwind.config.js
├── .env.example
│
├── prisma/
│   ├── schema.prisma           # Data model definitions
│   └── migrations/             # Database migrations
│
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx          # Root layout
│   │   ├── page.tsx            # Home/Dashboard
│   │   ├── globals.css
│   │   │
│   │   ├── (auth)/             # Auth-related pages
│   │   │   ├── login/page.tsx        # Email input -> route dispatch
│   │   │   ├── login/password/page.tsx  # Super admin password login
│   │   │   └── callback/page.tsx     # OIDC callback
│   │   │
│   │   ├── admin/              # Super admin panel
│   │   │   ├── page.tsx        # Super admin Dashboard
│   │   │   └── companies/
│   │   │       ├── page.tsx    # Company list
│   │   │       └── [id]/page.tsx  # Company details/OIDC config
│   │   │
│   │   ├── projects/
│   │   │   ├── page.tsx        # Project list (Server Component)
│   │   │   ├── new/
│   │   │   │   ├── page.tsx    # Create project form (Client Component)
│   │   │   │   └── actions.ts  # Create project Server Actions
│   │   │   └── [uuid]/
│   │   │       ├── page.tsx    # Project Overview (Server Component)
│   │   │       ├── ideas/
│   │   │       │   ├── page.tsx           # Ideas list (Server Component)
│   │   │       │   └── [ideaUuid]/
│   │   │       │       ├── page.tsx       # Idea details (Server Component)
│   │   │       │       ├── actions.ts     # Idea Server Actions
│   │   │       │       └── idea-actions.tsx # Interactive buttons (Client Component)
│   │   │       ├── documents/
│   │   │       │   ├── page.tsx           # Documents list (Server Component)
│   │   │       │   └── [documentUuid]/
│   │   │       │       ├── page.tsx       # Document details (Server Component)
│   │   │       │       ├── actions.ts     # Document Server Actions
│   │   │       │       ├── document-actions.tsx
│   │   │       │       └── document-content.tsx
│   │   │       ├── tasks/
│   │   │       │   ├── page.tsx           # Kanban board (Server Component)
│   │   │       │   └── [taskUuid]/
│   │   │       │       ├── page.tsx       # Task details (Server Component)
│   │   │       │       ├── actions.ts     # Task Server Actions
│   │   │       │       ├── task-actions.tsx
│   │   │       │       └── task-status-progress.tsx
│   │   │       ├── proposals/
│   │   │       │   ├── page.tsx           # Proposal list (Server Component)
│   │   │       │   └── [proposalUuid]/
│   │   │       │       ├── page.tsx       # Proposal details (Server Component)
│   │   │       │       ├── actions.ts     # Proposal Server Actions
│   │   │       │       └── proposal-actions.tsx
│   │   │       ├── knowledge/page.tsx     # Knowledge base query
│   │   │       └── activity/page.tsx      # Activity stream (Server Component)
│   │   │
│   │   ├── settings/
│   │   │   ├── page.tsx        # Settings page (Client Component + Server Actions)
│   │   │   └── actions.ts      # API Key management Server Actions
│   │   │
│   │   └── api/                # API Routes (for Agent access)
│   │       ├── auth/
│   │       │   ├── login/route.ts        # Email-based login entry
│   │       │   ├── callback/route.ts     # OIDC callback
│   │       │   └── [...nextauth]/route.ts
│   │       ├── admin/
│   │       │   ├── login/route.ts        # Super admin password login
│   │       │   └── companies/
│   │       │       ├── route.ts          # GET/POST Company
│   │       │       └── [id]/route.ts     # GET/PATCH/DELETE Company
│   │       ├── projects/
│   │       │   ├── route.ts    # GET (list), POST (create)
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       ├── ideas/route.ts
│   │       │       ├── documents/route.ts
│   │       │       ├── tasks/route.ts
│   │       │       ├── proposals/route.ts
│   │       │       ├── knowledge/route.ts
│   │       │       └── activities/route.ts
│   │       ├── ideas/
│   │       │   └── [id]/route.ts
│   │       ├── documents/
│   │       │   └── [id]/route.ts
│   │       ├── tasks/
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       └── comments/route.ts
│   │       ├── proposals/
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       ├── approve/route.ts
│   │       │       └── reject/route.ts
│   │       ├── agents/
│   │       │   ├── route.ts
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       └── keys/route.ts
│   │       ├── activities/
│   │       │   └── route.ts
│   │       └── mcp/
│   │           └── route.ts    # MCP HTTP endpoint
│   │
│   ├── components/             # React components
│   │   ├── ui/                 # shadcn/ui components
│   │   ├── layout/
│   │   │   ├── header.tsx
│   │   │   ├── sidebar.tsx
│   │   │   └── nav.tsx
│   │   ├── idea/
│   │   │   ├── idea-card.tsx
│   │   │   ├── idea-form.tsx
│   │   │   └── idea-list.tsx
│   │   ├── document/
│   │   │   ├── document-card.tsx
│   │   │   ├── document-viewer.tsx
│   │   │   └── document-list.tsx
│   │   ├── kanban/
│   │   │   ├── board.tsx
│   │   │   ├── column.tsx
│   │   │   └── card.tsx
│   │   ├── task/
│   │   │   ├── task-card.tsx
│   │   │   ├── task-detail.tsx
│   │   │   └── task-form.tsx
│   │   ├── proposal/
│   │   │   ├── proposal-card.tsx
│   │   │   ├── proposal-review.tsx
│   │   │   ├── proposal-timeline.tsx
│   │   │   └── approval-buttons.tsx
│   │   ├── knowledge/
│   │   │   ├── knowledge-search.tsx
│   │   │   └── knowledge-results.tsx
│   │   └── activity/
│   │       ├── activity-feed.tsx
│   │       └── activity-item.tsx
│   │
│   ├── lib/                    # Core libraries
│   │   ├── prisma.ts           # Prisma Client singleton
│   │   ├── auth.ts             # NextAuth configuration
│   │   ├── api-key.ts          # API Key validation
│   │   └── utils.ts            # Utility functions
│   │
│   ├── services/               # Business logic layer
│   │   ├── project.service.ts
│   │   ├── idea.service.ts
│   │   ├── document.service.ts
│   │   ├── task.service.ts
│   │   ├── proposal.service.ts
│   │   ├── knowledge.service.ts
│   │   ├── agent.service.ts
│   │   ├── activity.service.ts
│   │   └── mcp.service.ts
│   │
│   ├── mcp/                    # MCP Server
│   │   ├── server.ts           # Per-auth MCP server factory
│   │   └── tools/
│   │       ├── public.ts       # Public tools (all agents)
│   │       ├── session.ts      # Session tools (all agents)
│   │       ├── developer.ts    # Developer agent tools
│   │       ├── pm.ts           # PM agent tools
│   │       └── admin.ts        # Admin agent tools
│   │
│   └── types/                  # TypeScript type definitions
│       ├── api.ts
│       ├── mcp.ts
│       └── index.ts
│
├── public/
│   ├── skill/                      # Standalone Skill docs (served at /skill/)
│   │   ├── SKILL.md
│   │   ├── package.json
│   │   └── references/             # Role-specific workflow docs (7 files)
│   └── chorus-plugin/              # Chorus Plugin for Claude Code
│       ├── hooks/                  # Claude Code hooks configuration
│       ├── bin/                    # Hook scripts (on-subagent-start/stop/idle)
│       ├── skills/chorus/          # Plugin-embedded Skill (with session automation)
│       └── .mcp.json               # MCP server config template
│
└── tests/
    ├── unit/
    └── e2e/
```

---

## 4. Data Model

### 4.0 Database Design Principles: UUID-Based Architecture + No Foreign Key Constraints

**Design Decisions**:

1. **UUID-Based Foreign Key References**: All inter-entity associations use UUIDs instead of numeric IDs
2. **Prisma Relation Mode**: Uses `relationMode = "prisma"`, no database-level foreign key constraints

**Configuration**:

```prisma
// prisma/schema.prisma
datasource db {
  provider     = "postgresql"
  url          = env("DATABASE_URL")
  relationMode = "prisma"  // Relations managed by Prisma, no database FK
}
```

**UUID-Based Architecture Design Principles**:

| Principle | Description |
|-----|------|
| **Foreign keys use UUID** | All `*Id` fields renamed to `*Uuid` (e.g., `companyUuid`, `projectUuid`) |
| **Relations reference UUID** | Prisma relation definitions use `references: [uuid]` instead of `references: [id]` |
| **No ID queries** | All queries/operations are UUID-based, numeric `id` is not used |
| **API consistency** | UUIDs used uniformly internally and externally, no ID-UUID conversion needed |

**Why UUID-Based Design**:

| Benefit | Description |
|-----|------|
| **Security** | Prevents numeric ID enumeration attacks |
| **Simplified code** | No ID-UUID conversion logic needed |
| **API consistency** | UUIDs used uniformly internally and externally |
| **Distributed-friendly** | UUIDs can be generated client-side without database sequences |

**Relation Definition Example**:

```prisma
model Project {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  company     Company  @relation(fields: [companyUuid], references: [uuid])
  tasks       Task[]

  @@index([companyUuid])
}

model Task {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  projectUuid String
  project     Project  @relation(fields: [projectUuid], references: [uuid])

  @@index([companyUuid])
  @@index([projectUuid])
}
```

**Notes**:

1. **Numeric ID retained**: `id` still serves as primary key for internal indexing, but is not used in business logic
2. **UUID indexes**: All UUID foreign key fields have indexes for query performance optimization
3. **Referential integrity**: Managed by Prisma Client at the application layer
4. **Cascade operations**: `onDelete: Cascade` is simulated by Prisma

### 4.1 ER Diagram

**ID Design Principles**: UUID-Based Architecture
- `id`: Auto-incrementing numeric primary key (internal indexing only, not used in business logic)
- `uuid`: UUID string (used for all foreign key references and API exposure)
- All association fields use `*Uuid` naming (e.g., `companyUuid`, `projectUuid`)

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   Company   │───┬───│    User     │       │   Agent     │
│             │   │   │             │───────│             │
│  id (Int)   │   │   │  id (Int)   │       │  id (Int)   │
│  uuid       │   │   │  uuid       │       │  uuid       │
│  name       │   │   │  companyUuid│       │  companyUuid│
│  emailDomains    │   │  oidcSub    │       │  name       │
│  oidcIssuer │   │   │  email      │       │  roles[]    │
│  oidcClientId    │   │  name       │       │  ownerUuid  │
│  oidcEnabled│   │   └─────────────┘       │  persona    │
│  createdAt  │   │                         │  systemPrompt│
└─────────────┘   │                         └─────────────┘
       │          │                                │
       │          │   ┌─────────────┐              │
       │          └───│   ApiKey    │──────────────┘
       │              │             │
       │              │  id (Int)   │
       │              │  uuid       │
       │              │  companyUuid│
       │              │  agentUuid  │
       │              │  keyHash    │
       │              │  lastUsed   │
       │              │  expiresAt  │
       │              │  revokedAt  │
       │              └─────────────┘
       │
       ├──────────────────────────────────────────────────────┐
       │                                                      │
┌──────▼──────┐                                        ┌──────▼──────┐
│   Project   │                                        │  Proposal   │
│             │                                        │             │
│  id (Int)   │                                        │  id (Int)   │
│  uuid       │       ┌─────────────┐                  │  uuid       │
│  companyUuid│───────│    Idea     │                  │  companyUuid│
│  name       │       │             │                  │  projectUuid│
│  description│       │  id (Int)   │                  │  title      │
│  createdAt  │       │  uuid       │                  │  inputType  │
└─────────────┘       │  companyUuid│──── N:1 ─────────│  inputUuids │
       │              │  projectUuid│                  │  outputType │
       │              │  content    │                  │  outputData │
       │              │  attachments│                  │  status     │
       │              │  assigneeType                  │  createdByUuid│
       │              │  assigneeUuid                  │  reviewedByUuid│
       │              │  createdByUuid                 └─────────────┘
       │              └─────────────┘                         │
       │              ┌─────────────┐                         │
       │              │  Document   │<────────────────────────┘
       │              │             │     (outputType=document)
       │              │  id (Int)   │
       │              │  uuid       │
       │              │  companyUuid│
       │              │  projectUuid│
       │              │  type       │  (prd | tech_design | adr)
       │              │  title      │
       │              │  content    │
       │              │  version    │
       │              │  proposalUuid│
       │              │  createdByUuid│
       │              └─────────────┘
       │
       │              ┌─────────────┐
       ├──────────────│    Task     │<────────────────────────┐
       │              │             │     (outputType=task)   │
       │              │  id (Int)   │                         │
       │              │  uuid       │                         │
       │              │  companyUuid│                         │
       │              │  projectUuid│                         │
       │              │  title      │                         │
       │              │  description│                         │
       │              │  status     │                         │
       │              │  assigneeType                         │
       │              │  assigneeUuid                         │
       │              │  proposalUuid│────────────────────────┘
       │              │  createdByUuid│
       │              │  storyPoints│
       │              └─────────────┘
       │                     │
       │              ┌──────▼──────┐
       ├──────────────│  Activity   │
       │              │             │
       │              │  id (Int)   │
       │              │  uuid       │
       │              │  companyUuid│
       │              │  projectUuid│
       │              │  targetType │  (idea|task|proposal|document)
       │              │  targetUuid │
       │              │  actorType  │  (user|agent)
       │              │  actorUuid  │
       │              │  action     │  (created|assigned|released|...)
       │              │  value      │  (JSON: operation result value)
       │              └─────────────┘
       │
       │              ┌────────────────┐
       ├──────────────│ TaskDependency │
       │              │                │
       │              │  id (Int)      │
       │              │  taskUuid      │
       │              │  dependsOnUuid │
       │              │  companyUuid   │
       │              └────────────────┘
       │
       │              ┌────────────────┐
       ├──────────────│ AgentSession   │
       │              │                │
       │              │  id (Int)      │
       │              │  uuid          │
       │              │  agentUuid     │
       │              │  companyUuid   │
       │              │  name          │
       │              │  status        │  (active|inactive|closed)
       │              │  lastActiveAt  │
       │              └────────────────┘
       │                     │
       │              ┌──────▼─────────────┐
       └──────────────│ SessionTaskCheckin │
                      │                    │
                      │  id (Int)          │
                      │  sessionUuid       │
                      │  taskUuid          │
                      │  checkinAt         │
                      │  checkoutAt        │
                      └────────────────────┘
```

### 4.2 Core Entity Descriptions

**Common Fields**:
- `id`: Auto-incrementing numeric primary key (`Int @id @default(autoincrement())`) - internal indexing only
- `uuid`: UUID string (`String @unique @default(uuid())`) - business identifier and foreign key reference
- **All foreign keys use UUID** (e.g., `companyUuid`, `projectUuid`)

#### Company (Tenant)
- Root entity for multi-tenant isolation
- All data is associated via `companyUuid`
- `emailDomains`: Email domain list, used to identify Company during login
- `oidcIssuer`: OIDC Provider URL
- `oidcClientId`: OIDC Client ID (PKCE only, no Client Secret required)
- `oidcEnabled`: Whether OIDC login is enabled

#### User
- Human user, authenticated via OIDC
- `companyUuid`: Parent company UUID
- `oidcSub`: OIDC Provider subject

#### Agent
- AI Agent entity (Claude Code, etc.)
- `companyUuid`: Parent company UUID
- `roles`: Role array (`pm` | `developer`)
- `ownerUuid`: Creator User UUID
- `persona`: Custom personality description
- `systemPrompt`: Full system prompt
- One Agent can have multiple API Keys

#### ApiKey
- Independently managed, supports rotation and revocation
- `companyUuid`: Parent company UUID
- `agentUuid`: Associated Agent UUID
- `keyHash`: API key hash storage
- `expiresAt`: Optional expiration time
- `revokedAt`: Revocation time

#### Project
- Project container, parent of all business data
- `companyUuid`: Parent company UUID
- Contains Ideas, Documents, Tasks, Proposals, Activities

#### Idea
- Raw human input, can be assigned to a PM Agent for processing
- `companyUuid`: Parent company UUID
- `projectUuid`: Parent project UUID
- `title`: Title
- `content`: Text content
- `attachments`: Attachment list (images, files, etc.)
- `status`: `open` | `assigned` | `in_progress` | `pending_review` | `completed` | `closed`
- `assigneeType`: `user` | `agent` (polymorphic association)
- `assigneeUuid`: Assignee UUID
- `assignedAt`: Assignment time
- `assignedByUuid`: Assigner User UUID (recorded when assigned by human)
- `createdByUuid`: Creator User UUID
- Serves as input source for Proposals (one Idea can only belong to one Proposal, multiple Ideas can be combined into the same Proposal, N:1 relationship via JSON array)

**Assignment Methods**:
- Assign to user: Visible and operable by all PM Agents under that user
- Assign to specific PM Agent: Visible and operable only by that Agent
- Humans can reassign at any time (regardless of current status)

#### Document
- Product of a Proposal (PRD, technical design, etc.)
- `companyUuid`: Parent company UUID
- `projectUuid`: Parent project UUID
- `type`: `prd` | `tech_design` | `adr` | ...
- `content`: Markdown format content
- `version`: Version number
- `proposalUuid`: Source Proposal UUID (traceable)
- `createdByUuid`: Creator UUID

#### Task
- Product of a Proposal or manually created, can be assigned to Agent/human for execution
- `companyUuid`: Parent company UUID
- `projectUuid`: Parent project UUID
- `status`: `open` | `assigned` | `in_progress` | `to_verify` | `done` | `closed`
- `priority`: `low` | `medium` | `high`
- `storyPoints`: Effort estimation (unit: Agent hours)
- `assigneeType`: `user` | `agent` (polymorphic association)
- `assigneeUuid`: Assignee UUID
- `assignedAt`: Assignment time
- `assignedByUuid`: Assigner User UUID (recorded when assigned by human)
- `proposalUuid`: Source Proposal UUID (traceable, optional)
- `createdByUuid`: Creator UUID

**Assignment Methods**:
- Assign to user: Visible and operable by all Developer Agents under that user
- Assign to specific Agent: Visible and operable only by that Agent
- Humans can reassign at any time (regardless of current status)

#### Proposal
- Created by PM Agent, approved by humans, connects inputs and outputs
- `companyUuid`: Parent company UUID
- `projectUuid`: Parent project UUID
- **Input**:
  - `inputType`: `idea` | `document`
  - `inputUuids`: Associated input UUID list (JSON array, supports multiple Ideas combined)
- **Output**:
  - `outputType`: `document` | `task`
  - `outputData`: Proposed content (Document draft or Task list)
- `status`: `pending` | `approved` | `rejected` | `revised`
- `createdByUuid`: Creator Agent UUID
- `reviewedByUuid`: Reviewer User UUID
- Upon approval, automatically creates Documents or Tasks based on outputType

#### Activity
- Project-level activity log, generic design supporting all entity types
- `companyUuid`: Parent company UUID
- `projectUuid`: Parent project UUID
- `targetType`: Target entity type (`idea` | `task` | `proposal` | `document`)
- `targetUuid`: Target entity UUID
- `actorType`: Actor type (`user` | `agent`)
- `actorUuid`: Actor UUID
- `action`: Action type (see table below)
- `value`: Action result value (e.g., new status, assignment target, etc., JSON format)

**Activity Field Design Principles**:
- `targetType` + `targetUuid`: Identifies the target entity of the operation (generic design)
- `action`: Describes what operation occurred
- `value`: Records the operation result/post-change value (concise, records result only)

**Activity Action Types**:

| Action | Description | Value Example |
|--------|------|-----------|
| `created` | Entity was created | - |
| `assigned` | Entity was assigned | `{ type: "user", uuid: "...", name: "..." }` |
| `released` | Entity was released | - |
| `status_changed` | Status changed | `"in_progress"` (new status) |
| `submitted` | Submitted for approval/verification | - |
| `approved` | Approved | - |
| `rejected` | Rejected | `"reason text"` (optional) |
| `comment_added` | Comment added | - |

**Activity Maintenance Principles**:
- **Created in Service layer**: All Activities are automatically created by the Service layer during business operations
- **value records result only**: Status changes only record the post-change value, not the pre-change value
- **Assignment operations must be recorded**: Any assignment/release operation must create an Activity

#### Comment
- Polymorphic comments, can comment on Idea, Proposal, Task, Document
- `companyUuid`: Parent company UUID
- `targetType`: `idea` | `proposal` | `task` | `document`
- `targetUuid`: Target entity UUID
- `authorType`: `user` | `agent`
- `authorUuid`: Author UUID
- `content`: Comment content

#### TaskDependency
- DAG dependency relationship between tasks
- `taskUuid`: Current task UUID
- `dependsOnUuid`: Predecessor task UUID
- Cycle detection implemented in the Service layer

#### AgentSession
- Session tracking Agent work status
- `agentUuid`: Parent Agent UUID
- `name`: Session name (e.g., "frontend-worker")
- `status`: `active` | `inactive` | `closed`
- `lastActiveAt`: Last heartbeat time
- Automatically marked `inactive` after 1 hour of inactivity

#### SessionTaskCheckin
- Records which task a Session is currently working on
- `sessionUuid`: Session UUID
- `taskUuid`: Task UUID
- `checkinAt` / `checkoutAt`: Checkin/checkout time
- UI uses this to display Kanban Worker badges and Task Detail active Workers

---

## 5. API Design

### 5.1 REST API

#### Authentication
- **Human**: OIDC + Session Cookie
- **Agent**: `Authorization: Bearer {api_key}`

#### Endpoint Overview

**UUID-Based API**: All URL parameters and request/response data uniformly use UUIDs, consistent internally and externally.

| Method | Path | Description | Permissions |
|-----|------|------|------|
| **Projects** |
| GET | /api/projects | Project list | User, Agent |
| POST | /api/projects | Create project | User |
| GET | /api/projects/:uuid | Project details | User, Agent |
| PATCH | /api/projects/:uuid | Update project | User |
| DELETE | /api/projects/:uuid | Delete project | User |
| **Ideas** |
| GET | /api/projects/:uuid/ideas | Project Ideas list | User, PM Agent |
| POST | /api/projects/:uuid/ideas | Create Idea | User |
| GET | /api/ideas/:uuid | Idea details | User, PM Agent |
| PATCH | /api/ideas/:uuid | Update Idea (including status) | User, PM Agent |
| POST | /api/ideas/:uuid/claim | Claim Idea | PM Agent |
| POST | /api/ideas/:uuid/release | Release claimed Idea | PM Agent |
| DELETE | /api/ideas/:uuid | Delete Idea | User |
| **Documents** |
| GET | /api/projects/:uuid/documents | Project Documents list | User, Agent |
| GET | /api/documents/:uuid | Document details | User, Agent |
| PATCH | /api/documents/:uuid | Update Document | User |
| **Tasks** |
| GET | /api/projects/:uuid/tasks | Project task list | User, Agent |
| POST | /api/projects/:uuid/tasks | Create task (manual) | User |
| GET | /api/tasks/:uuid | Task details | User, Agent |
| PATCH | /api/tasks/:uuid | Update task (including status) | User, Agent (assignee) |
| POST | /api/tasks/:uuid/claim | Claim Task | Developer Agent |
| POST | /api/tasks/:uuid/release | Release claimed Task | Developer Agent |
| POST | /api/tasks/:uuid/comments | Add comment | User, Agent |
| **Proposals** |
| GET | /api/projects/:uuid/proposals | Project proposal list | User, PM Agent |
| POST | /api/projects/:uuid/proposals | Create proposal | PM Agent |
| GET | /api/proposals/:uuid | Proposal details | User, PM Agent |
| POST | /api/proposals/:uuid/approve | Approve proposal | User |
| POST | /api/proposals/:uuid/reject | Reject proposal | User |
| **Knowledge** |
| GET | /api/projects/:uuid/knowledge | Unified knowledge base query | User, Agent |
| **Agents** |
| GET | /api/agents | Agent list | User |
| POST | /api/agents | Create Agent | User |
| GET | /api/agents/:uuid | Agent details | User |
| POST | /api/agents/:uuid/keys | Create API Key | User |
| DELETE | /api/agents/:uuid/keys/:keyUuid | Revoke API Key | User |
| **Activities** |
| GET | /api/projects/:uuid/activities | Project activity list | User, Agent |
| **Agent Self-Service** |
| GET | /api/me/assignments | Get my claimed Ideas + Tasks | Agent |
| GET | /api/projects/:uuid/available | Get claimable Ideas + Tasks | Agent |
| **Super Admin (Super Admin Only)** |
| POST | /api/auth/login | Email-based login entry | Public |
| POST | /api/admin/login | Super admin password login | Public |
| GET | /api/admin/companies | Company list | Super Admin |
| POST | /api/admin/companies | Create Company | Super Admin |
| GET | /api/admin/companies/:uuid | Company details | Super Admin |
| PATCH | /api/admin/companies/:uuid | Update Company (including OIDC config) | Super Admin |
| DELETE | /api/admin/companies/:uuid | Delete Company | Super Admin |

### 5.2 MCP API

#### Endpoint
```
POST /api/mcp
```

#### Transport
Streamable HTTP Transport (supports SSE)

#### Authentication
```
Header: Authorization: Bearer {api_key}
```

Based on the Agent role associated with the API Key, different tool sets are returned.

#### Project Filtering (Optional)

Agents can filter results by project(s) using optional HTTP headers:

| Header | Format | Description |
|--------|--------|-------------|
| `X-Chorus-Project` | Single UUID or comma-separated UUIDs | Filter by specific project(s) |
| `X-Chorus-Project-Group` | Group UUID | Filter by project group |

**Behavior**:
- No header: Returns all projects (default, backward compatible)
- `X-Chorus-Project`: Returns only specified project(s)
- `X-Chorus-Project-Group`: Returns all projects in the group
- Priority: `X-Chorus-Project-Group` > `X-Chorus-Project`

**Affected tools**: `chorus_checkin`, `chorus_get_my_assignments`

**Example**:
```json
// .mcp.json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project": "project-uuid-1,project-uuid-2"
      }
    }
  }
}
```

#### Public Tools (All Agents)

| Tool | Description |
|-----|------|
| `chorus_checkin` | Check in: get persona, assignments, pending work |
| `chorus_get_project` | Get project details |
| `chorus_get_ideas` / `chorus_get_idea` | List/get Ideas |
| `chorus_get_documents` / `chorus_get_document` | List/get Documents |
| `chorus_get_proposals` / `chorus_get_proposal` | List/get Proposals (including drafts) |
| `chorus_list_tasks` / `chorus_get_task` | List/get Tasks |
| `chorus_get_activity` | Project activity stream |
| `chorus_get_my_assignments` | My claimed Ideas + Tasks |
| `chorus_get_available_ideas` | Claimable Ideas |
| `chorus_get_available_tasks` | Claimable Tasks |
| `chorus_get_unblocked_tasks` | Tasks with all dependencies completed (for scheduling) |
| `chorus_add_comment` / `chorus_get_comments` | Comment CRUD |

#### Session Tools (All Agents)

| Tool | Description |
|-----|------|
| `chorus_create_session` | Create a named Session |
| `chorus_list_sessions` | List Sessions |
| `chorus_close_session` / `chorus_reopen_session` | Close/reopen Session |
| `chorus_session_checkin_task` / `chorus_session_checkout_task` | Task Checkin/Checkout |
| `chorus_session_heartbeat` | Session heartbeat |

#### Developer Agent Tools

| Tool | Description |
|-----|------|
| `chorus_claim_task` / `chorus_release_task` | Claim/release Task |
| `chorus_update_task` | Update task status (with sessionUuid attribution) |
| `chorus_submit_for_verify` | Submit task for verification |
| `chorus_report_work` | Report work (with sessionUuid attribution) |

#### PM Agent Tools

| Tool | Description |
|-----|------|
| `chorus_claim_idea` / `chorus_release_idea` | Claim/release Idea |
| `chorus_update_idea_status` | Update Idea status |
| `chorus_pm_create_proposal` / `chorus_pm_submit_proposal` | Create/submit Proposal |
| `chorus_pm_create_document` / `chorus_pm_update_document` | Document CRUD |
| `chorus_pm_create_tasks` | Batch create Tasks |
| `chorus_pm_assign_task` | Assign Task |
| `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_remove_document_draft` | Document draft management |
| `chorus_pm_add_task_draft` / `chorus_pm_update_task_draft` / `chorus_pm_remove_task_draft` | Task draft management |
| `chorus_add_task_dependency` / `chorus_remove_task_dependency` | Task dependency DAG management |

#### Admin Agent Tools

| Tool | Description |
|-----|------|
| `chorus_admin_create_project` | Create project |
| `chorus_admin_approve_proposal` / `chorus_admin_reject_proposal` / `chorus_admin_close_proposal` | Proposal approval |
| `chorus_admin_verify_task` / `chorus_admin_reopen_task` / `chorus_admin_close_task` | Task verification/management |
| `chorus_admin_close_idea` / `chorus_admin_delete_idea` | Idea management |
| `chorus_admin_delete_task` / `chorus_admin_delete_document` | Delete management |

Admin Agent also has all PM and Developer tools.

**Warning**: Admin Agent has human-level permissions and can perform critical operations such as approval, verification, etc. Creating this type of Agent requires caution and should only be used when automation of human approval workflows is needed.

#### Proposal Input/Output Description

| Scenario | inputType | inputUuids | outputType | outputData |
|-----|-----------|------------|------------|------------|
| Ideas -> PRD | `idea` | Idea UUIDs (supports multiple) | `document` | PRD draft |
| PRD -> Tasks | `document` | Document UUID | `task` | Task list |
| PRD -> Tech Design | `document` | Document UUID | `document` | Tech design draft |

---

## 6. Authentication & Authorization

### 6.0 Super Admin Authentication

**Configuration** (environment variables):
```bash
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt hash
```

**Login Flow**:
```
┌──────────┐     ┌──────────┐     ┌──────────────┐
│  Browser │     │  Chorus  │     │   Database   │
│          │     │  Server  │     │              │
└────┬─────┘     └────┬─────┘     └──────┬───────┘
     │                │                   │
     │  1. Enter email│                   │
     │ ──────────────>│                   │
     │                │                   │
     │                │  2. Check if super admin
     │                │  (compare with env var)
     │                │                   │
     │  3a. Is super  │                   │
     │  admin, return │                   │
     │  password page │                   │
     │ <──────────────│                   │
     │                │                   │
     │  4a. Enter     │                   │
     │  password      │                   │
     │ ──────────────>│                   │
     │                │                   │
     │                │  5a. Verify password hash
     │                │                   │
     │  6a. Super     │                   │
     │  admin panel   │                   │
     │ <──────────────│                   │
     │                │                   │
     │  3b. Not super │                   │
     │  admin         │  Query email domain│
     │                │ ─────────────────>│
     │                │                   │
     │                │  Return Company   │
     │                │  OIDC config      │
     │                │ <─────────────────│
     │                │                   │
     │  4b. Redirect  │                   │
     │  to Company    │                   │
     │  OIDC          │                   │
     │ <──────────────│                   │
```

**Super Admin Panel Routes**:
- `/admin` - Super admin panel entry
- `/admin/companies` - Company management
- `/admin/companies/[id]` - Company details/OIDC configuration

### 6.1 Human Authentication (OIDC + PKCE)

```
┌──────────┐     ┌──────────┐     ┌──────────────┐
│  Browser │     │  Chorus  │     │    OIDC      │
│          │     │  Server  │     │   Provider   │
└────┬─────┘     └────┬─────┘     └──────┬───────┘
     │                │                   │
     │  1. Login      │                   │
     │ ──────────────>│                   │
     │                │                   │
     │  2. Redirect   │                   │
     │ <──────────────│                   │
     │                │                   │
     │  3. Auth Request (PKCE)            │
     │ ──────────────────────────────────>│
     │                │                   │
     │  4. User Login │                   │
     │ <──────────────────────────────────│
     │                │                   │
     │  5. Callback with code             │
     │ ──────────────>│                   │
     │                │                   │
     │                │  6. Exchange code │
     │                │ ─────────────────>│
     │                │                   │
     │                │  7. Tokens        │
     │                │ <─────────────────│
     │                │                   │
     │  8. Set Session Cookie             │
     │ <──────────────│                   │
```

### 6.2 Agent Authentication (API Key)

```
┌──────────┐     ┌──────────┐     ┌──────────────┐
│  Claude  │     │  Chorus  │     │   Database   │
│   Code   │     │  Server  │     │              │
└────┬─────┘     └────┬─────┘     └──────┬───────┘
     │                │                   │
     │  MCP Request   │                   │
     │  + API Key     │                   │
     │ ──────────────>│                   │
     │                │                   │
     │                │  Validate Key     │
     │                │ ─────────────────>│
     │                │                   │
     │                │  Agent + Role     │
     │                │ <─────────────────│
     │                │                   │
     │                │  Check Role       │
     │                │  Return Tools     │
     │                │                   │
     │  MCP Response  │                   │
     │ <──────────────│                   │
```

### 6.3 Permission Model

| Operation | User | PM Agent | Personal Agent |
|-----|------|----------|----------------|
| Create project | Yes | No | No |
| View project | Yes | Yes | Yes |
| Create task | Yes | Yes | No |
| Update task | Yes | Yes | Yes (only assigned to self) |
| Create proposal | No | Yes | No |
| Approve proposal | Yes | No | No |
| Manage Agent | Yes | No | No |

---

## 7. Core Workflows

### 7.1 Reversed Conversation Workflow (Idea -> Proposal -> Document/Task)

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Human creates Ideas                                         │
│     - Text: "I want to implement user auth with OAuth and       │
│       email/password login"                                     │
│     - Attachments: competitor screenshots, design sketches, etc.│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. PM Agent creates PRD Proposal                               │
│     - Get Ideas (chorus_pm_get_ideas)                          │
│     - Read project knowledge base (chorus_query_knowledge)     │
│     - Create proposal (chorus_pm_create_proposal)              │
│       inputType: idea, inputIds: [idea1, idea2, ...]           │
│       Supports selecting multiple Ideas combined as input      │
│       outputType: document, outputData: { PRD draft }          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Human reviews PRD Proposal (Web UI)                         │
│     - View PRD draft                                            │
│     - Approve -> Create Document(PRD)                           │
│     - Request changes -> Return for revision                    │
│     - Reject -> Mark as rejected                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. PM Agent creates Task Breakdown Proposal                    │
│     - Read Document(PRD)                                        │
│     - Create proposal (chorus_pm_create_proposal)              │
│       inputType: document, inputIds: [prd_id]                  │
│       outputType: task, outputData: { Task list }              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Human reviews Task Breakdown Proposal (Web UI)              │
│     - View task list                                            │
│     - Approve -> Create Tasks (status: todo)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Personal Agent executes tasks                               │
│     - Get task (chorus_get_task)                               │
│     - Get related documents (chorus_get_document)              │
│     - Execute development work                                  │
│     - Report completion (chorus_report_work)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  7. PM Agent continuous tracking                                │
│     - Analyze progress (chorus_pm_analyze_progress)            │
│     - Identify risks (chorus_pm_identify_risks)                │
│     - Create new Proposals to adjust plans when needed          │
└─────────────────────────────────────────────────────────────────┘
```

**Complete Traceability Chain**:
```
Ideas -> Proposal -> Document(PRD) -> Proposal -> Tasks
                       |
               Proposal -> Document(Tech Design)
```

Every Task/Document can be traced back to its source Proposal and Ideas.

### 7.2 Task Status Transitions

```
                    ┌──────────────┐
                    │   created    │
                    │  (from UI    │
                    │  or proposal)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
         ┌─────────│     open     │<─────────────────┐
         │         │ (unassigned) │                  │
         │         └──────┬───────┘                  │
         │                │                          │
         │                │ Assign to User/Agent     │ Release
         │                ▼                          │
         │         ┌──────────────┐                  │
         │         │   assigned   │──────────────────┘
         │         │  (assigned)  │
         │         └──────┬───────┘
         │                │
         │                │ Start work
         │                ▼
         │         ┌──────────────┐
         │         │ in_progress  │
         │         │  (executing) │
         │         └──────┬───────┘
         │                │
         │                │ Finish execution
         │                ▼
         │         ┌──────────────┐
         │         │  to_verify   │
         │         │(awaiting     │
         │         │ human verify)│
         │         └──────┬───────┘
         │                │
         │                │ Human verification passed
         │                ▼
         │         ┌──────────────┐
         │         │     done     │
         │         │  (completed) │
         │         └──────────────┘
         │
         │         ┌──────────────┐
         └────────>│    closed    │  (can be closed at any stage)
                   │   (closed)   │
                   └──────────────┘
```

**Assignment Rules**:
- Only the current assignee can update the status
- **Humans can reassign tasks at any status at any time**
- Everyone can comment on tasks at any status
- Release operation clears the assignee, status returns to open

**Assignment Flow (UI)**:
```
Click Assign button -> Open Assign modal
    ├── Assign to myself -> Visible to all my Developer Agents
    ├── Assign to specific Agent -> Visible only to that Agent
    ├── Assign to another user -> Visible to that user and their Agents
    └── Release -> Clear assignee, status -> open
```

**Activity Recording**:
Each assignment/release operation automatically creates an Activity:
- `task_assigned`: Task was assigned, payload includes target info
- `task_released`: Task was released

### 7.3 Idea Status Transitions

```
                    ┌──────────────┐
                    │   created    │
                    │(human created)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
         ┌─────────│     open     │<─────────────────┐
         │         │(awaiting claim)│                  │
         │         └──────┬───────┘                  │
         │                │                          │
         │                │ PM Agent claims          │ Release claim
         │                ▼                          │
         │         ┌──────────────┐                  │
         │         │   assigned   │──────────────────┘
         │         │  (claimed)   │
         │         └──────┬───────┘
         │                │
         │                │ Start processing
         │                ▼
         │         ┌──────────────┐
         │         │ in_progress  │
         │         │(producing    │
         │         │ Proposal)    │
         │         └──────┬───────┘
         │                │
         │                │ Submit Proposal
         │                ▼
         │         ┌──────────────┐
         │         │pending_review│
         │         │(awaiting     │
         │         │human approval)│
         │         └──────┬───────┘
         │                │
         │                │ Proposal approved
         │                ▼
         │         ┌──────────────┐
         │         │  completed   │
         │         │  (completed) │
         │         └──────────────┘
         │
         │         ┌──────────────┐
         └────────>│    closed    │  (can be closed at any stage)
                   │   (closed)   │
                   └──────────────┘
```

**Claim Rules**:
- Only Ideas in `open` status can be claimed
- Only the claimant (assignee) can update the status
- Humans can force reassign Ideas at any status
- Everyone can comment on Ideas at any status

### 7.4 Proposal Approval Workflow

```
                           ┌──────────────────────────────────────┐
                           │        Determined by outputType      │
                           │                                      │
┌──────────────┐     ┌─────▼──────┐     ┌──────────────────────┐  │
│   pending    │────>│  approved  │────>│  outputType=document │──┼──> Create Document
└──────────────┘     └────────────┘     └──────────────────────┘  │
       │                                ┌──────────────────────┐  │
       │                                │  outputType=task     │──┼──> Create Tasks
       │                                └──────────────────────┘  │
       │                                                          │
       ▼                                                          │
┌──────────────┐                                                  │
│   rejected   │                                                  │
└──────────────┘                                                  │
       │                                                          │
       ▼                                                          │
┌──────────────┐                                                  │
│   revised    │─────────────────────────────────────────────────>┘
└──────────────┘    (resubmit after revision)
```

**Approval Results**:
- `approved` + `outputType=document` -> Create Document, record proposalId
- `approved` + `outputType=task` -> Batch create Tasks, record proposalId
- `rejected` -> End, can re-propose
- `revised` -> Re-approve after revision

---

## 8. Deployment Architecture

### 8.1 Local Development

```yaml
# docker-compose.yml
version: '3.8'

services:
  chorus:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://chorus:chorus@db:5432/chorus
      - NEXTAUTH_URL=http://localhost:3000
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - OIDC_ISSUER=${OIDC_ISSUER}
      - OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./src:/app/src
      - ./prisma:/app/prisma

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=chorus
      - POSTGRES_PASSWORD=chorus
      - POSTGRES_DB=chorus
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chorus"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### 8.2 Production Deployment (AWS CDK)

```
┌─────────────────────────────────────────────────────────────────┐
│                    ALB (Application Load Balancer)               │
│                    HTTPS + ACM Certificate                       │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────┐
       │  ECS     │    │  ECS     │    │  ECS     │
       │  Fargate │    │  Fargate │    │  Fargate │
       │  Task    │    │  Task    │    │  Task    │
       └──────────┘    └──────────┘    └──────────┘
              │               │               │
              └───────┬───────┴───────┬───────┘
                      │               │
            ┌─────────▼─────┐  ┌──────▼──────────────┐
            │  Aurora        │  │  ElastiCache         │
            │  Serverless v2 │  │  Serverless Redis 7  │
            │  (PostgreSQL)  │  │  (Pub/Sub + RBAC)    │
            └───────────────┘  └──────────────────────┘
```

**CDK Infrastructure** (`packages/chorus-cdk/`):

| Construct | File | Resources |
|-----------|------|-----------|
| Network | `network.ts` | VPC (2 AZs), public/private subnets, NAT Gateway, Security Groups |
| Database | `database.ts` | Aurora Serverless v2, Secrets Manager (DB creds + app config) |
| Cache | `cache.ts` | ElastiCache Serverless Redis 7, RBAC user + password in Secrets Manager |
| Service | `service.ts` | ECS Fargate cluster, ALB, Task Definition, ECR image build |

**Redis Authentication**: RBAC with password user (`chorus`), default user disabled. Password auto-generated and stored in Secrets Manager, injected into ECS container as `REDIS_PASSWORD` secret.

---

## 9. Security Considerations

### 9.1 API Key Security

- API Keys are stored as SHA-256 hashes
- Plaintext is only returned at creation time and cannot be recovered afterward
- Supports expiration time and manual revocation
- Records last usage time

### 9.2 Data Isolation

- All queries include `companyUuid` filtering (UUID-based multi-tenant isolation)
- Service layer enforces tenant ownership checks

### 9.3 Input Validation

- Uses Zod for request body validation
- Prevents SQL injection (Prisma parameterized queries)
- Prevents XSS (React automatic escaping)

### 9.4 Rate Limiting

- API request throttling
- Prevents brute-force API Key attacks

---

## 10. Extensibility Considerations

### 10.1 Future Features

| Feature | Description | Status |
|-----|------|------|
| Task DAG | Dependency modeling + cycle detection + visualization | Implemented |
| Session Observability | Agent Session + Checkin + Kanban integration | Implemented |
| Chorus Plugin | Claude Code plugin, automating Session lifecycle | Implemented |
| Task Auto-Scheduling Query | `chorus_get_unblocked_tasks` MCP tool | Implemented |
| Notification System | In-app notifications + SSE push + Redis Pub/Sub | **Implemented** |
| Execution Metrics | Agent Hours, velocity statistics | To be developed (P1) |
| Git Integration | Associate commits and PRs | To be developed |
| Semantic Search | pgvector knowledge base search | To be developed |

### 10.2 Technical Reserves

- **pgvector**: PostgreSQL natively supports it, can be added seamlessly later
- **Redis**: ElastiCache Serverless for Pub/Sub event delivery; can be extended for caching or queues later

---

## Appendix

### A. Environment Variables

```bash
# Database
DATABASE_URL=postgres://chorus:chorus@localhost:5432/chorus

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Super Admin (system startup config, manages Companies and global settings)
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt hash

# Redis (optional — falls back to in-memory EventBus when unset)
# Local dev: redis://default:chorus-redis@localhost:6379
# CDK: assembled from REDIS_HOST + REDIS_PORT + REDIS_USERNAME + REDIS_PASSWORD
REDIS_URL=redis://default:chorus-redis@localhost:6379

# Note: OIDC configuration has been moved to the database (Company table),
# each Company is independently configured
# PKCE only, no Client Secret required
```

### B. Reference Documentation

- [Next.js Documentation](https://nextjs.org/docs)
- [Prisma Documentation](https://www.prisma.io/docs)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [shadcn/ui](https://ui.shadcn.com/)
