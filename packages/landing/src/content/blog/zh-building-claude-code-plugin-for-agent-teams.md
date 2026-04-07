---
title: "为 Claude Code Agent Teams 构建插件"
description: "来自 Chorus 项目的实战经验——插件生态、Hooks、Skills 和多 Agent 协作中的上下文注入。"
date: 2025-02-25
lang: zh
postSlug: building-claude-code-plugin-for-agent-teams
---

# 为 Claude Code Agent Teams 编写插件：从 Chorus 的实践经验看插件设计模式

> 本文基于 Chorus 项目的实际开发经验，系统介绍 Claude Code 的插件机制，重点探讨如何为 Agent Teams（Swarm 模式）构建插件，以及如何解决多 Agent 协作中的上下文注入难题。

## TL;DR：这篇文章要聊什么

Claude Code 的 Agent Teams（也叫 Swarm 模式）让一个 Team Lead Agent 可以并行调度多个 Sub-Agent 协同工作。这是一个强大的能力——但随之而来的问题是：**当你有一个外部工作追踪系统时，怎样让每个 Sub-Agent 自动接入你的工作流，而不是靠 Team Lead 在每个 spawn prompt 里手写一大堆 boilerplate？**

这篇文章的主要目的是：

1. **介绍 Claude Code 的插件体系**——Marketplace、Plugin Manifest、Hooks、Skills、MCP 配置，这些构成了一套完整的扩展机制
2. **以 Chorus 为案例**，展示一个 Agent-first 的任务管理平台是如何通过插件无缝接入 Claude Code 多 Agent 工作流的
3. **深入探讨 Sub-Agent 的上下文注入**——多 Agent 协作场景下，如何让每个 Sub-Agent 自动获得正确的工作上下文，是插件能否真正落地的关键

如果你正在考虑为自己的工具链（CI/CD、项目管理、监控系统等）编写 Claude Code 插件，希望这篇文章能给你一些启发。

---

## 一、Claude Code Agent Teams：Swarm 模式速览

Agent Teams 是 Claude Code 的多 Agent 协作模式。核心概念很简单：

```
Team Lead (主 Agent)
  ├── Task tool ──> Sub-Agent A (frontend-worker)
  ├── Task tool ──> Sub-Agent B (backend-worker)
  └── Task tool ──> Sub-Agent C (test-runner)
```

Team Lead 通过 `Task` 工具 spawn 多个 Sub-Agent，每个 Sub-Agent 是一个独立的 Agent 进程，拥有自己的上下文窗口、工具访问权限、和独立的生命周期。Sub-Agent 之间通过 `SendMessage` 通信，通过共享文件系统协作。

关键生命周期事件：

| 事件 | 触发时机 | `additionalContext` 注入目标 |
|------|----------|---------------------------|
| `PreToolUse:Task` | Team Lead 调用 Task 工具**之前** | Team Lead |
| `SubagentStart` | Sub-Agent 进程启动时（同步） | **Sub-Agent** |
| `TeammateIdle` | Sub-Agent 空闲（完成一轮对话） | Team Lead |
| `TaskCompleted` | Claude Code 内部 Task 标记完成 | Team Lead |
| `SubagentStop` | Sub-Agent 进程退出时 | Team Lead |

注意一个关键区别——Hook 输出的注入目标并不相同：

- 大多数 Hook（`PreToolUse:Task`、`TeammateIdle`、`TaskCompleted`、`SubagentStop`）的 `additionalContext` 注入到 **Team Lead** 的上下文
- **`SubagentStart` 是例外**——它的 `additionalContext` 直接注入到 **Sub-Agent** 的上下文

这意味着 `SubagentStart` 是向 Sub-Agent 自动提供工作上下文（Session ID、工作流指令等）的理想 Hook——不需要 Team Lead 手写 boilerplate，也不需要 Sub-Agent 读取文件。

---

## 二、Chorus 是什么，解决什么问题

在深入插件实现之前，先简单介绍一下 Chorus。

