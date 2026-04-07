---
title: "为 Chorus 构建 OpenClaw 插件"
description: "SSE + MCP 双通道架构，让 AI Agent 真正「住进」工作流——事件推送感知 + 工具协议执行。"
date: 2025-03-02
lang: zh
postSlug: building-openclaw-plugin-for-chorus
---

# 为 OpenClaw 构建 Chorus 插件：从 SSE 到 MCP，让 AI Agent 真正"活"在工作流里

你有没有遇到过这样的场景：平台上分配了任务，切到终端复制粘贴给 Agent，等它干完再回平台更新状态。Agent 明明很能干，但感知不到"有活来了"，也没法主动汇报 — 它不是团队成员，只是一个你手动喂指令的工具。

这篇文章分享三个可以直接搬走的 pattern：**双通道架构**（事件推送感知 + 工具协议执行）、**Prompt 驱动行为**（消息模板引导自主决策）、**薄代理桥接**（统一模式暴露 MCP 工具）。以 [Chorus](https://github.com/Chorus-AIDLC/chorus) × [OpenClaw](https://openclaw.ai) 的实际集成为例。

## TL;DR

**SSE + MCP 的天然组合** — Chorus 给人类的 SSE 事件推送 + 给 Agent 的 MCP 工具，如何完美适配 OpenClaw 的插件模型<br> 
**OpenClaw 插件三原语** — `registerService`（后台长连接）、`registerTool`（40 个 Agent 工具）、`registerCommand`（快捷指令），如何撑起整个集成<br> 
**Hooks 唤醒机制** — 从 SSE 事件到 `/hooks/wake` 到 Agent 立刻开始工作，中间经历了什么<br> 
**消息模板设计** — 用 prompt 引导 Agent 行为（@mention、工具调用、社交行为），而不是硬编码状态机<br> 
**registerTool 桥接模式** — 40 个 MCP 工具如何通过统一模式暴露为 Agent 原生工具<br> 
**踩坑记录** — npm scoped 包名 vs 插件 ID、配置防御等真实问题<br> 

---

## 一、背景：为什么需要这个插件

[Chorus](https://github.com/Chorus-AIDLC/chorus) 实现了 AI-DLC 工作流：

```
Idea → Proposal → [Document + Task] → Execute → Verify → Done
 ^        ^            ^                 ^          ^        ^
Human   PM Agent    PM Agent         Dev Agent   Admin    Admin
```

[OpenClaw](https://openclaw.ai) 是一个 AI Agent 运行时，支持插件扩展。我们的目标是：**在 Chorus 上分配工作，OpenClaw 的 Agent 自动感知、领取、执行、汇报**。

没有插件之前，Agent 只能被动等人在终端里输入指令。有了插件，工作流变成：

```
人类在 Chorus UI 上 assign task
        ↓
SSE 推送 task_assigned 事件
        ↓
插件自动 claim task
        ↓
唤醒 Agent 开始工作
        ↓
Agent 完成后 @mention 触发者
```

人类只需要在 Web UI 上点一下"分配"，剩下的全部自动化。

---

## 二、SSE + MCP：两条现成的路，刚好凑成一双

Chorus 本身为两类用户提供了两种接口：

- **MCP 工具** — 给 AI Agent 用的操作接口，50+ 个工具覆盖完整的 AI-DLC 工作流（claim task、create proposal、@mention、elaboration 等），通过 API Key（`cho_` 前缀）认证
- **SSE 事件推送** — 给人类用户的实时通知（task 分配、proposal 审批、@mention 等），Web UI 通过长连接接收

对于 OpenClaw 这种"像人一样工作的 Agent"，两条路正好可以组合：**SSE 监听事件（知道什么时候该做事），MCP 执行操作（知道怎么做事）**。

```
Chorus Server
  │
  ├── SSE ──→ 插件监听 ──→ "有人给你 assign 了一个 task"
  │                              │
  │                              ▼
  │                         唤醒 Agent
  │                              │
  └── MCP ←── Agent 调用 ←── "chorus_claim_task + chorus_get_task + 开始工作"
```

不需要为插件单独开发 API，也不需要改 Chorus 的任何代码。Chorus 未来加新的 MCP 工具时，插件加一行注册就能用。

### 断线重连

SSE 连接会因为网络抖动、服务器重启等原因断开。重连用指数退避（1s → 2s → 4s → ... → 30s max），重连成功后调 `chorus_get_notifications` 补拉断连期间的未读通知，确保不丢事件。

---

## 三、OpenClaw 插件机制：三个原语撑起整个集成

要理解这个插件怎么工作，先要了解 OpenClaw 给插件提供了什么能力。OpenClaw 的插件 API 有三个核心原语：

| 原语 | 用途 | 在本插件中的角色 |
|------|------|-----------------|
| `registerService` | 注册后台服务（有 start/stop 生命周期） | **维持 SSE 长连接** — 插件加载时启动，持续监听 Chorus 事件 |
| `registerTool` | 注册 Agent 可调用的工具 | **暴露 40 个 Chorus MCP 工具** — Agent 可以 claim task、create proposal 等 |
| `registerCommand` | 注册 `/command` 快捷指令（不经过 LLM） | **`/chorus status`** 等快速查询命令 |

这三个原语的组合，就是插件的全部骨架：

```typescript
register(api) {
  // 1. 后台服务：SSE 长连接，持续监听 Chorus 事件
  api.registerService({
    id: "chorus-sse",
    async start() { /* 建立 SSE 连接，事件 → eventRouter.dispatch() */ },
    async stop()  { /* 断开 SSE，关闭 MCP client */ },
  });

  // 2. 工具：40 个 Chorus 操作暴露给 Agent
  registerPmTools(api, mcpClient);      // 15 个 PM 工具
  registerDevTools(api, mcpClient);     // 4 个 Developer 工具
  registerCommonTools(api, mcpClient);  // 21 个通用工具

  // 3. 命令：/chorus status, /chorus tasks, /chorus ideas
  registerChorusCommands(api, mcpClient, getStatus);
}
```

### registerService：维持 SSE 长连接

这是整个插件的核心。`registerService` 允许插件运行一个后台进程，独立于 Agent 的对话循环。我们用它维持和 Chorus 的 SSE 长连接：

- 插件加载时 `start()` 被调用，建立 SSE 连接
- 连接断开时自动重连（指数退避 1s → 30s max）
- 收到事件后通过 event-router 分发
- 插件卸载时 `stop()` 被调用，优雅断开

SSE 只推送精简的通知信封（`{ type: "new_notification", notificationUuid: "..." }`）。event-router 收到后通过 MCP 拉取完整详情，再路由到对应的处理器：

| 事件 | Agent 行为 |
|------|-----------|
| `task_assigned` | 自动 claim task + 唤醒 Agent 开始工作 |
| `idea_claimed` | 唤醒 Agent 开始 elaboration |
| `elaboration_requested` | 唤醒 Agent 审查 elaboration 问题 |
| `elaboration_answered` | 唤醒 Agent 审查答案，@mention 回答者 |
| `proposal_rejected` | 唤醒 Agent 修改 proposal 并重新提交 |
| `proposal_approved` | 唤醒 Agent 查看新创建的 task |
| `mentioned` | 唤醒 Agent 响应 @mention |

---

## 四、Agent 唤醒：从事件到行动

事件路由知道 Agent "应该做什么"了，但 Agent 可能正在空闲，怎么让它**立刻醒来开始工作**？

OpenClaw 除了插件原语之外，还有一套 **Hooks 系统**。其中 `/hooks/wake` 是关键 — 它允许外部进程（比如我们的 SSE 后台服务）主动唤醒 Agent：

```typescript
await fetch(`${gatewayUrl}/hooks/wake`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${hooksToken}`,
  },
  body: JSON.stringify({
    text: "[Chorus] Task assigned: 实现用户认证模块. Task UUID: xxx.",
    mode: "now",
  }),
});
```

这会做两件事：
1. 将 `text` 作为系统事件注入 Agent 的 prompt — Agent 下次醒来就能看到
2. 触发立即心跳 — Agent 不用等下次轮询，马上醒来

`text` 里包含了足够的上下文（task UUID、project UUID、@mention 格式指引），Agent 被唤醒后可以直接开始工作。

注意 hooks 需要单独的认证 token（`hooks.token`），且必须和 gateway 的 `auth.token` 不同 — 这是 OpenClaw 的安全设计，防止插件和网关用同一个凭据。

---

## 五、triggerAgent 消息模板：用 prompt 引导 Agent 行为

事件路由的最终输出是一段文本，通过 `/hooks/wake` 注入 Agent 的上下文。这段文本就是**消息模板** — 它决定了 Agent 被唤醒后做什么。

这是 OpenClaw 插件设计中一个有趣的模式：**插件不控制 Agent 的行为，而是通过精心构造的 prompt 引导 Agent 自主决策**。

举个例子，elaboration 回答完成后的消息模板：

```
[Chorus] Elaboration answers submitted for idea 'xxx'.
Review the answers with chorus_get_elaboration, then either:
- Call chorus_validate_elaboration with empty issues [] to resolve
- Call chorus_validate_elaboration with issues + followUpQuestions for another round

