> [English Version](./ARCHITECTURE.md)

# Project Chorus - 技术架构文档

**版本**: 2.0
**更新日期**: 2026-02-18

---

## 1. 系统概述

### 1.1 定位

Chorus 是一个 AI Agent 与人类协作的平台，实现 AI-DLC（AI-Driven Development Lifecycle）方法论。核心理念是 **Reversed Conversation**：AI 提议，人类验证。

### 1.2 核心能力

| 能力 | 描述 |
|-----|------|
| **知识库** | 项目上下文存储和查询 |
| **任务管理** | 任务 CRUD、状态流转、Kanban、**任务 DAG 依赖** |
| **分配机制** | Idea/Task 灵活分配，支持人类和 Agent 协作 |
| **提议审批** | PM Agent 创建提议，人类/Admin 审批 |
| **MCP Server** | 50+ 工具，Agent 通过 MCP 协议接入（Public/Session/Developer/PM/Admin） |
| **活动流** | 实时追踪所有参与者的操作（含 Session 归因） |
| **通知系统** | 应用内通知 + SSE 实时推送 + Redis Pub/Sub 跨实例传播 + 偏好设置 + Agent MCP 工具 |
| **Session 可观测性** | Agent Session + Task Checkin，Kanban/Task Detail 实时显示活跃 Worker |
| **Chorus Plugin** | Claude Code 插件，自动化 Session 生命周期（创建/心跳/关闭） |
| **Task DAG** | 任务依赖建模、环检测、@xyflow/react + dagre 可视化 |
| **全局搜索** | 跨 6 种实体统一搜索，支持 Scope 过滤和 Cmd+K 命令面板 ([详情](./SEARCH.md)) |

### 1.3 参与者

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
   Web UI 访问     Claude Code     Claude Code     Claude Code
   审批提议        提议任务        执行任务        代理审批
```

**Agent 角色说明**：
- **PM Agent**: 需求分析、任务拆解、创建提议
- **Developer Agent**: 执行任务、报告工作、提交验证
- **Admin Agent**: 代理人类执行审批 Proposal、验证 Task、创建 Project 等操作（⚠️ 危险权限）

---

## 2. 技术栈

### 2.1 核心技术选型

| 层 | 技术 | 版本 | 选型理由 |
|---|------|------|---------|
| **框架** | Next.js | 15.x | 全栈统一，App Router，RSC 支持 |
| **语言** | TypeScript | 5.x | 类型安全，前后端一致 |
| **ORM** | Prisma | 7.x | 类型安全，迁移管理，良好 DX，无外键约束设计 |
| **数据库** | PostgreSQL | 16 | 可靠，JSON 支持，后续可扩展 pgvector |
| **UI 组件** | shadcn/ui | - | 基于 Radix，可定制，美观 |
| **样式** | Tailwind CSS | 4.x | 原子化 CSS，快速开发 |
| **认证** | next-auth | 5.x | OIDC 支持，与 Next.js 深度集成 |
| **MCP SDK** | @modelcontextprotocol/sdk | latest | 官方 TypeScript SDK |
| **缓存/消息** | Redis (ioredis) | 7.x | 通过 ElastiCache Serverless 实现跨实例 SSE 事件分发 |
| **容器化** | Docker Compose | - | 本地开发一键启动 |

### 2.2 开发工具

| 工具 | 用途 |
|-----|------|
| pnpm | 包管理 |
| ESLint + Prettier | 代码规范 |
| Vitest | 单元测试 |
| Playwright | E2E 测试 |

---

## 3. 系统架构

### 3.1 整体架构

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
│  │ + Server Actions    │  │      (Agent 专用)               │   │
│  │   (Human 前端)      │  │                                 │   │
│  │                     │  │  /api/projects/*                │   │
│  │  - Dashboard        │  │  /api/ideas/*                   │   │
│  │  - Project Overview │  │  /api/documents/*               │   │
│  │  - Ideas List       │  │  /api/tasks/*                   │   │
│  │  - Documents List   │  │  /api/proposals/*               │   │
│  │  - Kanban Board     │  │  /api/agents/*                  │   │
│  │  - Proposal Review  │  │  /api/auth/*                    │   │
│  │  - Activity Feed    │  │  /api/mcp    ← MCP HTTP 端点    │   │
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

### 3.2 Controller-Service-DAO 架构

Chorus 采用经典的三层架构模式，职责清晰分离：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Controller Layer                              │
│                    (Next.js API Routes)                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  职责:                                                    │   │
│  │  - 请求/响应处理                                          │   │
│  │  - 认证/授权检查                                          │   │
│  │  - 参数验证                                               │   │
│  │  - 调用 Service 层                                        │   │
│  │  - 格式化响应                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  代码位置: src/app/api/**/*.ts                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Service Layer                                 │
│                    (Business Logic)                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  职责:                                                    │   │
│  │  - 业务逻辑实现                                           │   │
│  │  - 数据查询和转换                                         │   │
│  │  - 事务管理                                               │   │
│  │  - 跨实体操作协调                                         │   │
│  │  - 状态机验证                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  代码位置: src/services/*.service.ts                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DAO Layer                                     │
│                    (Prisma Client)                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  职责:                                                    │   │
│  │  - 数据库操作封装                                         │   │
│  │  - ORM 映射                                               │   │
│  │  - 连接池管理                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  代码位置: src/lib/prisma.ts (单例)                              │
│            src/generated/prisma/ (生成的客户端)                   │
└─────────────────────────────────────────────────────────────────┘
```

#### 服务层模块