[Chorus](https://github.com/Chorus-AIDLC/chorus) 是一个 AI Agent 与人类的协作平台，受 [AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)方法论启发，实现了其中从 Idea 到 Verify 的核心工作流：

```
Idea → Proposal → [Document + Task] → Execute → Verify → Done
 ^        ^            ^                 ^          ^        ^
Human   PM Agent    PM Agent         Dev Agent   Admin    Admin
```

核心理念是**反转对话**（Reversed Conversation）：AI 提出方案，人类审核和验证——而不是人类下指令、AI 执行。

在多 Agent 团队场景下，Chorus 需要解决一个具体问题：**可观测性**（Observability）。当 5 个 Sub-Agent 同时在写代码时：

- 哪个 Agent 正在处理哪个 Task？
- 每个 Agent 的工作进度是什么？
- Task 状态流转（open → in_progress → to_verify → done）是否正确？
- Agent 是否还活着（heartbeat）？

Chorus 通过 **Session** 机制追踪这一切——每个工作中的 Agent 拥有一个 Session，Session checkin 到 Task 上，UI 实时展示谁在做什么。

### Chorus 用起来是什么样的

文字描述总是抽象的，来看几张实际截图。

**Kanban 看板 — 实时追踪 Agent 工作状态**

![Kanban 看板](/images/kanban-auto-update.gif)

这是 Chorus 的核心视图。每个 Task 卡片上的彩色徽章显示当前正在处理该 Task 的 Agent Session。当 Sub-Agent 调用 `chorus_session_checkin_task` 后，徽章实时出现；调用 `checkout` 后消失。Task 在不同列之间的移动（Open → In Progress → To Verify → Done）由 Agent 通过 MCP 工具驱动。

**Task 依赖图（DAG）**

![DAG](/images/dag.png)

Chorus 中的 Task 可以声明依赖关系，形成有向无环图。PM Agent 在创建 Proposal 时通过 `dependsOnDraftUuids` 设置依赖。UI 使用 dagre 自动布局。Team Lead 可以据此决定 spawn 顺序——先处理没有依赖的 Task，被依赖的 Task 完成后，下游 Task 自动解除阻塞。

**Elaboration — 结构化需求细化**

![Elaboration](/images/elaboration.png)

在 Idea 进入 Proposal 之前，PM Agent 会发起 Elaboration（需求细化）：针对 Idea 提出结构化问题（功能范围、技术选型、优先级等），人类通过交互式选项回答。所有问答作为审计轨迹持久化到 Idea 上，确保设计决策有据可查——即使是口头讨论中达成的共识，也会被记录下来。

**Proposal — AI 提出方案，人类审核**

![Proposal](/images/proposal.png)

这是 AI-DLC 的核心理念"反转对话"的体现：PM Agent 基于 Elaboration 的结论，创建包含 PRD 文档草案和 Task 草案的 Proposal。Admin（人类）审核通过后，草案自动物化为真实的 Document 和 Task 实体。

**Task 详情 — Session 追踪**

![Task Tracking](/images/task-tracking.png)

Task 详情页展示了完整的工作历史：哪些 Session 曾经 checkin 过这个 Task，每次 checkin/checkout 的时间，以及 Agent 提交的工作报告。这就是 Chorus 的可观测性——即使 5 个 Agent 同时工作，你也能清楚看到每个人在做什么。

**像素办公室 — Agent 的虚拟工位**

![Pixel Workspace](/images/pixcel-workspace.gif)

这是 Chorus 的趣味功能：每个活跃的 Agent Session 在像素办公室里有自己的工位。Agent checkin 到 Task 时开始"工作"动画，idle 时休息，完成时庆祝。纯粹的可视化娱乐，但能一眼看出团队的工作状态。

---

## 三、为什么要写 Claude Code 插件

没有插件之前，Team Lead 需要在每个 Sub-Agent 的 spawn prompt 里手写大量 boilerplate：

```python
Task({
  name: "frontend-worker",
  prompt: """
    你的 Chorus session UUID: ???（Team Lead 还不知道，因为 session 还没创建）
    你的 Chorus task UUID: task-A-uuid

    工作前：
    1. 创建 session: chorus_create_session(...)
    2. Checkin: chorus_session_checkin_task(sessionUuid, taskUuid)
    3. 更新状态: chorus_update_task(taskUuid, "in_progress", sessionUuid)

    工作中：
    4. 汇报进度: chorus_report_work(taskUuid, report, sessionUuid)

    完成后：
    5. Checkout: chorus_session_checkout_task(sessionUuid, taskUuid)
    6. 提交验证: chorus_submit_for_verify(taskUuid, summary)
    7. 关闭 session: chorus_close_session(sessionUuid)
  """
})
```

问题显而易见：

1. **Session UUID 不可能预知**——Session 需要调用 MCP 才能创建，但 prompt 在 spawn 之前就要写好
2. **每个 Sub-Agent 的 prompt 里重复同样的 boilerplate**——6-7 步工作流指令，占据大量 prompt 空间
3. **Team Lead 必须记住所有步骤**——忘了 checkout？忘了 heartbeat？Session 就会失效
4. **Session 生命周期管理复杂**——创建、复用、重开、心跳、关闭，全靠手动

有了插件，这一切可以自动化：

```python
Task({
  name: "frontend-worker",
  prompt: """
    你的 Chorus task UUID: task-A-uuid
    实现前端用户表单组件...
  """
})
```

从 15 行 boilerplate 到 2 行。Team Lead 只需传递 task UUID——插件的 `SubagentStart` Hook 会自动将 session UUID 和完整的工作流指令直接注入到 Sub-Agent 的上下文中。不需要读取 session 文件，不需要复制工作流模板。

---

## 四、Claude Code 插件体系全览

Claude Code 的插件是一个目录，包含以下组件：

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # 插件清单（元数据）
├── .mcp.json                # MCP 服务器配置
├── hooks/
│   └── hooks.json           # Hook 配置
├── bin/                     # Hook 脚本
│   ├── on-session-start.sh
│   └── on-subagent-start.sh
└── skills/
    └── my-skill/
        ├── SKILL.md         # 技能入口文件
        └── references/      # 参考文档
```

下面逐一介绍各组件。

### 4.1 Plugin Manifest（plugin.json）

位于 [`.claude-plugin/plugin.json`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/.claude-plugin/plugin.json)，是插件的身份证：

```json
{
  "name": "chorus",
  "description": "Chorus AI-DLC collaboration platform plugin...",
  "version": "0.1.3",
  "author": { "name": "Chorus-AIDLC" },
  "homepage": "https://github.com/Chorus-AIDLC/chorus",
  "license": "AGPL-3.0",
  "keywords": ["ai-dlc", "mcp", "multi-agent", "session"]
}
```

`plugin.json` 是可选的——如果省略，Claude Code 会从目录名推断插件名称，并自动发现各组件。但推荐总是提供，便于版本管理和分发。

### 4.2 Marketplace（插件市场）

插件通过 Marketplace 分发。Marketplace 本质上是一个 JSON 清单文件（[`.claude-plugin/marketplace.json`](https://github.com/Chorus-AIDLC/Chorus/blob/main/.claude-plugin/marketplace.json)），放在 GitHub 公开仓库中即可。Chorus 就是用自己的 GitHub 仓库作为 Marketplace：

```json
{
  "name": "chorus-plugins",
  "owner": { "name": "Chorus-AIDLC" },
  "plugins": [
    {
      "name": "chorus",
      "source": "./public/chorus-plugin",
      "description": "Chorus AI-DLC collaboration platform plugin...",
      "version": "0.1.3",
      "category": "project-management",
      "tags": ["ai-dlc", "collaboration", "mcp", "session"]
    }
  ]
}
```

用户安装 Chorus 插件的实际流程：

```bash
# 1. 添加 marketplace — 指向 GitHub 仓库（仓库中包含 .claude-plugin/marketplace.json）
/plugin marketplace add Chorus-AIDLC/chorus

# 2. 安装插件 — 格式为 插件名@marketplace名
/plugin install chorus@chorus-plugins

# 3. 可以指定作用域
/plugin install chorus@chorus-plugins --scope project  # 项目级（团队共享，提交到 git）
/plugin install chorus@chorus-plugins --scope local    # 本地级（仅自己）
```

`source` 字段指向插件在仓库中的相对路径。除了本地路径，还支持指向其他 GitHub repo（`"source": {"source": "github", "repo": "owner/repo"}`）或 Git URL 等来源。

### 4.3 MCP 配置（[.mcp.json](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/.mcp.json)）

插件可以自带 MCP Server 配置，安装后自动生效：

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "${CHORUS_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CHORUS_API_KEY}"
      }
    }
  }
}
```

`${CHORUS_URL}` 和 `${CHORUS_API_KEY}` 是环境变量——Claude Code 在运行时自动替换。用户只需设置环境变量，插件就能连接到正确的服务。

这意味着：**插件安装后，所有 MCP 工具自动可用**。Sub-Agent 也能访问（前提是 MCP 配置在项目级别，而不是用户级别）。

**Chorus 的 MCP 配置**：Chorus 通过 HTTP Streamable Transport 暴露了 50+ 个 MCP 工具，按角色分组（公共工具、PM 工具、Developer 工具、Admin 工具、Session 工具）。用户只需设置两个环境变量 `CHORUS_URL` 和 `CHORUS_API_KEY`，插件就能连接到 Chorus 服务。API Key 以 `cho_` 前缀开头，携带 Agent 角色信息，服务端据此决定哪些工具可见。

### 4.4 Skills（技能系统）

Skills 是插件内置的指令集，Claude 可以在需要时自动调用，用户也可以通过 `/skill-name` 手动触发。

一个 Skill 由一个 `SKILL.md` 入口文件和可选的 `references/` 参考文档组成：

```markdown
---
name: chorus
description: Chorus AI Agent collaboration platform Skill...
metadata:
  author: chorus
  version: "0.1.1"
  category: project-management
  mcp_server: chorus
---

# Chorus Skill

This Skill guides AI Agents on how to use Chorus MCP tools...

## Skill Files

| File | Description |
|------|-------------|
| **references/02-pm-workflow.md** | PM Agent workflow |
| **references/03-developer-workflow.md** | Developer Agent workflow |
| **references/06-claude-code-agent-teams.md** | Agent Teams integration |
```

**Chorus 的 Skill 体系**：Chorus 包含 [7 个参考文档](https://github.com/Chorus-AIDLC/Chorus/tree/main/public/chorus-plugin/skills/chorus/references)（`references/00` 到 `references/06`），覆盖从公共工具、PM 工作流、Developer 工作流、Admin 工作流，到 Session 管理和 Agent Teams 集成的完整指南。当 Agent 调用 `/chorus` 或 Claude 判断需要 Chorus 知识时，Skill 文档自动加载到上下文中。这相当于给每个 Agent 一本随身携带的操作手册——无论是 Team Lead 还是 Sub-Agent，都能通过 Skill 了解正确的工作流程。

Skill 的 frontmatter 支持丰富的配置项：

```yaml
---
name: my-skill
description: "When to use this skill"
allowed-tools: Read, Grep, Glob     # 允许无需权限使用的工具
model: claude-opus-4-6              # 指定模型
context: fork                       # 在 subagent 中运行
disable-model-invocation: true      # 仅用户可触发（Claude 不会自动调用）
---
```

### 4.5 Hooks（钩子系统）

Hooks 是插件的核心——它们让你在 Claude Code 生命周期的关键节点执行自定义逻辑。

配置在 [`hooks/hooks.json`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/hooks/hooks.json)：

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|compact",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/on-session-start.sh"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/on-subagent-start.sh"
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/on-subagent-stop.sh",
        "async": true
      }]
    }]
  }
}
```

#### Hook 类型

Claude Code 支持三种 Hook 执行方式：

| 类型 | 说明 | 适用场景 |
|------|------|----------|
| `command` | 执行 shell 命令，通过 stdin 接收事件 JSON，通过 stdout 输出结果 | 大多数场景 |
| `prompt` | 用 LLM 评估决策，模型返回 `{ok: true/false}` | 需要智能判断时（如代码审查） |
| `agent` | spawn 一个有工具访问权限的 subagent 来验证 | 需要执行复杂多步验证时（如跑测试） |

Chorus 插件的所有 Hook 都使用 `command` 类型——因为 Chorus 的 Hook 逻辑是确定性的（调 API、读写文件、管理状态），不需要 LLM 判断。`prompt` 和 `agent` 更适合需要"理解"代码内容才能做决策的场景，比如在 `Stop` 事件中用 `agent` 类型自动跑测试来判断任务是否真的完成。

#### Hook 事件全表

| 事件 | 触发时机 | 能否阻断 |
|------|----------|---------|
| `SessionStart` | 会话开始/恢复/compact | 否 |
| `UserPromptSubmit` | 用户提交输入 | 是 |
| `PreToolUse` | 工具执行前 | 是 |
| `PostToolUse` | 工具执行后 | 否 |
| `SubagentStart` | Sub-Agent 启动 | 否 |
| `SubagentStop` | Sub-Agent 退出 | 是 |
| `TeammateIdle` | Sub-Agent 空闲 | 是 |
| `TaskCompleted` | CC Task 完成 | 是 |
| `SessionEnd` | 会话结束 | 否 |

#### Hook 输出格式

知道有哪些事件后，下一个问题是：**Hook 脚本能返回什么来影响 Claude 的行为？** Hook 通过 stdout 输出 JSON：

```json
{
  "systemMessage": "用户可见的通知消息",
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "这段文字会注入到 Claude 的上下文中",
    "permissionDecision": "allow"
  }
}
```

关键字段：

- **`systemMessage`**：显示在 Claude Code UI 中的通知，用户可见
- **`additionalContext`**：注入到 LLM 的 system context 中——**这是 Hook 影响 Claude 行为的主要手段**。Chorus 的 `SessionStart` Hook 就是通过它把 checkin 结果（身份、任务、通知）注入到 Agent 上下文的
- **`permissionDecision`**：`allow` / `deny` / `ask`，用于 `PreToolUse` 控制工具执行权限
- **`suppressOutput`**：设为 `true` 可静默输出——Chorus 的 `TeammateIdle` Hook 用它来避免每次心跳都弹通知

#### 同步 vs 异步

- **同步 Hook**（默认）：阻塞 Claude 直到完成。适合需要立即影响的场景——Chorus 的 `SubagentStart` 必须同步，因为它要在 Sub-Agent 开始工作前创建好 session 并写入 session file
- **异步 Hook**（`"async": true`）：后台运行，不阻塞。适合不影响流程的场景——Chorus 的 `SubagentStop`（清理资源）和 `TeammateIdle`（心跳）都是异步的

#### 每个 Hook 事件 Chorus 用它做什么

了解了事件、输出格式、同步/异步之后，来看 Chorus 插件如何具体使用每个 Hook。

**`SessionStart` — Checkin + 上下文注入**

这是插件的"开机自检"。注意 `SessionStart` 的 matcher 配置为 `startup|resume|compact`，这意味着它不仅在会话启动和恢复时触发，**还会在上下文压缩（compact）后重新触发**。当长对话触发自动压缩时，之前注入的 Chorus 上下文会随着旧消息被压缩而丢失——`compact` matcher 确保压缩后立即重新注入最新的 checkin 信息，Agent 不会因为上下文压缩而"失忆"。

Chorus 在这里做三件事：

1. 调用 `chorus_checkin()` MCP 工具，获取当前 Agent 的身份（角色、名称、人格）、已分配的 Idea 和 Task、未读通知
2. 将完整的 checkin 结果通过 `additionalContext` 注入到 Claude 的上下文中——Agent 一启动就知道自己是谁、该做什么
3. 扫描 `.chorus/sessions/` 目录，列出已有的 Sub-Agent session 元数据——这是为了处理 Claude Code 会话中断后恢复的情况：上次的 session 文件可能还在，Team Lead 恢复后需要知道哪些 session 仍然存在

```bash
# on-session-start.sh 核心逻辑
CHECKIN_RESULT=$("$API" mcp-tool "chorus_checkin" '{}')

