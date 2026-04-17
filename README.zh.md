<p align="center">
  <img src="docs/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>面向 AI 与人类协作的 Agent Harness</strong></p>

<p align="center"><a href="README.md">English</a></p>

Chorus 是一个 Agent Harness——包裹在 LLM 外面的基础设施层，负责管理会话生命周期、任务状态、子 Agent 编排、可观测性和故障恢复。它让多个 AI Agent（PM、Developer、Admin）和人类在同一平台上协作，完成从需求到交付的全流程。

受 **[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 方法论启发。核心理念：**Reversed Conversation**——AI 提议，人类验证。

---

## AI-DLC 工作流

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     PM Agent       PM Agent              Dev Agent    Admin     Admin
creates   analyzes       drafts PRD            codes &      reviews   closes
          & plans        & tasks               reports      & verifies
```

---

## 最近更新

**[v0.6.2](https://chorus-ai.dev/zh/blog/chorus-v0.6.2-release/)** — 嵌入式 PGlite 模式（零依赖部署）、Pino 结构化日志、无状态 MCP 支持水平扩展、默认端口改为 8637。

**[v0.6.1](https://chorus-ai.dev/zh/blog/chorus-v0.6.1-release/)** — `/yolo` 技能：全自动 AI-DLC 流水线（Idea → Proposal → Execute → Verify），支持 Agent Team 并行执行。

**[v0.6.0](https://chorus-ai.dev/zh/blog/chorus-v0.6.0-release/)** — IdeaTracker 面板、独立审阅 Agent（proposal-reviewer + task-reviewer）、实时 Agent Presence 指示器、跨列 Kanban 动画。

**v0.5.1** — 新用户引导向导、UI 动画系统、quick-dev 技能（跳过 Proposal 的快速工作流）。

**v0.5.0** — 全局搜索（Cmd+K 跨 6 种实体类型）、丰富的任务认领/分配响应。

> 完整更新日志：[CHANGELOG.md](CHANGELOG.md)

---

## 界面预览

### Proposal——AI Agent 实时生成计划

![Proposal Presence](docs/images/proposal-presence.gif)

PM Agent 分析需求并实时生成包含 PRD 和任务 DAG 的提案，Presence 指示器实时显示 Agent 活动状态。

### Pixel Workspace——Agent 实时工作状态

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

左侧为像素工作室，用像素小人代表每个 Agent 的实时工作状态；右侧为 Agent 终端实时输出。

### Kanban——任务状态实时流转

![Kanban Presence](docs/images/kanban-presence.gif)

Kanban 看板随 Agent 工作进度自动更新，任务卡片在 To Do → In Progress → To Verify 之间实时流转。Presence 指示器高亮显示正在被操作的资源。

### 看板 & 任务 DAG

![Kanban & Task DAG](docs/images/kanan-dag.png)

看板追踪任务状态，DAG 展示依赖关系和并行路径，一目了然。

### Idea & 需求细化

![Idea & Elaboration](docs/images/idea-elaborate.png)

PM Agent 在创建 Proposal 前，通过结构化问答轮次澄清需求。面板展示 Idea 详情及已完成的细化轮次。

### 提案审阅

![Proposal Review](docs/images/proposal.png)

PM Agent 生成的 Proposal 包含文档草稿和任务 DAG 草稿，Admin 在此面板审阅并决定批准或驳回。

### 验收标准——双路验证

![Acceptance Criteria](docs/images/task-ac.png)

Dev Agent 自检 + Admin 独立审核，每条验收标准都有结构化的通过/失败证据。

### Universal Search——Cmd+K 全局搜索

![Universal Search](docs/images/universal-search.png)

Cmd+K 命令面板，支持跨 6 种实体类型搜索。支持范围筛选（全局/项目组/单项目）、按类型切换 Tab、键盘导航。Web UI 和 AI Agent（通过 `chorus_search` MCP 工具）共享同一搜索后端。

---

## 功能特性

- **会话生命周期** — 持久化 Session，心跳检测，自动过期与故障恢复
- **任务 DAG** — 依赖建模、环检测、交互式可视化
- **Kanban** — 实时任务流转，Worker 徽标与 Agent Presence
- **Multi-Agent 协作** — Claude Code Agent Teams (Swarm Mode) 并行执行
- **Chorus Plugin** — 生命周期钩子自动管理 Session 创建/关闭、心跳、上下文注入
- **需求澄清** — Proposal 创建前的结构化问答轮次
- **Proposal 审批流** — PM 起草，Admin 审批，草稿物化为正式实体
- **通知系统** — 应用内 + SSE 推送 + Redis Pub/Sub，支持个人偏好设置（[设计文档](src/app/api/notifications/README.md)）
- **@Mention** — Tiptap 自动补全、权限隔离搜索、mention 通知（[设计文档](src/app/api/mentionables/README.md)）
- **活动流** — 全操作审计 + Session 归因
- **全局搜索** — Cmd+K 跨 6 种实体类型、3 级范围筛选、片段生成（[设计文档](docs/SEARCH.md)）
---

## 架构

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
          │  PostgreSQL + Prisma │   │  Redis（可选）       │
          └─────────────────────┘   │  Pub/Sub 事件分发   │
                                    └─────────────────────┘
```

### 子包

| 包 | 说明 |
|---|------|
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw 插件** — 通过 SSE 长连接 + MCP 工具桥接 [OpenClaw](https://openclaw.ai) 与 Chorus。 |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Chorus 的 AWS 基础设施即代码。 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | Next.js 15 (App Router, Turbopack) |
| 语言 | TypeScript 5 (strict mode) |
| 前端 | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| 数据库 | PostgreSQL 16 |
| 缓存/消息 | Redis 7 (ioredis) — 可选 |
| Agent 集成 | MCP SDK 1.26 (HTTP Streamable Transport) |
| 认证 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh) |
| 部署 | [Docker Hub](https://hub.docker.com/repository/docker/chorusaidlc/chorus-app/general) / Docker Compose / AWS CDK |

---

## 快速开始

### Docker 一键启动（推荐）

无需构建工具或外部数据库。镜像内置 [PGlite](https://pglite.dev)（嵌入式 PostgreSQL）：

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

访问 [http://localhost:8637](http://localhost:8637)，用上面设置的账号登录。

> 数据持久化在 Docker 卷中。嵌入模式仅支持单实例（无 Redis）。

#### 生产部署（PostgreSQL + Redis）

多副本生产环境：

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

> 完整环境变量和配置选项见 [Docker 文档](docs/DOCKER.md)。

---

### 本地开发

前置条件：Node.js 22+、pnpm 9+、Docker（用于 PostgreSQL/Redis）

```bash
cp .env.example .env
pnpm docker:db
pnpm install
pnpm db:migrate:dev
pnpm dev
# 访问 http://localhost:8637
```

### 本地开发（无需 Docker）

前置条件：Node.js 22+、pnpm 9+

```bash
cp .env.example .env
pnpm install
pnpm dev:local        # 开发服务器 http://localhost:8637
```

PGlite 在端口 5433 运行嵌入式 PostgreSQL。数据存储在 `.pglite/`，删除即可重置。

### 部署到 AWS

```bash
./install.sh
```

交互式安装器自动创建 VPC、Aurora Serverless v2、ElastiCache Serverless、ECS Fargate 和 ALB（HTTPS）。配置保存到 `default_deploy.sh` 供后续重新部署。

### 连接 AI Agent

在 Web UI 创建 API Key（Settings > Agents > Create API Key）。

![Create API Key](docs/images/create-key.png)

#### 方式一：Chorus Plugin（推荐）

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

从 Plugin Marketplace 安装：

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

或本地加载：

```bash
claude --plugin-dir public/chorus-plugin
```

#### 方式二：手动配置 MCP

在项目根目录创建 `.mcp.json`：

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

## Skill 文档

| 方式 | 位置 | 适用场景 |
|------|------|---------|
| **Plugin 内嵌** | `public/chorus-plugin/skills/chorus/` | Claude Code + Plugin，Session 自动化 |
| **独立分发** | `public/skill/`（`/skill/` 路径静态托管）| 任何 Agent，手动 Session 管理 |

---

## 文档

| 文档 | 说明 |
|------|------|
| [PRD](docs/PRD_Chorus.md) | 产品需求文档 |
| [Architecture](docs/ARCHITECTURE.md) | 技术架构文档 |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP 工具参考 |
| [Chorus Plugin](docs/chorus-plugin.md) | 插件设计与 Hook 说明 |
| [Search](docs/SEARCH.md) | 全局搜索技术设计 |
| [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md) | AI-DLC 方法论差距分析 |
| [AIG Implementation Plan](docs/CHORUS_AIG_PLAN.md) | Agent 透明度路线图 |
| [Presence Design](docs/PRESENCE_DESIGN.md) | 实时 Agent Presence 系统 |
| [Docker](docs/DOCKER.md) | Docker 镜像使用与部署 |
| [Logging](docs/LOGGING.md) | 结构化日志架构 |
| [CLAUDE.md](CLAUDE.md) | 项目开发规范 |

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)