| 服务 | 文件 | 职责 |
|-----|------|------|
| ProjectService | `project.service.ts` | 项目 CRUD |
| IdeaService | `idea.service.ts` | Idea CRUD + 状态流转 + 分配 |
| TaskService | `task.service.ts` | Task CRUD + 状态流转 + 分配 |
| DocumentService | `document.service.ts` | Document CRUD |
| ProposalService | `proposal.service.ts` | Proposal CRUD + 审批流程 |
| AgentService | `agent.service.ts` | Agent + API Key 管理 |
| CommentService | `comment.service.ts` | 多态评论 |
| ActivityService | `activity.service.ts` | 活动日志（含分配/释放记录） |
| AssignmentService | `assignment.service.ts` | Agent 自助查询（我的任务、可分配、未阻塞） |
| NotificationService | `notification.service.ts` | 通知 CRUD、偏好设置、SSE 事件发送 |
| NotificationListener | `notification-listener.ts` | Activity → 通知映射、收件人解析 |
| SessionService | `session.service.ts` | Agent Session CRUD + Task Checkin/Checkout + 心跳 |

#### 代码示例

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

### 3.3 前端架构：Server Components + Server Actions

Chorus 采用 Next.js 15 的 React Server Components (RSC) 和 Server Actions 架构，最大化服务端渲染和减少客户端 JavaScript。

```
┌─────────────────────────────────────────────────────────────────┐
│                    Server Components (页面层)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  职责:                                                    │   │
│  │  - 服务端数据获取（直接调用 Service 层）                    │   │
│  │  - 服务端认证检查（getServerAuthContext）                  │   │
│  │  - 服务端渲染 HTML                                        │   │
│  │  - 传递数据给 Client Components                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  代码位置: src/app/(dashboard)/**/page.tsx                        │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│ Client Components│  │ Server Actions  │  │   Service Layer         │
│ (交互组件)        │  │ (数据变更)      │  │   (直接调用)             │
│                  │  │                 │  │                         │
│ *-actions.tsx    │  │ actions.ts      │  │ *.service.ts            │
│ *-form.tsx       │  │                 │  │                         │
│ 使用 useTransition│  │ "use server"    │  │                         │
└────────┬─────────┘  └────────┬────────┘  └─────────────────────────┘
         │                     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │   Prisma Client     │
         └─────────────────────┘
```

#### 数据流模式

**读取数据（Server Components）**：
```
URL 请求 → Server Component → Service Layer → Prisma → 渲染 HTML
```

**写入数据（Server Actions）**：
```
用户操作 → Client Component → Server Action → Service Layer → Prisma → revalidatePath
```

#### 文件组织模式

每个功能页面采用以下文件结构：

```
projects/[uuid]/tasks/[taskUuid]/
├── page.tsx           # Server Component（数据获取 + 渲染）
├── actions.ts         # Server Actions（数据变更）
├── task-actions.tsx   # Client Component（交互按钮）
└── task-form.tsx      # Client Component（表单）
```

#### 代码示例

**Server Component (page.tsx)**:
```typescript
// 服务端组件：直接调用 Service 获取数据
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

#### 架构优势

| 优势 | 说明 |
|-----|------|
| **安全性** | 认证和数据库操作都在服务端，不暴露给客户端 |
| **性能** | 减少客户端 JavaScript，首屏渲染更快 |
| **简化代码** | 无需 API 路由中间层，Server Action 直接调用 Service |
| **类型安全** | 端到端 TypeScript，编译时检查参数 |
| **缓存控制** | `revalidatePath` 精确控制缓存失效 |

#### 保留 Client-Side 认证的场景

以下场景仍使用 `authFetch`（客户端认证）：

| 文件 | 用途 |
|-----|------|
| `layout.tsx` | Dashboard 布局的会话检查 |
| `auth-context.tsx` | 全局认证状态 Provider |
| `auth-client.ts` | authFetch 工具库 |

这些是认证基础设施，需要在客户端维护会话状态。

### 3.4 目录结构

```
chorus/
├── docker-compose.yml          # 本地开发环境
├── Dockerfile                  # 生产镜像
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── next.config.js
├── tailwind.config.js
├── .env.example
│
├── prisma/
│   ├── schema.prisma           # 数据模型定义
│   └── migrations/             # 数据库迁移
│
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx          # 根布局
│   │   ├── page.tsx            # 首页/Dashboard
│   │   ├── globals.css
│   │   │
│   │   ├── (auth)/             # 认证相关页面
│   │   │   ├── login/page.tsx        # 邮箱输入 → 路由分发
│   │   │   ├── login/password/page.tsx  # 超级用户密码登录
│   │   │   └── callback/page.tsx     # OIDC 回调
│   │   │
│   │   ├── admin/              # 超级用户后台
│   │   │   ├── page.tsx        # 超级用户 Dashboard
│   │   │   └── companies/
│   │   │       ├── page.tsx    # Company 列表
│   │   │       └── [id]/page.tsx  # Company 详情/OIDC 配置
│   │   │
│   │   ├── projects/
│   │   │   ├── page.tsx        # 项目列表 (Server Component)
│   │   │   ├── new/
│   │   │   │   ├── page.tsx    # 创建项目表单 (Client Component)
│   │   │   │   └── actions.ts  # 创建项目 Server Actions
│   │   │   └── [uuid]/
│   │   │       ├── page.tsx    # 项目 Overview (Server Component)
│   │   │       ├── ideas/
│   │   │       │   ├── page.tsx           # Ideas 列表 (Server Component)
│   │   │       │   └── [ideaUuid]/
│   │   │       │       ├── page.tsx       # Idea 详情 (Server Component)
│   │   │       │       ├── actions.ts     # Idea Server Actions
│   │   │       │       └── idea-actions.tsx # 交互按钮 (Client Component)
│   │   │       ├── documents/
│   │   │       │   ├── page.tsx           # Documents 列表 (Server Component)
│   │   │       │   └── [documentUuid]/
│   │   │       │       ├── page.tsx       # Document 详情 (Server Component)
│   │   │       │       ├── actions.ts     # Document Server Actions
│   │   │       │       ├── document-actions.tsx
│   │   │       │       └── document-content.tsx
│   │   │       ├── tasks/
│   │   │       │   ├── page.tsx           # Kanban 看板 (Server Component)
│   │   │       │   └── [taskUuid]/
│   │   │       │       ├── page.tsx       # Task 详情 (Server Component)
│   │   │       │       ├── actions.ts     # Task Server Actions
│   │   │       │       ├── task-actions.tsx
│   │   │       │       └── task-status-progress.tsx
│   │   │       ├── proposals/
│   │   │       │   ├── page.tsx           # 提议列表 (Server Component)
│   │   │       │   └── [proposalUuid]/
│   │   │       │       ├── page.tsx       # Proposal 详情 (Server Component)
│   │   │       │       ├── actions.ts     # Proposal Server Actions
│   │   │       │       └── proposal-actions.tsx
│   │   │       ├── knowledge/page.tsx     # 知识库查询
│   │   │       └── activity/page.tsx      # 活动流 (Server Component)
│   │   │
│   │   ├── settings/
│   │   │   ├── page.tsx        # 设置页面 (Client Component + Server Actions)
│   │   │   └── actions.ts      # API Key 管理 Server Actions
│   │   │
│   │   └── api/                # API Routes (Agent 访问用)
│   │       ├── auth/
│   │       │   ├── login/route.ts        # 邮箱识别登录
│   │       │   ├── callback/route.ts     # OIDC 回调
│   │       │   └── [...nextauth]/route.ts
│   │       ├── admin/
│   │       │   ├── login/route.ts        # 超级用户密码登录
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
│   │           └── route.ts    # MCP HTTP 端点
│   │
│   ├── components/             # React 组件
│   │   ├── ui/                 # shadcn/ui 组件
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
│   ├── lib/                    # 核心库
│   │   ├── prisma.ts           # Prisma Client 单例
│   │   ├── auth.ts             # NextAuth 配置
│   │   ├── api-key.ts          # API Key 验证
│   │   └── utils.ts            # 工具函数
│   │
│   ├── services/               # 业务逻辑层
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
│   └── types/                  # TypeScript 类型定义
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