CONTEXT="# Chorus Plugin — Active
Chorus is connected at ${CHORUS_URL}.
## Checkin Result
${CHECKIN_RESULT}
## Session Management — IMPORTANT
The Chorus Plugin fully automates session lifecycle...
Do NOT call chorus_create_session for sub-agents."

"$API" hook-output "$USER_MSG" "$CONTEXT" "SessionStart"
```

效果：Agent 在第一轮对话就拥有了完整的项目上下文和行为指南，不需要用户手动告知。

**`UserPromptSubmit` — 轻量级状态提醒**

每次用户输入都会触发，所以必须极快（<100ms）。Chorus 在这里**不做任何网络调用**，只做本地文件检查：

```bash
# on-user-prompt.sh — 纯本地操作，不调 MCP
# 统计 .chorus/sessions/ 下的 json 文件数量
CONTEXT="[Chorus Plugin Active]
- Active sub-agent sessions (3): frontend-worker, backend-worker, test-runner"
```

这给 Team Lead 一个持续的状态感知：当前有几个 Sub-Agent session 在运行。

**`PreToolUse` — 工作流引导（3 个子 Hook）**

Chorus 注册了 3 个 `PreToolUse` Hook，分别匹配不同的工具：

| matcher | 脚本 | Chorus 做什么 |
|---------|------|--------------|
| `EnterPlanMode` | [`on-pre-enter-plan.sh`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/on-pre-enter-plan.sh) | 注入 Chorus Proposal 工作流指南——"先创建 Proposal，设置 Task 依赖 DAG，提交审批后再编码" |
| `ExitPlanMode` | [`on-pre-exit-plan.sh`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/on-pre-exit-plan.sh) | 提醒检查——"退出 Plan Mode 前确认 Proposal 已创建并提交" |
| `Task` | [`on-pre-spawn-agent.sh`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/on-pre-spawn-agent.sh) | 捕获 Sub-Agent 的 name/type 写入 pending 文件，供 SubagentStart 认领 |

`EnterPlanMode` 和 `ExitPlanMode` 展示了一个有趣的用法：**用 Hook 引导 Agent 遵循特定的工作流程**。当 Agent 进入 Plan Mode 时，Chorus 自动注入"先创建 Proposal 再编码"的指导；退出 Plan Mode 时，检查是否已有 Proposal。这不是强制阻断（`permissionDecision` 仍然是 `allow`），而是通过 `additionalContext` 做软性引导。

**`SubagentStart` — Session 自动创建 + 直接上下文注入**（核心）

这是 Chorus 插件最核心的 Hook，详见第五章。简要概括：认领 pending 文件 → 创建/复用 Session → 通过 `additionalContext` 将 session UUID + 工作流指令直接注入 Sub-Agent 上下文 → 存储状态映射。Session 文件仅保存最小元数据供其他 Hook 使用。

**`SubagentStop` — 自动清理 + 任务发现**

异步执行，做四件事：(1) 批量 checkout 所有未关闭的 task checkin，(2) 关闭 Session，(3) 清理本地文件和状态，(4) 查询项目中新解除阻塞的 Task 并通过 `additionalContext` 通知 Team Lead——这一步非常有价值，它实现了**自动任务调度发现**：当一个前置 Task 完成后，下游 Task 自动解除阻塞，Team Lead 立即得到通知可以分配新工作。

**`TeammateIdle` — 自动心跳**

异步 + `suppressOutput: true`。只做一件事：调 `chorus_session_heartbeat` 保持 Session 活跃。Chorus 的 Session 超过 1 小时没有心跳会自动标记为 inactive——这个 Hook 确保只要 Sub-Agent 还在运行，Session 就不会失活。

**`TaskCompleted` — 元数据桥接**

当 Claude Code 内部的 Task 标记完成时，Chorus 检查 task 描述中是否包含 `chorus:task:<uuid>` 标签。如果有，自动执行 `chorus_session_checkout_task`。这是一个优雅的**元数据桥接**模式——通过在 CC Task 描述中嵌入 Chorus task UUID，让两个系统的 Task 生命周期联动。

**`SessionEnd` — 清理 .chorus/ 目录**

会话结束时，检查是否所有 session 文件都已清理、state.json 是否为空。如果是，删除整个 `.chorus/` 目录，不留垃圾文件。

---

## 五、Chorus 插件的完整实现

现在进入正题——Chorus 插件是如何利用上述机制解决多 Agent 协作问题的。

### 5.1 整体架构

```
Team Lead 调用 Task 工具 spawn Sub-Agent
  │
  ├─ [PreToolUse:Task] on-pre-spawn-agent.sh
  │    写入 .chorus/pending/<name> 文件（捕获 agent name）
  │
  ├─ [SubagentStart] on-subagent-start.sh    ← 核心
  │    认领 pending 文件（原子 mv，处理并发）
  │    创建/复用/重开 Chorus Session（MCP 调用）
  │    通过 additionalContext 将 session UUID + 工作流注入 Sub-Agent
  │    写入最小 session 文件（元数据供其他 Hook 使用）
  │    存储 state 映射（agent_id ↔ session_uuid）
  │
  ├─ Sub-Agent 开始执行
  │    Session UUID + 工作流已在上下文中（自动注入）
  │    自主执行 checkin → in_progress → report → checkout → submit
  │
  ├─ [TeammateIdle] on-teammate-idle.sh（异步）
  │    发送 session heartbeat，保持 session 活跃
  │
  ├─ [TaskCompleted] on-task-completed.sh
  │    检测 chorus:task:<uuid> 标签，自动 checkout
  │
  └─ [SubagentStop] on-subagent-stop.sh（异步）
       批量 checkout 所有 task
       关闭 Chorus Session
       清理本地状态
       查询并展示新解除阻塞的 task
