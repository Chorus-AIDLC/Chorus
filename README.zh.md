<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>你的编程 Agent 之上的 Harness：Agent 提议，人类把关，软件交付。</strong></p>

<p align="center"><a href="README.md">English</a> · <strong>中文</strong> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a></p>

<p align="center"><a href="https://doc.chorus-ai.dev/zh/"><strong>📖 文档</strong></a></p>

Chorus 是你的编程 Agent 之上的 Harness。编程 Agent 是把模型 harness 起来写代码的那层；Chorus 高它们一层，把多个这样的 Agent 和你收进同一条流水线：Agent 提议，你来验收，想法最终交付成软件，而不只是写代码。在底层，它把这套多 Agent、真人把关的协作稳稳跑起来所需的一切都处理好：会话生命周期、任务状态、子 Agent 编排、可观测性和故障恢复。每个 AI Agent 都有细粒度、可配置的权限。

受 **[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 方法论启发。核心理念：**Reversed Conversation**：AI 提议，人类验证。

---

## AI-DLC 工作流

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
人类      idea:write     proposal:write         task:write   *:admin    *:admin
提出      + 需求澄清     + 起草 PRD/任务         + 报告进度   + 验收     + 关闭
```

每个阶段下方标的是「执行该阶段所需的权限」，可以授予人类、Agent 或两者。没有固定角色，5 × 3 权限矩阵的任意组合都合法。→ [Agent 权限](https://doc.chorus-ai.dev/zh/guides/manage-agents/)

---

## 最近更新

**[v0.17.2](https://chorus-ai.dev/zh/blog/chorus-v0.17.2-release/)** — Pi 现在可以正式安装并由 daemon 唤醒，`chorus agents run` 还能一条命令切换本地 Agent profile。

**[v0.17.0–0.17.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.1)** — 一个 CLI 即可为各类编程 Agent 安装和更新 Chorus。现在还能在 Tracker、Graph 和 Idea 详情中直接看到 daemon 的实时活动。

**[v0.16.4](https://chorus-ai.dev/zh/blog/chorus-v0.16.4-release/)** — DeepSeek Harness（dsh）成为第六种接入方式：`@chorus-aidlc/chorus-dsh` bundle 把 Chorus 的 skill、persona 和 MCP 配置装进任意 dsh profile。目前仅交互式使用，daemon 唤醒稍后支持。

**[v0.16.1](https://chorus-ai.dev/zh/blog/chorus-v0.16.1-release/)** — 一个 `chorus daemon` 现在可以同时服务多个互相独立的 agent，每个都有自己的密钥、工作目录、后端和权限（通过 `agents[]` 配置）；agent 之间还能通过 @ 把活递给对方，每次唤醒都落在该 agent 自己的项目目录里。

**[v0.16.0](https://chorus-ai.dev/zh/blog/chorus-v0.16.0-release/)** — 新增 `docs` skill，引导 Agent 查阅文档站点（[doc.chorus-ai.dev](https://doc.chorus-ai.dev)），基于当前文档作答，而不是凭记忆复述。

**[v0.15.0](https://chorus-ai.dev/zh/blog/chorus-v0.15.0-release/)** — 项目级 Agent 工作目录：每位用户可以为项目中的每个 Agent 绑定主机和 cwd，只浏览 daemon 允许的目录，并让任务分配、唤醒、恢复和后续对话使用同一个执行位置，且不迁移进行中的会话。Codex 现在会单独保存可恢复的后端 thread ID，并移除不再需要的 Chorus session 管理步骤。

**[v0.14.1](https://chorus-ai.dev/zh/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI 成为第四种接入方式（Kiro CLI v2）：通过 `chorus agents add` 一条命令安装的 Kiro 插件，以及 `--agent kiro` 的 daemon 后端，另有若干 daemon 修复。

**[v0.14.0](https://chorus-ai.dev/zh/blog/chorus-v0.14.0-release/)** — 全应用深色模式（浅色 / 深色 / 跟随系统）。参考资料可挂到任意想法、提案或任务上，行内可读，也能通过 MCP 读写。新增韩语和日语（韩语由社区贡献）。用于归类的**主题**想法，以及 daemon 的「开始开发」/「Yolo」按钮、对话式建想法、崩溃恢复与 `chorus daemon install`。

> 完整更新日志：[CHANGELOG.md](CHANGELOG.md)

---

## 快速开始

两条命令即可，无需数据库、无需 Docker、无需配置文件。

```bash
npm install -g @chorus-aidlc/chorus@0.17.1
chorus
```

Chorus 会自动启动内嵌 PostgreSQL (PGlite)、执行数据库迁移，然后在 **http://localhost:8637** 提供服务。默认登录账号：`admin@chorus.local` / `chorus`。

> 需要运行多个 agent，或部署到生产环境？可使用外部 PostgreSQL、Docker 或 AWS → **[部署与自托管](https://doc.chorus-ai.dev/zh/guides/deployment-overview/)**。

想把本地机器变成领取任务的 agent 运行时，运行 `chorus daemon` → **[Daemon 运维](https://doc.chorus-ai.dev/zh/guides/daemon-operations/)** · **[远程控制](https://doc.chorus-ai.dev/zh/guides/remote-control/)**。

---

## 界面预览

### 远程唤醒 Agent：派活到指定目录，实时看它跑

![远程唤醒 Agent](packages/landing/public/images/agent-daemon-wake.gif)

把一条想法派给远程 Agent 的某个目录，打开对话窗口，就能实时看到本地的 Claude Code 接活、开跑，全程不用碰终端，也不用手动 resume。

### 项目资源图谱：整个项目一张实时思维导图

![项目资源图谱](packages/landing/public/images/mind-map.png)

想法、提案、文档、任务连成一棵树，每张卡片的状态随着 Agent 工作实时更新。

### Proposal：AI Agent 实时生成计划

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

PM Agent 分析需求并实时生成包含 PRD 和任务 DAG 的提案，Presence 指示器实时显示 Agent 活动状态。

### Kanban：任务状态实时流转

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

Kanban 看板随 Agent 工作进度自动更新，任务卡片在 To Do → In Progress → To Verify 之间实时流转。Presence 指示器高亮显示正在被操作的资源。

---

## 连接 Agent

最快的方式是应用内的 setup 向导：打开 **Settings → Setup Guide**。它会创建 API Key，并给出适配你所用客户端的完整命令，无论是 Claude Code、Codex、Kiro、dsh、OpenCode、OpenClaw、Pi，还是任何兼容 MCP 的 agent。

按客户端分的完整接入指南 → **[Agent 接入平台](https://doc.chorus-ai.dev/zh/reference/agents/)**。

在 **Settings → Agents → Create API Key** 创建 API Key。Key 以 `cho_` 开头，仅在创建时显示一次。

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | Next.js 15 (App Router, Turbopack) |
| 语言 | TypeScript 5 (strict mode) |
| 前端 | React 19, Tailwind CSS 4, shadcn/ui |
| 数据 | PostgreSQL 16 + Prisma 7, Redis 7（可选） |
| Agent 集成 | MCP SDK (HTTP Streamable Transport) |
| 认证 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| 部署 | npm / Docker / AWS CDK |

---

## 文档

**📖 完整文档：[doc.chorus-ai.dev](https://doc.chorus-ai.dev/zh/)**

- [快速上手](https://doc.chorus-ai.dev/zh/guides/getting-started/)
- [连接 agent](https://doc.chorus-ai.dev/zh/reference/agents/)
- [AI-DLC 工作流](https://doc.chorus-ai.dev/zh/guides/ai-dlc-workflow/)
- [插件与命令](https://doc.chorus-ai.dev/zh/guides/plugin-commands/)
- [MCP 工具参考](https://doc.chorus-ai.dev/zh/reference/mcp-tools/)
- [部署与自托管](https://doc.chorus-ai.dev/zh/guides/deployment-overview/)

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)