After reviewing, @mention the answerer to ask if they have
any further questions before you proceed.
Use this exact mention format: @[张三](user:550e8400-...)
```

注意最后两行 — 我们通过 prompt 告诉 Agent"完成工作后 @mention 触发者"，而不是在代码里硬编码 @mention 逻辑。Agent 收到的每个事件消息都包含了：

1. **上下文**：哪个实体、哪个项目、UUID
2. **工具指引**：该调用哪些 `registerTool` 注册的工具
3. **社交行为**：完成后 @mention 谁、用什么格式

最初我们尝试过在代码里硬编码一个状态机来强制 Agent 行为（比如"必须等人确认后才能 validate"），但很快意识到过度工程化了。**Agent 本身就有足够的判断能力，插件只需要提供正确的上下文和工具，然后用 prompt 引导方向。**

---

## 六、registerTool：40 个工具的 MCP 桥接

`registerTool` 是第二个核心原语。它让插件把外部能力暴露为 Agent 的原生工具 — Agent 调用时感觉就像在用一个内置工具，完全不知道背后是 MCP 调用。

### 桥接模式

每个 OpenClaw 工具都是对 Chorus MCP 工具的一层薄代理。模式非常统一：

```typescript
api.registerTool({
  name: "chorus_claim_task",
  description: "Claim an open Task (open -> assigned)",
  parameters: {
    type: "object",                    // OpenClaw 要求完整 JSON Schema
    properties: {
      taskUuid: { type: "string", description: "Task UUID" },
    },
    required: ["taskUuid"],
    additionalProperties: false,
  },
  async execute(_id: string, { taskUuid }: { taskUuid: string }) {
    // _id 是 OpenClaw 的 toolCallId，第二个参数才是实际参数
    const result = await mcpClient.callTool("chorus_claim_task", { taskUuid });
    return JSON.stringify(result, null, 2);
  },
});
```

两个 OpenClaw 特有的约定值得注意：

- **`parameters` 必须是完整的 JSON Schema**（`type: "object"` + `properties`），不能用简写 — 因为 OpenClaw 底层对接 Bedrock 等模型提供商，它们对 schema 格式有严格要求
- **`execute` 的第一个参数是 `toolCallId`**，不是工具参数 — 这是 OpenClaw 的 tool use 协议约定

### 40 个工具一览

| 类别 | 数量 | 典型工具 |
|------|------|---------|
| PM 工作流 | 15 | `chorus_claim_idea`, `chorus_create_proposal`, `chorus_pm_create_idea` |
| Developer 工作流 | 4 | `chorus_claim_task`, `chorus_report_work`, `chorus_submit_for_verify` |
| 通用查询 | 20 | `chorus_checkin`, `chorus_list_projects`, `chorus_search_mentionables` |
| Admin | 1 | `chorus_admin_create_project` |

---

## 七、踩坑记录

### 坑 1：npm scoped 包名 ≠ OpenClaw 插件 ID

这是最容易踩的坑。我们的 npm 包名是 `@chorus-aidlc/chorus-openclaw-plugin`（带 org scope），但 OpenClaw 的插件 ID **不能带 scope 前缀**。

三个地方的命名规则各不相同：

| 位置 | 值 | 说明 |
|------|---|------|
| `package.json` → `name` | `@chorus-aidlc/chorus-openclaw-plugin` | npm 包名，带 org scope |
| `openclaw.plugin.json` → `id` | `chorus-openclaw-plugin` | OpenClaw 插件 ID，**不带 scope** |
| `src/index.ts` → `id` | `chorus-openclaw-plugin` | 必须和 manifest 一致 |

用户配置 `openclaw.json` 时，`plugins.entries` 的 key 用的是插件 ID，不是 npm 包名：

```json
{
  "plugins": {
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": { ... }
      }
    }
  }
}
```

如果你用了 npm 包名（带 `@scope/`）作为 key，OpenClaw 会报 `plugin not found` 或 `plugin id mismatch`。

### 坑 2：hooks.token 必须和 gateway.auth.token 不同

OpenClaw 的 hooks 认证 token 和 gateway 认证 token 必须是不同的值。用相同的值会报错。

### 坑 3：配置字段可能是 undefined

OpenClaw 传递给插件的 config 可能不经过 Zod 解析。即使 Zod schema 有 `.default([])`，实际拿到的 `projectUuids` 可能是 `undefined`。

**修复**：所有配置字段用 `?? []`、`?? true`、`?? ""` 防御。

---

## 八、项目结构

```
packages/openclaw-plugin/
├── package.json              # @chorus-aidlc/chorus-openclaw-plugin
├── openclaw.plugin.json      # OpenClaw 插件 manifest (id: chorus-openclaw-plugin)
├── src/
│   ├── index.ts              # 插件入口 — 串联所有模块
│   ├── config.ts             # Zod 配置 schema
│   ├── mcp-client.ts         # MCP Client（懒连接 + 404 重连）
│   ├── sse-listener.ts       # SSE 长连接 + 指数退避重连
│   ├── event-router.ts       # 事件 → Agent 行动映射
│   ├── commands.ts           # /chorus 快捷命令
│   └── tools/
│       ├── pm-tools.ts       # 15 个 PM 工作流工具
│       ├── dev-tools.ts      # 4 个 Developer 工具
│       └── common-tools.ts   # 20 个通用查询 + 1 个 Admin 工具
└── images/
    └── slug.png