```

### 5.2 `.chorus/` 目录：连接一切的桥梁

前面多次提到"共享文件系统"，现在展开说。Chorus 插件在项目根目录下维护一个 `.chorus/` 目录（gitignored），它是 Team Lead、Sub-Agent、和所有 Hook 之间的信息枢纽：

```
.chorus/                              # 插件运行时状态（gitignored）
├── state.json                        # 全局状态 KV 存储
├── state.json.lock                   # flock 排他锁文件
├── sessions/                         # Sub-Agent session 元数据（供 Hook 状态查询）
│   ├── frontend-worker.json
│   ├── backend-worker.json
│   └── test-runner.json
├── pending/                          # PreToolUse:Task 写入，等待 SubagentStart 认领
│   └── <agent-name>
└── claimed/                          # SubagentStart 认领后的文件
    └── <agent-id>
```

#### 核心：`state.json` — 跨 Hook 的状态共享

每个 Hook 都是独立的 shell 进程，它们不共享内存。`state.json` 是所有 Hook 之间的共享状态存储：

```json
{
  "session_a0ed860": "699f8ed4-4a98-4522-8321-662a2222a180",
  "agent_for_session_699f8ed4-...": "a0ed860",
  "session_frontend-worker": "699f8ed4-...",
  "name_for_agent_a0ed860": "frontend-worker",
  "main_session_uuid": "..."
}
```

存储的是四组映射关系：`agent_id → session_uuid`、`session_uuid → agent_id`、`agent_name → session_uuid`、`agent_id → agent_name`。这样任何 Hook 只要知道其中一个 ID，就能查到其余所有关联信息。

#### 并发写入保护：flock

当 5 个 Sub-Agent 同时 spawn 时，5 个 `SubagentStart` Hook 会并发执行，每个都要往 `state.json` 写入 4 个 key。如果不做保护，JSON 文件会被并发写入损坏。

Chorus 在 [`chorus-api.sh`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/chorus-api.sh) 中用 `flock` 排他锁解决这个问题：

```bash
# chorus-api.sh 中的 state_set 实现
state_set() {
  local key="$1" value="$2"
  (
    # 获取排他锁，超时 5 秒
    flock -w 5 200 || { echo "WARN: flock timeout" >&2; return 0; }
    # 在锁保护下修改 JSON
    jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$STATE_FILE" > "$tmp" \
      && mv "$tmp" "$STATE_FILE"
  ) 200>"${STATE_FILE}.lock"
}
```

关键细节：
- `flock -w 5 200`：在文件描述符 200 上获取排他锁，等待最多 5 秒
- `200>"${STATE_FILE}.lock"`：锁文件与 state 文件分开（`.lock` 后缀）
- `jq ... > $tmp && mv $tmp`：先写临时文件再原子替换，避免写到一半崩溃导致文件损坏
- 超时不报错（`return 0`）——宁可丢失一次状态写入，也不阻塞整个 Hook 链

#### `pending/` → `claimed/`：原子所有权转移

`SubagentStart` 事件只提供 `agent_id` 和 `agent_type`，**不提供 Team Lead 给 Sub-Agent 起的名字**。但 session 需要用名字命名（这样 Sub-Agent 才能通过名字找到自己的 session 文件）。

解决方案是两个 Hook 的接力：

1. `PreToolUse:Task`（Team Lead 上下文）能从 `tool_input` 中拿到 `name` 参数，写入 `pending/<name>` 文件
2. `SubagentStart`（仍是 Team Lead 上下文，但并发执行）通过 `mv pending/<name> claimed/<agent_id>` 原子认领

```
时间线：
  T1  PreToolUse:Task 触发 → 写 .chorus/pending/frontend-worker
  T2  PreToolUse:Task 触发 → 写 .chorus/pending/backend-worker
  T3  SubagentStart(agent_id=a0e) 触发 → mv pending/frontend-worker → claimed/a0e ✓
  T4  SubagentStart(agent_id=b1f) 触发 → mv pending/backend-worker → claimed/b1f ✓
  T4' SubagentStart(agent_id=c2g) 触发 → mv pending/frontend-worker → 失败（已被 a0e 认领）
                                        → mv pending/backend-worker → 失败（已被 b1f 认领）
                                        → 没有更多 pending 文件 → 跳过（内部 agent，不创建 session）