## 4. 数据模型

### 4.0 数据库设计原则：UUID-Based Architecture + 无外键约束

**设计决策**：

1. **UUID-Based 外键引用**：所有实体间的关联使用 UUID 而非数字 ID
2. **Prisma 关系模式**：采用 `relationMode = "prisma"`，不创建数据库级外键约束

**配置方式**：

```prisma
// prisma/schema.prisma
datasource db {
  provider     = "postgresql"
  url          = env("DATABASE_URL")
  relationMode = "prisma"  // 关系由 Prisma 管理，不创建数据库 FK
}
```

**UUID-Based Architecture 设计原则**：

| 原则 | 说明 |
|-----|------|
| **外键使用 UUID** | 所有 `*Id` 字段改为 `*Uuid`（如 `companyUuid`、`projectUuid`） |
| **关系引用 UUID** | Prisma 关系定义使用 `references: [uuid]` 而非 `references: [id]` |
| **无 ID 查询** | 所有查询/操作基于 UUID，不使用数字 `id` |
| **API 一致性** | 内外部统一使用 UUID，无需 ID↔UUID 转换 |

**为什么采用 UUID-Based 设计**：

| 优势 | 说明 |
|-----|------|
| **安全性** | 避免数字 ID 被枚举攻击 |
| **简化代码** | 无需 ID↔UUID 转换逻辑 |
| **API 一致性** | 内外部统一使用 UUID |
| **分布式友好** | UUID 可在客户端生成，无需数据库序列 |

**关系定义示例**：

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

**注意事项**：

1. **保留数字 ID**：`id` 仍作为主键用于内部索引，但业务逻辑不使用
2. **UUID 索引**：所有 UUID 外键字段都创建索引以优化查询性能
3. **关系完整性**：由 Prisma Client 在应用层管理
4. **级联操作**：`onDelete: Cascade` 由 Prisma 模拟执行

### 4.1 ER 图

**ID 设计原则**：UUID-Based Architecture
- `id`: 数字自增主键（仅内部索引，业务不使用）
- `uuid`: UUID 字符串（所有外键引用和 API 暴露）
- 所有关联字段使用 `*Uuid` 命名（如 `companyUuid`、`projectUuid`）

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
       │              │  Document   │◄────────────────────────┘
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
       ├──────────────│    Task     │◄────────────────────────┐
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
       │              │  value      │  (JSON: 操作结果值)
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

### 4.2 核心实体说明

**通用字段**：
- `id`: 数字自增主键（`Int @id @default(autoincrement())`）- 仅内部索引
- `uuid`: UUID 字符串（`String @unique @default(uuid())`）- 业务标识和外键引用
- **所有外键使用 UUID**（如 `companyUuid`、`projectUuid`）

#### Company（租户）
- 多租户隔离的根实体
- 所有数据通过 `companyUuid` 关联
- `emailDomains`: 邮箱域名列表，用于登录时识别 Company
- `oidcIssuer`: OIDC Provider URL
- `oidcClientId`: OIDC Client ID（仅支持 PKCE，无需 Client Secret）
- `oidcEnabled`: 是否启用 OIDC 登录