```

### 安装

```bash
openclaw plugins install @chorus-aidlc/chorus-openclaw-plugin
```

配置 `~/.openclaw/openclaw.json`：

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hooks-token"
  },
  "plugins": {
    "enabled": true,
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": {
          "chorusUrl": "https://chorus.example.com",
          "apiKey": "cho_your_api_key",
          "autoStart": true
        }
      }
    }
  }
}
```

---

## 写在最后

这个插件的核心理念可以用一句话总结：**让 Agent 成为工作流的一等公民，而不是一个被动的命令执行器**。

通过 SSE 实时感知事件、MCP 工具桥接操作、@mention 闭环通信，Agent 可以像一个真实的团队成员一样参与协作 — 接收分配、汇报进度、请求确认、响应反馈。

技术上回头看，最关键的发现是 **Chorus 已有的两套接口 — 给人类的 SSE 和给 Agent 的 MCP — 天然适配了"实时感知 + 工具操作"的插件模型**。不需要为插件专门开发 API，不需要改 Chorus 一行代码。当 Chorus 加一个新 MCP 工具时，插件加一行注册就能用。

如果你的平台也同时服务人类用户和 AI Agent，这种"事件推送 + 工具协议"的双通道架构值得考虑。

项目地址：
- **Chorus**: [github.com/Chorus-AIDLC/chorus](https://github.com/Chorus-AIDLC/chorus)
- **OpenClaw 插件**: [npm @chorus-aidlc/chorus-openclaw-plugin](https://www.npmjs.com/package/@chorus-aidlc/chorus-openclaw-plugin)
