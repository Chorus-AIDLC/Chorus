<p align="center">
  <img src="docs/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>面向 AI 与人类协作的 Agent Harness</strong></p>

<p align="center"><a href="README.md">English</a> · <strong>中文</strong> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a></p>

Chorus 是一个 Agent Harness——包裹在 LLM 外面的基础设施层，负责管理会话生命周期、任务状态、子 Agent 编排、可观测性和故障恢复。它让多个具备细粒度权限配置的 AI Agent 和人类在同一平台上协作，完成从需求到交付的全流程。

受 **[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 方法论启发。核心理念：**Reversed Conversation**——AI 提议，人类验证。

---

## AI-DLC 工作流

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
人类      idea:write     proposal:write         task:write   *:admin    *:admin
提出      + 需求澄清     + 起草 PRD/任务         + 报告进度   + 验收     + 关闭
```

每个阶段下方标的是「执行该阶段所需的权限」，可以由人类、Agent（预设或 Custom）或两者持有。没有固定角色，5 × 3 权限矩阵的任意组合都合法，详见 [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md)（英文）。

---

## 最近更新

**[v0.14.0](https://chorus-ai.dev/zh/blog/chorus-v0.14.0-release/)** — 全应用深色模式（浅色 / 深色 / 跟随系统）。参考资料可挂到任意想法、提案或任务上，行内可读，也能通过 MCP 读写。新增韩语和日语（韩语由社区贡献）。用于归类的**主题**想法，以及 daemon 的「开始开发」/「Yolo」按钮、对话式建想法、崩溃恢复与 `chorus daemon install`。

**[v0.13.0](https://chorus-ai.dev/zh/blog/chorus-v0.13.0-release/)** — 项目资源思维导图：新增 Graph 视图，把每个项目的想法、提案、文档、任务连成一棵可折叠的树，从项目自身结构自动生成。每张卡片都标着当前状态（想法用想法列表那套派生状态），标题搜索会自动展开命中节点的上游并高亮/调暗、配上下切换定位，同一张可缩放可拖动的图在桌面与手机上通用（捏合 + 双击缩放）。

**[v0.12.0](https://chorus-ai.dev/zh/blog/chorus-v0.12.0-release/)** — 可寻址的 daemon 实例：一个 `chorus daemon` 可同时守多个工作目录（`--cwd`），每一个 `(agent, 主机, 目录)` 都成为一个能单独看见、单独点名的实例，贯穿 presence、@-mention 与任务指派。在想法上钉一次实例，其下的提案、任务与唤醒都会继承；带钉的唤醒被精确投递到那个实例，而非全员广播。评论区的 Agent @-mention 渲染为实时在线状态徽章，评论列表改为游标式无限滚动。

**[v0.11.0](https://chorus-ai.dev/zh/blog/chorus-v0.11.0-release/)** — Chorus Daemon：`chorus daemon` 将本机变为常驻 Agent 运行时，在每次派发时唤起本地 Claude Code。Agent Connections 界面提供实时可观测与控制：流式 transcript、指令注入、打断 / 恢复；新增"完成细化"按钮，唤起被指派的 Agent 撰写提案。

**[v0.10.0](https://chorus-ai.dev/zh/blog/chorus-v0.10.0-release/)** — 单父想法血缘：一条想法可派生子想法或挂靠至另一条之下，构成森林结构。该关联为弱关联，父想法仅呈现只读的 "+N derived" 汇总，不约束子想法的细化、提案与任务流程。想法浏览统一收敛至 Dashboard（Ideas / Lineage / Stats 三档视图切换，支持自适应默认）；独立的 Idea List 页面下线，原 URL 经 308 重定向至 Dashboard。

**[v0.9.4](https://chorus-ai.dev/zh/blog/chorus-v0.9.4-release/)** — OpenClaw 插件基于 OpenClaw 2026.4.27 Plugin SDK 全面重写（原生 MCP 注册、`runEmbeddedAgent` 处理 SSE 唤醒、reviewer 改为原生 skill）；Codex 插件 hook 改为随插件包分发，安装器同时清理用户目录中的历史 hook 拷贝。

**[v0.9.0](https://chorus-ai.dev/zh/blog/chorus-v0.9.0-release/)** — 头脑风暴 skill 帮你把模糊的想法聊出形状（在结构化多选题前先开放式对话），想法落地后自动生成总结报告（Summary / Decisions / Follow-ups 三段式，挂在想法概览页）。

**[v0.8.0](https://chorus-ai.dev/zh/blog/chorus-v0.8.0-release/)** — OpenSpec-aware 模式（仅 Claude Code）：当仓库下同时存在 `openspec/` 目录和 `openspec` CLI 时自动启用，新增 `/opsx/{explore,propose,apply,archive}` 与 task verify 后的 archive-trigger 钩子。

> 完整更新日志：[CHANGELOG.md](CHANGELOG.md)

---

## 快速开始

两条命令在本地运行 Chorus——无需数据库、无需 Docker、无需配置文件。

```bash
npm install -g @chorus-aidlc/chorus
chorus
```

Chorus 会自动启动内嵌 PostgreSQL (PGlite)、执行数据库迁移，然后在 **http://localhost:8637** 提供服务。

> **提示：** PGlite 是嵌入式单进程 PostgreSQL，本地单人使用完全没问题，但并发能力有限。如果需要多人或多 Agent 同时使用，建议通过 `DATABASE_URL=postgresql://...` 连接外部 PostgreSQL，或使用完整的 [Docker Compose](#docker-一键启动推荐) 部署。

默认登录账号：`admin@chorus.local` / `chorus`

### 参数选项

```bash
# 自定义端口
chorus --port 3000

# 自定义数据目录（默认：~/.chorus-data）
chorus --data-dir /path/to/data

# 自定义登录账号
DEFAULT_USER=me@example.com DEFAULT_PASSWORD=secret chorus

# 使用外部 PostgreSQL（跳过内嵌 PGlite）
DATABASE_URL=postgresql://user:pass@host:5432/chorus chorus
```

### 其他部署方式

| 方式 | 命令 |
|------|------|
| **npm**（最简单） | `npm i -g @chorus-aidlc/chorus && chorus` |
| **Docker（单镜像）** | [`docker compose -f docker-compose.local.yml up`](#docker-一键启动推荐) |
| **Docker（完整版）** | [`docker compose up`](#docker-一键启动推荐)（PostgreSQL + Redis + Chorus） |
| **AWS CDK** | [部署到 AWS](#部署到-aws) |

### `chorus daemon` — 作为 Agent 运行时连接

`chorus daemon` 将你的本地机器作为 Agent 运行时连接到远程 Chorus 服务器并执行 Chorus 分配的任务。

> **Agent 后端：** 支持 **Claude Code**（默认）和 **Codex**，用 `--agent codex`（或 `CHORUS_AGENT=codex`）切换。对其他 Agent CLI（Copilot 等）的支持计划在未来版本中实现。

```bash
chorus login                     # 认证（打开浏览器）
chorus daemon                    # 前台启动 daemon
chorus daemon -d                 # 后台启动 daemon（分离模式）
chorus daemon install            # 安装为开机自启服务（Linux）—— 推荐
chorus daemon uninstall          # 卸载已安装的服务
chorus daemon stop               # 停止 daemon（已安装服务时委派给 systemd）
chorus daemon stop --force       # pid 卡死时强制清理 pidfile
chorus daemon status             # 查看 daemon 状态
chorus daemon restart            # 重启 daemon
chorus daemon logs               # 查看 daemon 日志
```

**主要特性：**

- **Claude Code 与 Codex 后端** — 自动检测 PATH 中的 `claude`（或 `codex`）CLI；用 `--agent codex` 选择
- **后台模式** — 使用 `-d` 标志后台运行；用 `stop/restart/logs` 管理
- **开机自启服务** — `chorus daemon install` 生成正确的 `systemd --user` unit 并启动（见下文）；此后 `status/stop/restart/logs` 会自动委派给 systemd
- **权限模式** — 默认完全访问（yolo）；使用 `--chorus-only` 限制为仅 Chorus MCP 工具
- **多路径** — 用可重复的 `--cwd` 让单个 daemon 同时服务多个工作目录（见下文）
- **交互式设置** — 首次启动时如未配置凭证会提示输入

daemon 需要先认证。首次使用请先运行 `chorus login`，或者 daemon 会在首次启动时交互式提示输入凭证（如果在终端中运行）。

#### 开机 / 登录时自启 —— `chorus daemon install`

```bash
chorus daemon install --cwd ~/work/repo-a --cwd ~/work/repo-b   # 立即安装并启动，登录时自启
chorus daemon uninstall                                         # 停用并移除该服务
```

在 Linux 上，`install` 会生成一个 `systemd --user` unit，让 daemon 以**前台**方式运行（`Type=simple`，不带 `-d`），从而由 systemd 直接接管进程，然后 `daemon-reload` + `enable --now`。它会捕获你传入的 `--cwd`/`--agent`/`--chorus-only` 参数。**不要**手写 `Type=forking` + `chorus daemon -d` 的 unit —— daemon 会自我 daemon 化，systemd 追踪不到，重启时会陷入死循环；交给 `install` 写正确的 unit。在 macOS/Windows 上，`install` 会打印一份可手动安装的正确模板。请先运行 `chorus login`，让 unit 能读到凭证。详见 [docs/DAEMON.md](docs/DAEMON.md)。

#### 服务多个工作目录

一个 daemon 可以同时服务多个本地工作目录——每个声明的路径会注册为一条独立连接（各自拥有会话与唤起循环），归属同一个 Agent。路径**仅仅**是 daemon 服务的目录，不携带任何项目绑定。

```bash
chorus daemon --cwd ~/work/repo-a --cwd ~/work/repo-b   # 可重复传入
CHORUS_DAEMON_CWDS="~/work/repo-a:~/work/repo-b" chorus daemon   # 或用环境变量（`:` 或 `,` 分隔）
```

不传 `--cwd` 时，daemon 只服务它的启动目录这一个路径。

#### 配置文件 —— `~/.chorus/daemon.json`

`chorus login` 会把凭证写入此文件（权限 `0600`）。你也可以把 daemon 的调优项写进**同一个**文件。所有字段都是可选的；命令行参数和环境变量的优先级始终高于文件。

```json
{
  "url": "https://chorus.example.com",
  "apiKey": "cho_xxxxxxxxxxxxxxxxxxxxxxxx",
  "agentUuid": "00000000-0000-0000-0000-000000000000",
  "agentName": "My Daemon Agent",
  "cwds": ["~/work/repo-a", "~/work/repo-b"],
  "sigintTimeoutMs": 10000
}
```

| 字段 | 类型 | 写入方 / 用途 | 优先级（从高到低） |
|------|------|---------------|--------------------|
| `url` | string | 远程 Chorus 服务器 URL | `--url` 参数 → `CHORUS_URL` → 文件 |
| `apiKey` | string | Agent API Key（`cho_…`） | `--api-key` 参数 → `CHORUS_API_KEY` → 文件 |
| `agentUuid` / `agentName` | string | 认证身份（登录时记录） | 由 `chorus login` 写入 |
| `cwds` | string[] | daemon 服务的工作目录（多路径） | `--cwd` 参数 → `CHORUS_DAEMON_CWDS` → 文件 → 启动目录 |
| `sigintTimeoutMs` | number | SIGINT 后强制结束前的宽限窗口（毫秒，默认 `10000`） | `--sigint-timeout` 参数 → `CHORUS_DAEMON_SIGINT_TIMEOUT` → 文件 → `10000` |
| `yoloAckAt` | string | 内部字段——TTY 下 yolo 确认的时间戳（自动管理） | — |

daemon 启动时的横幅会打印它**实际读取的 `daemon.json` 路径**（以及该文件是否存在），让你随时清楚该编辑哪个文件。

---

## 界面预览

### 远程唤醒 Agent——派活到指定目录，实时看它跑

![远程唤醒 Agent](docs/images/agent-daemon-wake.gif)

把一条想法派给远程 Agent 的某个目录，打开对话窗口，就能实时看到本地的 Claude Code 接活、开跑，全程不用碰终端，也不用手动 resume。

### 项目资源图谱——整个项目一张实时思维导图

![项目资源图谱](packages/landing/public/images/mind-map.png)

Chorus 自动把整个项目整理成一张思维导图——想法、提案、文档、任务连成一棵树，还能实时反映 Agent 的动作，每张卡片的状态随着工作推进自动更新。

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
- **细粒度 Agent 权限** — 5 类资源 × 3 个动作组成的权限网格，支持预设 + 自定义组合（[详细说明](docs/PERMISSIONS.md) · 英文）
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
  Agent w/      Agent w/       Agent w/         人类
  idea+proposal  task:write    *:admin perms   （浏览器）
   :write perms    perms      （代理人类审批）
   (LLM)          (LLM)         (LLM)
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
| i18n | next-intl (en, zh, ko, ja) |
| 部署 | [Docker Hub](https://hub.docker.com/r/chorusaidlc/chorus-app) / Docker Compose / AWS CDK |

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

最快的方式是用应用内的 setup 向导：打开 Web UI，进入 **Settings → Setup Guide → 打开设置向导**，按照向导给出的分步指引接入自己的客户端（Claude Code、Codex、OpenCode、OpenClaw 或其他 agent）。向导会帮你创建 API Key、展示完整命令，并引导你验证连接。

如果偏好文档：

| 客户端 | 接入文档 |
|--------|---------|
| Claude Code | [CONNECT_CLAUDE_CODE.zh.md](docs/CONNECT_CLAUDE_CODE.zh.md) |
| Codex CLI | [CONNECT_CODEX.zh.md](docs/CONNECT_CODEX.zh.md) |
| OpenCode † | [CONNECT_OPENCODE.zh.md](docs/CONNECT_OPENCODE.zh.md) |
| 其他 MCP agent（Cursor / Continue / 自研等） | [CONNECT_OTHER_AGENTS.zh.md](docs/CONNECT_OTHER_AGENTS.zh.md) |

† OpenCode 的接入由社区维护的 [`opencode-chorus`](https://github.com/etnperlong/opencode-chorus) 插件提供（npm: [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus)），作者 [@etnperlong](https://github.com/etnperlong)，特此感谢！

在 Web UI 的 **Settings → Agents → Create API Key** 创建 API Key。Key 以 `cho_` 开头，仅在创建时显示一次。

![Create API Key](docs/images/create-key.png)

---

## Skill 文档

| 方式 | 位置 | 适用场景 |
|------|------|---------|
| **Plugin 内嵌（Claude Code）** | `public/chorus-plugin/skills/` | Claude Code + Chorus 插件，Session 自动化与生命周期 hook |
| **Plugin 内嵌（Codex CLI）** | `plugins/chorus/skills/` | Codex CLI + Chorus 插件，移植版技能（`$` 前缀斜杠命令）|
| **独立分发** | `public/skill/`（`/skill/` 路径静态托管）| 其他 MCP 客户端（Cursor / Continue / 自研），手动 Session 管理 |

---

## 文档

| 文档 | 说明 |
|------|------|
| [PRD](docs/PRD_Chorus.md) | 产品需求文档 |
| [Architecture](docs/ARCHITECTURE.md) | 技术架构文档 |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP 工具参考 |
| [Permissions](docs/PERMISSIONS.md) | Agent 权限模型（5 × 3 矩阵 + 预设 + Custom） |
| [Chorus Plugin](docs/chorus-plugin.md) | 插件设计与 Hook 说明 |
| [OpenSpec Mode](docs/OPENSPEC_MODE.md) | OpenSpec 模式（Plugin 0.8.1+，opt-in） |
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