#### User（用户）
- 人类用户，通过 OIDC 登录
- `companyUuid`: 所属公司 UUID
- `oidcSub`: OIDC Provider 的 subject

#### Agent（代理）
- AI Agent 实体（Claude Code 等）
- `companyUuid`: 所属公司 UUID
- `roles`: 角色数组（`pm` | `developer`）
- `ownerUuid`: 创建者 User UUID
- `persona`: 自定义人格描述
- `systemPrompt`: 完整系统提示
- 一个 Agent 可以有多个 API Key

#### ApiKey（API 密钥）
- 独立管理，支持轮换和撤销
- `companyUuid`: 所属公司 UUID
- `agentUuid`: 关联的 Agent UUID
- `keyHash`: API 密钥哈希存储
- `expiresAt`: 可选的过期时间
- `revokedAt`: 撤销时间

#### Project（项目）
- 项目容器，所有业务数据的父级
- `companyUuid`: 所属公司 UUID
- 包含 Ideas、Documents、Tasks、Proposals、Activities

#### Idea（想法）
- 人类原始输入，可被 PM Agent 分配处理
- `companyUuid`: 所属公司 UUID
- `projectUuid`: 所属项目 UUID
- `title`: 标题
- `content`: 文本内容
- `attachments`: 附件列表（图片、文件等）
- `status`: `open` | `assigned` | `in_progress` | `pending_review` | `completed` | `closed`
- `assigneeType`: `user` | `agent`（多态关联）
- `assigneeUuid`: 负责人 UUID
- `assignedAt`: 分配时间
- `assignedByUuid`: 分配者 User UUID（人类分配时记录）
- `createdByUuid`: 创建者 User UUID
- 作为 Proposal 的输入源（一个 Idea 只能属于一个 Proposal，多个 Ideas 可组合到同一 Proposal，N:1 关系通过 JSON 数组实现）

**分配方式**：
- 分配给用户：该用户名下所有 PM Agent 可见并操作
- 分配给特定 PM Agent：仅该 Agent 可见并操作
- 人类可随时重新分配（不论当前状态）

#### Document（文档）
- Proposal 的产物（PRD、技术设计等）
- `companyUuid`: 所属公司 UUID
- `projectUuid`: 所属项目 UUID
- `type`: `prd` | `tech_design` | `adr` | ...
- `content`: Markdown 格式内容
- `version`: 版本号
- `proposalUuid`: 来源 Proposal UUID（可追溯）
- `createdByUuid`: 创建者 UUID

#### Task（任务）
- Proposal 的产物或人工创建，可被 Agent/人类分配执行
- `companyUuid`: 所属公司 UUID
- `projectUuid`: 所属项目 UUID
- `status`: `open` | `assigned` | `in_progress` | `to_verify` | `done` | `closed`
- `priority`: `low` | `medium` | `high`
- `storyPoints`: 工作量估算（单位：Agent 小时）
- `assigneeType`: `user` | `agent`（多态关联）
- `assigneeUuid`: 负责人 UUID
- `assignedAt`: 分配时间
- `assignedByUuid`: 分配者 User UUID（人类分配时记录）
- `proposalUuid`: 来源 Proposal UUID（可追溯，可选）
- `createdByUuid`: 创建者 UUID

**分配方式**：
- 分配给用户：该用户名下所有 Developer Agent 可见并操作
- 分配给特定 Agent：仅该 Agent 可见并操作
- 人类可随时重新分配（不论当前状态）

#### Proposal（提议）
- PM Agent 创建，人类审批，连接输入和输出
- `companyUuid`: 所属公司 UUID
- `projectUuid`: 所属项目 UUID
- **输入**：
  - `inputType`: `idea` | `document`
  - `inputUuids`: 关联的输入 UUID 列表（JSON 数组，支持多个 Ideas 组合）
- **输出**：
  - `outputType`: `document` | `task`
  - `outputData`: 提议的内容（Document 草稿或 Task 列表）
- `status`: `pending` | `approved` | `rejected` | `revised`
- `createdByUuid`: 创建者 Agent UUID
- `reviewedByUuid`: 审批者 User UUID
- 批准后根据 outputType 自动创建 Document 或 Tasks

#### Activity（活动）
- 项目级活动日志，通用设计支持所有实体类型
- `companyUuid`: 所属公司 UUID
- `projectUuid`: 所属项目 UUID
- `targetType`: 目标实体类型（`idea` | `task` | `proposal` | `document`）
- `targetUuid`: 目标实体 UUID
- `actorType`: 操作者类型（`user` | `agent`）
- `actorUuid`: 操作者 UUID
- `action`: 操作类型（见下表）
- `value`: 操作结果值（如新状态、分配目标等，JSON 格式）

**Activity 字段设计原则**：
- `targetType` + `targetUuid`: 标识操作的目标实体（通用设计）
- `action`: 描述发生了什么操作
- `value`: 记录操作结果/变化后的值（简洁，只记录结果）

**Activity Action 类型**：

| Action | 说明 | Value 示例 |
|--------|------|-----------|
| `created` | 实体被创建 | - |
| `assigned` | 实体被分配 | `{ type: "user", uuid: "...", name: "..." }` |
| `released` | 实体被释放 | - |
| `status_changed` | 状态变更 | `"in_progress"` (新状态) |
| `submitted` | 提交审批/验证 | - |
| `approved` | 审批通过 | - |
| `rejected` | 被拒绝 | `"reason text"` (可选) |
| `comment_added` | 添加评论 | - |