```

`mv` 在同一文件系统上是原子操作——只有一个进程能成功移动同一个文件。这比 flock 更轻量，适合"谁先到谁拿"的场景。

#### `sessions/` — 跨 Hook 的状态查询入口

Session 文件现在只包含最小元数据（sessionUuid、agentId、agentName）。工作流指令通过 `SubagentStart` 的 `additionalContext` 直接注入 Sub-Agent 上下文——Sub-Agent 不再需要读取这些文件。文件仍有作用：其他 Hook（`TeammateIdle`、`SubagentStop`）用它来查找 session 信息以执行心跳和清理。

#### 生命周期：创建到清理

```
SessionStart  → mkdir -p .chorus/（如果不存在）
PreToolUse    → 写 .chorus/pending/<name>
SubagentStart → mv pending → claimed，写 sessions/<name>.json（仅元数据），
                通过 additionalContext 注入工作流 → Sub-Agent，更新 state.json
TeammateIdle  → 读 state.json（查 session_uuid），无写入
TaskCompleted → 读 state.json（查 session_uuid），无写入
SubagentStop  → 删 sessions/<name>.json，删 claimed/<agent_id>，清 state.json 条目
SessionEnd    → 如果 sessions/ 为空且 state.json 为空 → rm -rf .chorus/
```

整个目录的生命周期和 Claude Code session 一致——开始时创建，结束时清理，不留痕迹。

### 5.3 核心难题：Sub-Agent 的上下文注入

关键问题是：如何让每个 Sub-Agent 自动获得它的 session UUID 和工作流指令，而不需要 Team Lead 手写 boilerplate？

答案在于 `SubagentStart` Hook 的一个关键特性：**它的 `additionalContext` 直接注入到 Sub-Agent 的上下文中**，而不是 Team Lead 的。这使它成为理想的注入点——创建 session（因此拥有 sessionUuid）的 Hook 同时也能注入工作流，一步到位。

```bash
# on-subagent-start.sh — 核心片段
# 创建/复用 session 并获得 SESSION_UUID 之后...

