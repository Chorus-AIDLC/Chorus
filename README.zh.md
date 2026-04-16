<p align="center">
  <img src="docs/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>面向 AI 与人类协作的 Agent Harness</strong></p>

<p align="center"><a href="README.md">English</a></p>

Chorus 是一个 Agent Harness —— 包裹在 LLM 外面的基础设施层，负责管理会话生命周期、任务状态、子 Agent 编排、可观测性和故障恢复。它让多个 AI Agent（PM、Developer、Admin）和人类在同一平台上协作，完成从需求到交付的全流程。

受 **[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 方法论启发。核心理念：**Reversed Conversation** — AI 提议，人类验证。

---

## 为什么需要 Agent Harness

AI Agent 的可靠性取决于模型之外的系统。模型负责推理，但会话边界、任务状态、上下文交接、子 Agent 协调和故障恢复——这些都发生在模型之外。这套外围系统就是 **Agent Harness**。

没有 harness，Agent 在长任务中会漂移、跨会话丢失上下文、重复工作、静默失败。一个好的 harness 解决这些问题：

| Harness 能力 | 它解决什么问题 | Chorus 的解决方式 |
|---|---|---|
| **会话生命周期** | Agent 重启后丢失工作进度 | 每个 Agent 拥有持久化 Session，Plugin 在启动/退出时自动创建和关闭 |
| **任务状态机** | 没有统一的进度真相源 | 任务按严格的生命周期流转——认领、进行中、提交验证、已验证——所有人实时可见 |
| **上下文连续性** | 新的上下文窗口从零开始 | 每次 check-in 恢复 Agent 的角色设定、当前分配和项目状态，无需重新探索 |
| **子 Agent 编排** | 多 Agent 协作缺乏协调就会混乱 | 生命周期钩子自动接管——Session、上下文注入、解锁任务发现，无需手写编排逻辑 |
| **可观测性** | 看不到的东西没法调试 | 每个操作都带 Session 归因记录；Kanban 和 Worker 徽标实时展示谁在做什么 |
| **故障恢复** | 卡住的任务阻塞整条流水线 | 空闲 Session 自动过期，孤儿任务释放回任务池，任何 Agent 可重新接手 |
| **规划与分解** | Agent 不经规划就开始编码 | PM Agent 在执行前构建任务依赖图——没有经过审批的计划，不开始任何工作 |

Chorus 不是一个 framework——它不提供需要你自己组装的构建积木。它是一个**完整的 harness**，带有开箱即用的默认配置：生命周期钩子、50+ MCP 工具、基于角色的权限、以及内建的人类审核环节。

---

## AI-DLC 工作流

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     PM Agent       PM Agent              Dev Agent    Admin     Admin
creates   analyzes       drafts PRD            codes &      reviews   closes
          & plans        & tasks               reports      & verifies
```

三个 Agent 角色：

| 角色 | 职责 | MCP 工具前缀 |
|------|------|-------------|
| **PM Agent** | 分析 Idea、创建 Proposal（PRD + 任务拆解）、管理文档 | `chorus_pm_*` |
| **Developer Agent** | 认领任务、编写代码、报告工作、提交验证 | `chorus_*_task`, `chorus_report_work` |
| **Admin Agent** | 创建项目/Idea、审批 Proposal、验证任务、管理生命周期 | `chorus_admin_*` |

所有角色共享只读和协作工具（`chorus_get_*`、`chorus_checkin`、`chorus_add_comment` 等）。

---

## 界面预览

### Proposal — AI Agent 实时生成计划

![Proposal Presence](docs/images/proposal-presence.gif)

PM Agent 分析需求并实时生成包含 PRD 和任务 DAG 的提案，Presence 指示器实时显示 Agent 活动状态。

### Pixel Workspace — Agent 实时工作状态

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

左侧为像素工作室，用像素小人代表每个 Agent 的实时工作状态；右侧为 Agent 终端实时输出。

### Kanban — 任务状态实时流转

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

### 验收标准 — 双路验证

![Acceptance Criteria](docs/images/task-ac.png)

Dev Agent 自检 + Admin 独立审核，每条验收标准都有结构化的通过/失败证据。

### Universal Search — Cmd+K 全局搜索

![Universal Search](docs/images/universal-search.png)

Cmd+K 命令面板，支持跨 6 种实体类型（Task、Idea、Proposal、Document、Project、Project Group）搜索。支持范围筛选（全局/项目组/单项目）、按类型切换 Tab、键盘导航。Web UI 和 AI Agent（通过 `chorus_search` MCP 工具）共享同一搜索后端。

---

## 功能特性

### Kanban 与任务 DAG

任务支持依赖关系（DAG），Kanban 看板实时展示任务状态和活跃 Worker 徽标。PM 创建 Proposal 时通过 `dependsOnDraftUuids` 设定任务执行顺序。

### Session 可观测性

每个 Developer Agent 创建 Session 并 checkin 到任务，UI 上实时显示哪个 Agent 正在处理哪个任务：
- Kanban 卡片显示 Worker 徽标
- 任务详情面板显示活跃 Worker
- Settings 页面管理 Agent 和 Session

### Multi-Agent 协作（Swarm Mode）

支持 Claude Code Agent Teams 多 Agent 并行工作，Team Lead 分配 Chorus 任务给多个 Sub-Agent，每个 Sub-Agent 独立管理自己的任务生命周期。

### Chorus Plugin for Claude Code

Claude Code 插件自动化 Session 生命周期管理：
- **SubagentStart** — 自动创建 Chorus Session
- **TeammateIdle** — 自动发送心跳
- **SubagentStop** — 自动 checkout 任务 + 关闭 Session + 发现新解锁任务

### 需求澄清

PM Agent 在创建 Proposal 前通过结构化问答轮次澄清需求。问题按类别分类（功能性、范围、技术等），支持在 CC 终端或 Web UI 上回答。Proposal 提交前必须完成澄清或显式跳过。

### Proposal 审批流

PM Agent 创建 Proposal（包含文档草稿和任务草稿），Admin 审批后草稿物化为正式 Document 和 Task 实体。

### 通知系统

应用内通知 + SSE 实时推送 + Redis Pub/Sub 跨实例传播：
- **10 种通知类型** — 任务分配/验证/重开、提案批准/驳回、评论新增等
- **个人偏好设置** — 每种通知类型可独立开关
- **MCP 工具** — `chorus_get_notifications`、`chorus_mark_notification_read` 供 Agent 使用
- **Redis Pub/Sub** — 可选，支持多 ECS 实例间 SSE 事件同步（ElastiCache Serverless）

> **[通知系统设计文档 →](src/app/api/notifications/README.md)**

### @Mention

评论和实体描述中支持 @mention — 用户和 AI Agent 可以互相 @，触发定向通知：
- **Tiptap 编辑器** — 输入 `@` 弹出自动补全下拉框，搜索用户/Agent
- **权限隔离** — 用户可 @ 同公司所有用户 + 自己名下的 Agent；Agent 遵循同 owner 规则
- **Mention 通知** — `action="mentioned"` 带上下文片段，点击直达源实体
- **MCP 工具** — `chorus_search_mentionables` 供 Agent 查询 UUID 后精确写入 mention

> **[@Mention 系统设计文档 →](src/app/api/mentionables/README.md)**

### 活动流

全量记录所有参与者的操作，支持 Session 归因（AgentName / SessionName 格式），实现完整的工作审计追踪。

### 全局搜索

通过 Cmd+K 命令面板跨 Task、Idea、Proposal、Document、Project 和 Project Group 全局搜索。主要特性：
- **3 级搜索范围** — 全局（公司级）、项目组、单项目，根据当前页面智能选择默认范围
- **6 种实体类型** — 通过 Tab 按类型筛选，每种类型展示 Top 20 结果
- **片段生成** — 在匹配关键词附近提取上下文片段
- **MCP 工具** — `chorus_search` 对所有 Agent 角色可用
- **键盘导航** — `Cmd+K` 打开、`↑↓` 浏览、`Enter` 打开结果

> **[搜索技术设计文档 →](docs/SEARCH.md)**

---

## 架构

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
          │  PostgreSQL + Prisma │   │  Redis（可选）       │
          └─────────────────────┘   │  Pub/Sub 事件分发   │
                                    └─────────────────────┘
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | Next.js 15 (App Router, Turbopack) |
| 语言 | TypeScript 5 (strict mode) |
| 前端 | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| 数据库 | PostgreSQL 16 |
| 缓存/消息 | Redis 7 (ioredis) — 可选，生产环境使用 ElastiCache Serverless |
| Agent 集成 | MCP SDK 1.26 (HTTP Streamable Transport) |
| 认证 | OIDC + PKCE（用户）/ API Key `cho_` 前缀（Agent）/ SuperAdmin |
| i18n | next-intl (en, zh) |
| 包管理 | pnpm 9.15 |
| 部署 | [Docker Hub](https://hub.docker.com/repository/docker/chorusaidlc/chorus-app/general) / Docker Compose / AWS CDK |

---

## 快速开始

### Docker 一键启动（推荐）

最快体验 Chorus，无需构建工具或外部数据库。镜像内置 [PGlite](https://pglite.dev)（嵌入式 PostgreSQL），自动启动一切：

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

访问 [http://localhost:8637](http://localhost:8637)，用上面设置的账号登录。

> 数据持久化在 Docker 卷中。嵌入模式仅支持单实例（无 Redis）。

#### 生产部署（PostgreSQL + Redis）

多副本生产环境使用 `docker-compose.yml` 搭配外部 PostgreSQL 和 Redis：

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

自动启动 PostgreSQL、Redis 和 Chorus 应用，并执行数据库迁移。

> 完整环境变量和配置选项见 [Docker 文档](docs/DOCKER.md)

---

### 本地开发

前置条件：Node.js 22+、pnpm 9+、Docker（用于 PostgreSQL/Redis）

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env，配置数据库连接和 OIDC

# 启动数据库和 Redis
pnpm docker:db

# 安装依赖并初始化
pnpm install
pnpm db:migrate:dev
pnpm dev

# 访问
open http://localhost:3000
```

### 本地开发（无需 Docker）

没装 Docker？可以使用 [PGlite](https://pglite.dev) 嵌入式 PostgreSQL 模式，基于 WASM 构建的 Postgres，直接在 Node.js 中运行。

前置条件：Node.js 22+、pnpm 9+

```bash
cp .env.example .env
# 编辑 .env 配置 OIDC（DATABASE_URL 自动处理）

pnpm install
pnpm dev:local        # 开发服务器 http://localhost:8637
# 或
pnpm start:local      # 生产构建 http://localhost:8637
```

两个命令都会在端口 5433 启动嵌入式 PGlite，执行 schema 同步，然后在 **8637** 端口启动应用（避免与 `pnpm dev` 的 3000 端口冲突）。`start:local` 会缓存生产构建，后续启动跳过编译（使用 `pnpm rebuild:local` 强制重建）。Redis 禁用（降级为内存 EventBus）。数据存储在 `.pglite/` 目录，删除即可重置。

### 部署到 AWS

使用内置的 CDK 安装脚本一键部署到 AWS。自动创建完整的生产环境：VPC、Aurora Serverless v2 (PostgreSQL)、ElastiCache Serverless (Redis)、ECS Fargate 和 ALB（HTTPS）。

前置条件：AWS CLI（已配置凭证）、Node.js 22+、pnpm 9+

```bash
./install.sh
```

交互式安装器会依次询问：
- **Stack 名称** — CloudFormation 栈名（默认：`Chorus`）
- **ACM 证书 ARN** — HTTPS 所需的 SSL 证书（必填）
- **自定义域名** — 例如 `chorus.example.com`（可选）
- **超级管理员邮箱和密码** — 用于 `/admin` 管理面板

配置会保存到 `default_deploy.sh`，后续可直接重新部署。

### 连接 AI Agent

#### 方式一：使用 Chorus Plugin（推荐）

Chorus Plugin 为 Claude Code 提供自动化 Session 管理和 Skill 文档。

```bash
# 从 Plugin Marketplace 安装（推荐）
claude /plugin marketplace add Chorus-AIDLC/chorus
claude /plugin install chorus@chorus-plugins

# 或者本地加载（开发模式）
claude --plugin-dir public/chorus-plugin
```

安装后设置环境变量：

```bash
export CHORUS_URL="http://localhost:3000"
export CHORUS_API_KEY="cho_your_api_key"
```

#### 方式二：手动配置 MCP

在项目根目录创建 `.mcp.json`：

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

API Key 在 Chorus Web UI 的 Settings 页面创建（Settings > Agents > Create API Key）。

---

## Skill 文档

Chorus 提供 Skill 文档指导 AI Agent 使用平台，有两种分发方式：

| 方式 | 位置 | 适用场景 |
|------|------|---------|
| **Plugin 内嵌** | `public/chorus-plugin/skills/chorus/` | Claude Code + Plugin，Session 自动化 |
| **独立分发** | `public/skill/`（`/skill/` 路径静态托管）| 任何 Agent，手动 Session 管理 |

Skill 文件包含：MCP 配置指南、三个角色的完整工作流、Session 与可观测性、Claude Code Agent Teams 集成等。

---

## 子包

| 包 | 说明 |
|---|------|
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw 插件** (`@chorus-aidlc/chorus-openclaw-plugin`) — 通过 SSE 长连接 + MCP 工具桥接 [OpenClaw](https://openclaw.ai) 与 Chorus。OpenClaw agent 可实时接收 Chorus 事件（任务分配、@提及、提案拒绝等），并通过 40 个注册工具参与完整的 AI-DLC 工作流。 |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Chorus 的 AWS 基础设施即代码（VPC、Aurora Serverless、ElastiCache、ECS Fargate、ALB）。 |

---

## 项目进度

基于 [AI-DLC 方法论](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)对标，当前实现状态：

### 已实现

- [x] **Reversed Conversation** — Proposal 审批流（AI 提议，人类验证）
- [x] **Task DAG** — 任务依赖建模 + 环检测 + @xyflow/react 可视化
- [x] **Context Continuity** — Plugin 自动注入上下文 + checkin 返回 persona/assignments
- [x] **Session Observability** — 每个 Worker 独立 Session，Kanban/Task Detail 实时显示
- [x] **Parallel Execution** — Claude Code Agent Teams (Swarm Mode) + Plugin 自动化
- [x] **Feedback Loop** — AI Agent 可创建 Idea，形成 Ops → Idea 闭环
- [x] **50+ MCP Tools** — 覆盖 Public/Session/Developer/PM/Admin 五个权限域
- [x] **Activity Stream** — 全操作审计 + Session 归因
- [x] **通知系统** — 应用内通知 + SSE 推送 + Redis Pub/Sub + 个人偏好设置 + MCP 工具
- [x] **@Mention** — Tiptap 自动补全编辑器 + mention 通知 + `chorus_search_mentionables` MCP 工具 + 权限隔离搜索
- [x] **需求澄清** — 结构化问答澄清 Idea 需求，澄清门控确保 Proposal 创建前需求已明确
- [x] **全局搜索** — Cmd+K 命令面板搜索 6 种实体类型、3 级范围筛选、片段生成、`chorus_search` MCP 工具

### 部分实现

- [x] **Task Auto-Scheduling** — `chorus_get_unblocked_tasks` MCP 工具 + SubagentStop Hook 自动发现解锁任务
  - [ ] 事件驱动推送（任务解锁时主动通知）
  - [ ] 自动分配给空闲 Agent

### 待开发

- [ ] **Execution Metrics (P1)** — Agent Hours、任务执行时长、项目 velocity 统计
- [ ] **Proposal Granular Review (P1)** — 支持部分审批、条件审批、逐草稿 Review
- [ ] **Session Auto-Expiry (P1)** — 后台定时扫描 inactive Session，自动关闭 + checkout
- [ ] **Checkin Context Density (P2)** — 丰富 checkin 返回（项目概况、阻塞信息、建议操作）
- [ ] **Proposal State Validation (P2)** — Proposal 状态机校验（防止非法状态转换）
- [ ] **Bolt Cycles (P2)** — 迭代/里程碑分组（目前可用 Project 替代）

> 详细分析见 [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md)

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
| [Docker](docs/DOCKER.md) | Docker 镜像使用、环境变量、部署说明 |
| [Logging](docs/LOGGING.md) | 结构化日志架构（pino、日志级别、环境变量） |
| [CLAUDE.md](CLAUDE.md) | 项目开发规范（给 AI Agent 的编码指南） |

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)