**Activity 维护原则**：
- **Service 层创建**：所有 Activity 由 Service 层在业务操作时自动创建
- **value 只记录结果**：状态变更只记录变化后的值，不记录变化前的值
- **分配操作必记录**：任何分配/释放操作都必须创建 Activity

#### Comment（评论）
- 多态评论，可评论 Idea、Proposal、Task、Document
- `companyUuid`: 所属公司 UUID
- `targetType`: `idea` | `proposal` | `task` | `document`
- `targetUuid`: 目标实体 UUID
- `authorType`: `user` | `agent`
- `authorUuid`: 作者 UUID
- `content`: 评论内容

#### TaskDependency（任务依赖）
- 任务间的 DAG 依赖关系
- `taskUuid`: 当前任务 UUID
- `dependsOnUuid`: 前置任务 UUID
- 环检测在 Service 层实现

#### AgentSession（Agent 会话）
- 跟踪 Agent 工作状态的会话
- `agentUuid`: 所属 Agent UUID
- `name`: 会话名称（如 "frontend-worker"）
- `status`: `active` | `inactive` | `closed`
- `lastActiveAt`: 最后心跳时间
- 不活跃超过 1 小时自动标记 `inactive`

#### SessionTaskCheckin（Session 任务签到）
- 记录 Session 当前正在处理的任务
- `sessionUuid`: 会话 UUID
- `taskUuid`: 任务 UUID
- `checkinAt` / `checkoutAt`: 签到/签出时间
- UI 据此显示 Kanban Worker 徽标和 Task Detail 活跃 Worker

---

## 5. API 设计

### 5.1 REST API

#### 认证
- **Human**: OIDC + Session Cookie
- **Agent**: `Authorization: Bearer {api_key}`

#### 端点概览

**UUID-Based API**：所有 URL 参数和请求/响应数据统一使用 UUID，内外一致。

| 方法 | 路径 | 描述 | 权限 |
|-----|------|------|------|
| **Projects** |
| GET | /api/projects | 项目列表 | User, Agent |
| POST | /api/projects | 创建项目 | User |
| GET | /api/projects/:uuid | 项目详情 | User, Agent |
| PATCH | /api/projects/:uuid | 更新项目 | User |
| DELETE | /api/projects/:uuid | 删除项目 | User |
| **Ideas** |
| GET | /api/projects/:uuid/ideas | 项目 Ideas 列表 | User, PM Agent |
| POST | /api/projects/:uuid/ideas | 创建 Idea | User |
| GET | /api/ideas/:uuid | Idea 详情 | User, PM Agent |
| PATCH | /api/ideas/:uuid | 更新 Idea（包括状态） | User, PM Agent |
| POST | /api/ideas/:uuid/claim | 认领 Idea | PM Agent |
| POST | /api/ideas/:uuid/release | 放弃认领 Idea | PM Agent |
| DELETE | /api/ideas/:uuid | 删除 Idea | User |
| **Documents** |
| GET | /api/projects/:uuid/documents | 项目 Documents 列表 | User, Agent |
| GET | /api/documents/:uuid | Document 详情 | User, Agent |
| PATCH | /api/documents/:uuid | 更新 Document | User |
| **Tasks** |
| GET | /api/projects/:uuid/tasks | 项目任务列表 | User, Agent |
| POST | /api/projects/:uuid/tasks | 创建任务（手动） | User |
| GET | /api/tasks/:uuid | 任务详情 | User, Agent |
| PATCH | /api/tasks/:uuid | 更新任务（包括状态） | User, Agent（认领者） |
| POST | /api/tasks/:uuid/claim | 认领 Task | Developer Agent |
| POST | /api/tasks/:uuid/release | 放弃认领 Task | Developer Agent |
| POST | /api/tasks/:uuid/comments | 添加评论 | User, Agent |
| **Proposals** |
| GET | /api/projects/:uuid/proposals | 项目提议列表 | User, PM Agent |
| POST | /api/projects/:uuid/proposals | 创建提议 | PM Agent |
| GET | /api/proposals/:uuid | 提议详情 | User, PM Agent |
| POST | /api/proposals/:uuid/approve | 批准提议 | User |
| POST | /api/proposals/:uuid/reject | 拒绝提议 | User |
| **Knowledge** |
| GET | /api/projects/:uuid/knowledge | 统一查询知识库 | User, Agent |
| **Agents** |
| GET | /api/agents | Agent 列表 | User |
| POST | /api/agents | 创建 Agent | User |
| GET | /api/agents/:uuid | Agent 详情 | User |
| POST | /api/agents/:uuid/keys | 创建 API Key | User |
| DELETE | /api/agents/:uuid/keys/:keyUuid | 撤销 API Key | User |
| **Activities** |
| GET | /api/projects/:uuid/activities | 项目活动列表 | User, Agent |
| **Agent 自助** |
| GET | /api/me/assignments | 获取自己认领的 Ideas + Tasks | Agent |
| GET | /api/projects/:uuid/available | 获取可认领的 Ideas + Tasks | Agent |
| **Super Admin（超级用户专属）** |
| POST | /api/auth/login | 邮箱识别登录入口 | Public |
| POST | /api/admin/login | 超级用户密码登录 | Public |
| GET | /api/admin/companies | Company 列表 | Super Admin |
| POST | /api/admin/companies | 创建 Company | Super Admin |
| GET | /api/admin/companies/:uuid | Company 详情 | Super Admin |
| PATCH | /api/admin/companies/:uuid | 更新 Company（含 OIDC 配置） | Super Admin |
| DELETE | /api/admin/companies/:uuid | 删除 Company | Super Admin |

### 5.2 MCP API

#### 端点
```
POST /api/mcp
```

#### Transport
Streamable HTTP Transport（支持 SSE）