WORKFLOW="## Chorus Session (Auto-injected by plugin)

Your Chorus session UUID is: ${SESSION_UUID}
Your session name is: ${SESSION_NAME}
Do NOT call chorus_create_session or chorus_close_session.

### Workflow — follow these steps for each task:

**Before starting:**
1. Check in: chorus_session_checkin_task({ sessionUuid: \"${SESSION_UUID}\", taskUuid: \"<TASK_UUID>\" })
2. Start work: chorus_update_task({ taskUuid: \"<TASK_UUID>\", status: \"in_progress\", sessionUuid: \"${SESSION_UUID}\" })

**While working:**
3. Report progress: chorus_report_work({ taskUuid: \"<TASK_UUID>\", report: \"...\", sessionUuid: \"${SESSION_UUID}\" })

**After completing:**
4. Check out: chorus_session_checkout_task({ sessionUuid: \"${SESSION_UUID}\", taskUuid: \"<TASK_UUID>\" })
5. Submit: chorus_submit_for_verify({ taskUuid: \"<TASK_UUID>\", summary: \"...\" })

Replace <TASK_UUID> with the actual Chorus task UUID from your prompt."

"$API" hook-output \
  "Chorus session ${SESSION_ACTION}: '${SESSION_NAME}'" \
  "$WORKFLOW" \
  "SubagentStart"
```

Sub-Agent 从第一轮对话就能在上下文中以 `<system-reminder>` 的形式看到工作流。Session 文件精简为仅含 sessionUuid + 元数据，供其他 Hook 使用。

这样 Team Lead 的 spawn prompt 真正做到了最简：

```python
Task({
  name: "frontend-worker",
  prompt: """
    Your Chorus task UUID: task-A-uuid
    实现前端用户表单组件...
  """
})
```

插件处理其余一切——Team Lead 只需传递 task UUID。

### 5.4 Session 复用：避免重复创建

当 Team Lead 多次 spawn 同名的 Sub-Agent 时（比如 Task 被 Admin reopen 后重新分配），插件不会创建新 Session，而是复用已有的：

```bash
# on-subagent-start.sh 中的复用逻辑
if [ "$MATCH_STATUS" = "active" ]; then
    SESSION_UUID="$MATCH_UUID"         # 直接复用
    SESSION_ACTION="reused"
elif [ "$MATCH_STATUS" = "closed" ] || [ "$MATCH_STATUS" = "inactive" ]; then
    # 重开已关闭的 session
    chorus_reopen_session(sessionUuid)
    SESSION_ACTION="reopened"
else
    # 创建新 session
    chorus_create_session(name)
    SESSION_ACTION="created"
fi
```

### 5.5 自动清理：SubagentStop

当 Sub-Agent 退出时，[`on-subagent-stop.sh`](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/on-subagent-stop.sh)（异步执行）负责清理：

1. 查询 Session 的所有活跃 checkin，逐一 checkout
2. 关闭 Chorus Session
3. 删除本地状态（state entries、session file、claimed file）
4. 查询项目中新解除阻塞的 Task，通知 Team Lead

这样即使 Sub-Agent 忘了 checkout 或 close session，插件也会兜底。

### 5.6 自动心跳：TeammateIdle

Sub-Agent 在两轮对话之间会进入 idle 状态，此时 `TeammateIdle` Hook 自动发送 heartbeat：

```bash
# on-teammate-idle.sh
"$API" mcp-tool "chorus_session_heartbeat" \
  "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")"
```

输出被 `suppressOutput: true` 静默——心跳太频繁，不需要通知 Team Lead。

---

## 六、设计模式总结

从 Chorus 插件的实践中，可以提炼出几个通用的设计模式：

### 模式 1：SubagentStart 直接注入上下文

```
SubagentStart Hook  →  additionalContext  →  Sub-Agent 的上下文
（拥有 session 数据）    （直接注入）            （立即可见）
```

`SubagentStart` 的 `additionalContext` 是向 Sub-Agent 注入上下文最可靠的方式。它在 spawn 时同步触发，拥有所有 session 数据，并直接注入 Sub-Agent——不需要文件读取、不需要 prompt 操作、不需要 Team Lead 参与。

### 模式 2：文件系统用于 Hook 间状态传递（而非 Sub-Agent 通信）

共享文件系统（`.chorus/` 目录）的价值在于 **Hook 到 Hook** 的状态传递（如 `pending/` 文件从 `PreToolUse` 传递 agent 名称到 `SubagentStart`），但不应该作为 Sub-Agent 上下文注入的主要机制。上下文注入应使用 `SubagentStart` 的 `additionalContext`。

### 模式 3：PreToolUse 捕获 + SubagentStart 执行

`SubagentStart` 事件中拿不到 Sub-Agent 的名字（只有 `agent_id` 和 `agent_type`），但 `PreToolUse:Task` 可以从 `tool_input` 中提取。两个 Hook 通过文件系统（pending → claimed）传递信息。

### 模式 4：异步 Hook 做非阻塞清理

Session 关闭、资源清理、通知发送等不影响流程的操作，放在异步 Hook 中执行。不要让清理逻辑阻塞 Sub-Agent 的退出。

### 模式 5：Hook 只提醒，不强制

`PreToolUse:Task` 向 Team Lead 注入提醒（"记得在 prompt 里包含 task UUID"），但不阻断操作。团队协作中，**建议优于强制**——过于严格的 Hook 会降低使用体验。

---

## 七、快速开始：编写你自己的插件

如果你想为自己的工具链编写 Claude Code 插件，这里是最小可行步骤：

### Step 1：创建目录结构

```bash
mkdir -p my-plugin/.claude-plugin my-plugin/hooks my-plugin/bin
```

### Step 2：编写 plugin.json

```json
{
  "name": "my-plugin",
  "description": "My custom plugin for Claude Code",
  "version": "0.1.0"
}
```

### Step 3：编写第一个 Hook

`hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/on-start.sh"
      }]
    }]
  }
}
```

`bin/on-start.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

cat <<EOF
{
  "systemMessage": "My plugin is active!",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "My Plugin is connected. Custom workflow instructions here."
  }
}
EOF
```

### Step 4：本地测试

```bash
chmod +x my-plugin/bin/on-start.sh
claude --plugin-dir ./my-plugin
```

### Step 5：发布到 Marketplace

创建 `.claude-plugin/marketplace.json`：
```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [{
    "name": "my-plugin",
    "source": "./my-plugin",
    "version": "0.1.0"
  }]
}
```

---

## 写在最后

Claude Code 的插件系统提供了一套完整的扩展机制——从 Marketplace 分发，到 MCP 工具集成，到 Hooks 生命周期管理，再到 Skills 知识注入。Agent Teams（Swarm 模式）的引入让多 Agent 协作成为可能，而插件让这种协作变得可管理、可观测。

Chorus 插件的实践表明，`SubagentStart` 的 `additionalContext`——直接注入 Sub-Agent 上下文——是实现无缝多 Agent 工作流自动化的关键。结合共享文件系统的跨 Hook 状态管理和 `PreToolUse` 的 spawn 时元数据捕获，可以实现完全自动化的 session 生命周期，Team Lead 的 prompt 中零 boilerplate。

如果你对 Chorus 感兴趣，欢迎访问 [GitHub](https://github.com/Chorus-AIDLC/chorus) 了解更多。如果你正在构建自己的 Claude Code 插件，希望本文的经验能帮你少走弯路。