#### 认证
```
Header: Authorization: Bearer {api_key}
```

根据 API Key 关联的 Agent role，返回不同的工具集。

#### 公共工具（All Agents）

| 工具 | 描述 |
|-----|------|
| `chorus_checkin` | 签到：获取 persona、assignments、pending work |
| `chorus_get_project` | 获取项目详情 |
| `chorus_get_ideas` / `chorus_get_idea` | 列出/获取 Ideas |
| `chorus_get_documents` / `chorus_get_document` | 列出/获取 Documents |
| `chorus_get_proposals` / `chorus_get_proposal` | 列出/获取 Proposals（含草稿） |
| `chorus_list_tasks` / `chorus_get_task` | 列出/获取 Tasks |
| `chorus_get_activity` | 项目活动流 |
| `chorus_get_my_assignments` | 我认领的 Ideas + Tasks |
| `chorus_get_available_ideas` | 可认领的 Ideas |
| `chorus_get_available_tasks` | 可认领的 Tasks |
| `chorus_get_unblocked_tasks` | 依赖已全部完成的 Tasks（调度用） |
| `chorus_add_comment` / `chorus_get_comments` | 评论 CRUD |

#### Session 工具（All Agents）

| 工具 | 描述 |
|-----|------|
| `chorus_create_session` | 创建命名 Session |
| `chorus_list_sessions` | 列出 Sessions |
| `chorus_close_session` / `chorus_reopen_session` | 关闭/重开 Session |
| `chorus_session_checkin_task` / `chorus_session_checkout_task` | Task Checkin/Checkout |
| `chorus_session_heartbeat` | Session 心跳 |

#### Developer Agent 工具

| 工具 | 描述 |
|-----|------|
| `chorus_claim_task` / `chorus_release_task` | 认领/释放 Task |
| `chorus_update_task` | 更新任务状态（含 sessionUuid 归因） |
| `chorus_submit_for_verify` | 提交任务验证 |
| `chorus_report_work` | 报告工作（含 sessionUuid 归因） |

#### PM Agent 工具

| 工具 | 描述 |
|-----|------|
| `chorus_claim_idea` / `chorus_release_idea` | 认领/释放 Idea |
| `chorus_update_idea_status` | 更新 Idea 状态 |
| `chorus_pm_create_proposal` / `chorus_pm_submit_proposal` | 创建/提交 Proposal |
| `chorus_pm_create_document` / `chorus_pm_update_document` | Document CRUD |
| `chorus_pm_create_tasks` | 批量创建 Tasks |
| `chorus_pm_assign_task` | 分配 Task |
| `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_remove_document_draft` | 文档草稿管理 |
| `chorus_pm_add_task_draft` / `chorus_pm_update_task_draft` / `chorus_pm_remove_task_draft` | 任务草稿管理 |
| `chorus_add_task_dependency` / `chorus_remove_task_dependency` | Task 依赖 DAG 管理 |

#### Admin Agent 工具

| 工具 | 描述 |
|-----|------|
| `chorus_admin_create_project` | 创建项目 |
| `chorus_admin_approve_proposal` / `chorus_admin_reject_proposal` / `chorus_admin_close_proposal` | Proposal 审批 |
| `chorus_admin_verify_task` / `chorus_admin_reopen_task` / `chorus_admin_close_task` | Task 验证/管理 |
| `chorus_admin_close_idea` / `chorus_admin_delete_idea` | Idea 管理 |
| `chorus_admin_delete_task` / `chorus_admin_delete_document` | 删除管理 |

Admin Agent 同时拥有 PM 和 Developer 的所有工具。

**⚠️ 安全警告**：Admin Agent 拥有人类级别的权限，可以执行审批、验证等关键操作。创建此类型的 Agent 需要谨慎，仅在需要自动化人类审批流程时使用。

#### Proposal 输入/输出说明

| 场景 | inputType | inputUuids | outputType | outputData |
|-----|-----------|------------|------------|------------|
| Ideas → PRD | `idea` | Idea UUIDs（支持多个） | `document` | PRD 草稿 |
| PRD → Tasks | `document` | Document UUID | `task` | Task 列表 |
| PRD → Tech Design | `document` | Document UUID | `document` | 技术设计草稿 |

---

## 6. 认证与授权

### 6.0 超级用户认证

**配置方式**（环境变量）：
```bash
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt 哈希
```

**登录流程**：
```
┌──────────┐     ┌──────────┐     ┌──────────────┐
│  Browser │     │  Chorus  │     │   Database   │
│          │     │  Server  │     │              │
└────┬─────┘     └────┬─────┘     └──────┬───────┘
     │                │                   │
     │  1. 输入邮箱    │                   │
     │ ──────────────>│                   │
     │                │                   │
     │                │  2. 检查是否超级用户
     │                │  (对比环境变量)     │
     │                │                   │
     │  3a. 是超级用户 │                   │
     │  返回密码登录页 │                   │
     │ <──────────────│                   │
     │                │                   │
     │  4a. 输入密码   │                   │
     │ ──────────────>│                   │
     │                │                   │
     │                │  5a. 验证密码哈希  │
     │                │                   │
     │  6a. 超级用户后台                   │
     │ <──────────────│                   │
     │                │                   │
     │  3b. 非超级用户 │                   │
     │                │  查询邮箱域名      │
     │                │ ─────────────────>│
     │                │                   │
     │                │  返回 Company      │
     │                │  OIDC 配置        │
     │                │ <─────────────────│
     │                │                   │
     │  4b. 重定向到   │                   │
     │  Company OIDC  │                   │
     │ <──────────────│                   │
```

**超级用户后台路由**：
- `/admin` - 超级用户后台入口
- `/admin/companies` - Company 管理
- `/admin/companies/[id]` - Company 详情/OIDC 配置

### 6.1 人类认证（OIDC + PKCE）

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

### 6.2 Agent 认证（API Key）

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

### 6.3 权限模型

| 操作 | User | PM Agent | Personal Agent |
|-----|------|----------|----------------|
| 创建项目 | ✓ | ✗ | ✗ |
| 查看项目 | ✓ | ✓ | ✓ |
| 创建任务 | ✓ | ✓ | ✗ |
| 更新任务 | ✓ | ✓ | ✓（仅分配给自己的） |
| 创建提议 | ✗ | ✓ | ✗ |
| 审批提议 | ✓ | ✗ | ✗ |
| 管理 Agent | ✓ | ✗ | ✗ |

---

## 7. 核心流程

### 7.1 Reversed Conversation 工作流（Idea → Proposal → Document/Task）

```
┌─────────────────────────────────────────────────────────────────┐
│  1. 人类创建 Ideas                                               │
│     - 文本："我想实现用户认证功能，支持 OAuth 和邮箱密码登录"        │
│     - 附件：竞品截图、设计草图等                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. PM Agent 创建 PRD Proposal                                   │
│     - 获取 Ideas (chorus_pm_get_ideas)                          │
│     - 读取项目知识库 (chorus_query_knowledge)                    │
│     - 创建提议 (chorus_pm_create_proposal)                       │
│       inputType: idea, inputIds: [idea1, idea2, ...]            │
│       支持选择多个 Ideas 组合作为输入来源                          │
│       outputType: document, outputData: { PRD 草稿 }             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. 人类审批 PRD Proposal (Web UI)                               │
│     - 查看 PRD 草稿                                              │
│     - 批准 → 创建 Document(PRD)                                  │
│     - 修改 → 返回修改                                            │
│     - 拒绝 → 标记拒绝                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. PM Agent 创建 Task Breakdown Proposal                        │
│     - 读取 Document(PRD)                                         │
│     - 创建提议 (chorus_pm_create_proposal)                       │
│       inputType: document, inputIds: [prd_id]                   │
│       outputType: task, outputData: { Task 列表 }                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. 人类审批 Task Breakdown Proposal (Web UI)                    │
│     - 查看任务列表                                               │
│     - 批准 → 创建 Tasks (status: todo)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Personal Agent 执行任务                                       │
│     - 获取任务 (chorus_get_task)                                 │
│     - 获取相关文档 (chorus_get_document)                         │
│     - 执行开发工作                                               │
│     - 报告完成 (chorus_report_work)                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  7. PM Agent 持续追踪                                            │
│     - 分析进度 (chorus_pm_analyze_progress)                      │
│     - 识别风险 (chorus_pm_identify_risks)                        │
│     - 必要时创建新 Proposal 调整计划                              │
└─────────────────────────────────────────────────────────────────┘
```

**完整追溯链**：
```
Ideas → Proposal → Document(PRD) → Proposal → Tasks
                       ↓
               Proposal → Document(Tech Design)
```

每个 Task/Document 都可以追溯到源头 Proposal 和 Ideas。

### 7.2 任务状态流转

```
                    ┌──────────────┐
                    │   created    │
                    │  (from UI    │
                    │  or proposal)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
         ┌─────────│     open     │←─────────────────┐
         │         │  (待分配)     │                  │
         │         └──────┬───────┘                  │
         │                │                          │
         │                │ 分配给 User/Agent        │ 释放（Release）
         │                ▼                          │
         │         ┌──────────────┐                  │
         │         │   assigned   │──────────────────┘
         │         │  (已分配)     │
         │         └──────┬───────┘
         │                │
         │                │ 开始工作
         │                ▼
         │         ┌──────────────┐
         │         │ in_progress  │
         │         │  (执行中)     │
         │         └──────┬───────┘
         │                │
         │                │ 完成执行
         │                ▼
         │         ┌──────────────┐
         │         │  to_verify   │
         │         │  (待人类验证) │
         │         └──────┬───────┘
         │                │
         │                │ 人类验证通过
         │                ▼
         │         ┌──────────────┐
         │         │     done     │
         │         │   (完成)     │
         │         └──────────────┘
         │
         │         ┌──────────────┐
         └────────→│    closed    │  (任何阶段可关闭)
                   │   (关闭)     │
                   └──────────────┘
```

**分配规则**：
- 只有当前负责人（assignee）可以更新状态
- **人类可以随时重新分配任何状态的任务**
- 所有人都可以评论任何状态的任务
- Release 操作清除负责人，状态回到 open

**分配流程（UI）**：
```
点击 Assign 按钮 → 弹出 Assign 模态框
    ├── Assign to myself（分配给自己）→ 所有我的 Developer Agent 可见
    ├── Assign to specific Agent（分配给特定 Agent）→ 仅该 Agent 可见
    ├── Assign to another user（分配给其他用户）→ 该用户及其 Agent 可见
    └── Release（释放）→ 清除负责人，status → open
```

**Activity 记录**：
每次分配/释放操作都自动创建 Activity：
- `task_assigned`: 任务被分配，payload 包含目标信息
- `task_released`: 任务被释放

### 7.3 Idea 状态流转

```
                    ┌──────────────┐
                    │   created    │
                    │  (人类创建)   │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
         ┌─────────│     open     │←─────────────────┐
         │         │  (待认领)     │                  │
         │         └──────┬───────┘                  │
         │                │                          │
         │                │ PM Agent 认领             │ 放弃认领
         │                ▼                          │
         │         ┌──────────────┐                  │
         │         │   assigned   │──────────────────┘
         │         │  (已认领)     │
         │         └──────┬───────┘
         │                │
         │                │ 开始处理
         │                ▼
         │         ┌──────────────┐
         │         │ in_progress  │
         │         │ (产出 Proposal)│
         │         └──────┬───────┘
         │                │
         │                │ 提交 Proposal
         │                ▼
         │         ┌──────────────┐
         │         │pending_review│
         │         │ (待人类审批)  │
         │         └──────┬───────┘
         │                │
         │                │ Proposal 审批通过
         │                ▼
         │         ┌──────────────┐
         │         │  completed   │
         │         │   (完成)     │
         │         └──────────────┘
         │
         │         ┌──────────────┐
         └────────→│    closed    │  (任何阶段可关闭)
                   │   (关闭)     │
                   └──────────────┘
```

**认领规则**：
- 只有 `open` 状态的 Idea 可被认领
- 只有认领者（assignee）可以更新状态
- 人类可以强制重新分配任何状态的 Idea
- 所有人都可以评论任何状态的 Idea

### 7.4 提议审批流程

```
                           ┌──────────────────────────────────────┐
                           │           outputType 决定            │
                           │                                      │
┌──────────────┐     ┌─────▼──────┐     ┌──────────────────────┐  │
│   pending    │────>│  approved  │────>│  outputType=document │──┼──> 创建 Document
└──────────────┘     └────────────┘     └──────────────────────┘  │
       │                                ┌──────────────────────┐  │
       │                                │  outputType=task     │──┼──> 创建 Tasks
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
└──────────────┘    (修改后重新提交)
```

**审批结果**：
- `approved` + `outputType=document` → 创建 Document，记录 proposalId
- `approved` + `outputType=task` → 批量创建 Tasks，记录 proposalId
- `rejected` → 结束，可重新提议
- `revised` → 修改后重新审批

---

## 8. 部署架构

### 8.1 本地开发

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

### 8.2 生产部署（AWS CDK）

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

**CDK 基础设施** (`packages/chorus-cdk/`):

| Construct | 文件 | 资源 |
|-----------|------|------|
| Network | `network.ts` | VPC（2 AZ）、公有/私有子网、NAT 网关、安全组 |
| Database | `database.ts` | Aurora Serverless v2、Secrets Manager（数据库凭证 + 应用配置） |
| Cache | `cache.ts` | ElastiCache Serverless Redis 7、RBAC 用户 + 密码存 Secrets Manager |
| Service | `service.ts` | ECS Fargate 集群、ALB、Task Definition、ECR 镜像构建 |

**Redis 鉴权**: RBAC 密码认证（用户 `chorus`），默认用户已禁用。密码自动生成并存储在 Secrets Manager，通过 `REDIS_PASSWORD` 环境变量注入 ECS 容器。

---

## 9. 安全考虑

### 9.1 API Key 安全

- API Key 使用 SHA-256 哈希存储
- 只在创建时返回明文，之后无法恢复
- 支持过期时间和手动撤销
- 记录最后使用时间

### 9.2 数据隔离

- 所有查询都包含 `companyUuid` 过滤（UUID-based 多租户隔离）
- 服务层强制检查租户归属

### 9.3 输入验证

- 使用 Zod 进行请求体验证
- 防止 SQL 注入（Prisma 参数化查询）
- 防止 XSS（React 自动转义）

### 9.4 速率限制

- API 请求限流
- 防止暴力破解 API Key

---

## 10. 扩展性考虑

### 10.1 未来功能

| 功能 | 描述 | 状态 |
|-----|------|------|
| ✅ 任务 DAG | 依赖关系建模 + 环检测 + 可视化 | 已实现 |
| ✅ Session 可观测性 | Agent Session + Checkin + Kanban 集成 | 已实现 |
| ✅ Chorus Plugin | Claude Code 插件，自动化 Session 生命周期 | 已实现 |
| ✅ Task 自动调度查询 | `chorus_get_unblocked_tasks` MCP 工具 | 已实现 |
| 通知系统 | 应用内通知 + SSE 推送 + Redis Pub/Sub | **已实现** |
| 全局搜索 | 跨 6 种实体统一搜索，Cmd+K 命令面板，MCP 工具 | **已实现** |
| 执行度量 | Agent Hours、velocity 统计 | 待开发 (P1) |
| Git 集成 | 关联 commit 和 PR | 待开发 |
| 语义搜索 | pgvector 知识库搜索 | 待开发 |

### 10.2 技术储备

- **pgvector**: PostgreSQL 已原生支持，后续可无缝添加
- **Redis**: ElastiCache Serverless 用于 Pub/Sub 事件分发；后续可扩展为缓存或队列

---

## 附录

### A. 环境变量

```bash
# Database
DATABASE_URL=postgres://chorus:chorus@localhost:5432/chorus

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Super Admin（系统启动配置，管理 Company 和全局设置）
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt 哈希

# Redis（可选 — 未设置时退化为内存 EventBus）
# 本地开发: redis://default:chorus-redis@localhost:6379
# CDK 部署: 由 REDIS_HOST + REDIS_PORT + REDIS_USERNAME + REDIS_PASSWORD 组装
REDIS_URL=redis://default:chorus-redis@localhost:6379

# 注意：OIDC 配置已移至数据库（Company 表），每个 Company 独立配置
# 仅支持 PKCE，无需 Client Secret
```

### B. 参考文档

- [Next.js Documentation](https://nextjs.org/docs)
- [Prisma Documentation](https://www.prisma.io/docs)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [shadcn/ui](https://ui.shadcn.com/)
