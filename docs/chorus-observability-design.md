# Chorus 可观测性技术设计文档

## 1. 概述

Chorus 的可观测性系统采用三层采集架构，在不引入任何额外 Daemon 进程的前提下，自动追踪 Agent 的工具调用和 Token 消耗。Agent 完全无感知——所有采集通过已有的 MCP 拦截器和 Claude Code 插件 Hook 机制自动完成。

**核心设计原则：**
- 零 Daemon：不需要额外常驻进程，利用 CC 内置 Hook 机制
- Agent 无感：采集逻辑在框架层自动执行，不修改任何 Agent Prompt 或行为
- 精确归因：每次工具调用和 Token 消耗都能关联到具体的 Task / Proposal / Idea
- 异步不阻塞：所有采集操作异步执行，不增加工具调用延迟

```
┌─────────────────────────────────────────────────────────────┐
│                    Chorus 可观测性三层架构                     │
├─────────────┬─────────────────────┬─────────────────────────┤
│   Layer 1   │      Layer 2        │        Layer 3          │
│  服务端自动   │   客户端本地聚合      │     转录文件解析          │
│  (零改动)     │   (Hook 改动)        │    (SubagentStop)       │
├─────────────┼─────────────────────┼─────────────────────────┤
│ Chorus MCP  │ Bash/Read/Write 等  │ Token 精确用量           │
│ 工具调用     │ CC 内置工具调用       │ (input/output/cache)    │
│ 执行时长/错误 │ 输入/输出规模         │ 含 thinking/reasoning   │
│ 实体关联     │ Active Context 关联  │ 非工具调用的消耗          │
└─────────────┴─────────────────────┴─────────────────────────┘
```

**关键区分：** Layer 1 + 2 采集的是**工具级别的调用明细**（哪个工具被调用了、多少次、耗时多少）。Layer 3 采集的是**总 Token 消耗**，包括 thinking、reasoning、正常文本输出等不产生工具调用的 Token 消耗。两者互补——Layer 3 是消耗总量的 source of truth，Layer 1 + 2 提供调用粒度的明细。

---

## 2. 数据模型

### 2.1 ToolUsageEvent（工具调用事件）

每次工具调用产生一条记录，无论来源是服务端 MCP 还是客户端 Hook 上报。

```prisma
model ToolUsageEvent {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  agentUuid   String
  sessionUuid String?
  toolName    String                  // e.g. "chorus_claim_task", "Bash", "Read"
  source      String   @default("mcp") // "mcp" (Layer 1) | "client" (Layer 2)
  durationMs  Int                     // 执行耗时（Layer 1 精确；Layer 2 默认 0）
  inputSize   Int                     // JSON.stringify(params).length
  outputSize  Int                     // JSON.stringify(result).length
  isError     Boolean  @default(false)
  errorText   String?
  entityType  String?                 // "task" | "idea" | "proposal" | "document"
  entityUuid  String?
  projectUuid String?
  createdAt   DateTime @default(now())

  @@index([companyUuid, createdAt])
  @@index([agentUuid, createdAt])
  @@index([sessionUuid])
  @@index([entityType, entityUuid])
  @@index([projectUuid, createdAt])
}
```

### 2.2 AgentSession.tokenUsage（Session Token 用量）

在已有的 `AgentSession` 模型上新增 JSON 字段，存储从转录文件解析出的精确 Token 用量。

```prisma
model AgentSession {
  // ... 已有字段 ...
  tokenUsage  Json?  // { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
}
```

Token 用量是**累加式**更新——同一个 Session 可能收到多次上报（主 Agent + 多个 Sub-agent），服务端自动合并。

---

## 3. Layer 1：服务端 MCP Tool Logger 持久化

### 3.1 工作原理

`src/mcp/tools/tool-logger.ts` 已经通过猴子补丁 `server.registerTool` 拦截了所有 MCP 工具调用。在此基础上增加异步数据库写入。

### 3.2 数据流

```
Agent 调用 MCP 工具
  → tool-logger wrappedHandler 拦截
    → 执行原始 handler，计时
    → 构建 ToolUsageEvent 数据
    → detectResource() 提取实体关联（复用 presence.ts）
    → resolveProjectUuid() 从 DB 补全 projectUuid
    → fire-and-forget persistToolUsage() → Prisma 写入
  → 返回原始结果（不阻塞）
```

### 3.3 实体关联

复用 `src/mcp/tools/presence.ts` 的 `detectResource()` 函数，按优先级从参数提取实体 UUID：

1. `taskUuid` → entityType = "task"
2. `ideaUuid` → entityType = "idea"
3. `proposalUuid` → entityType = "proposal"
4. `documentUuid` → entityType = "document"
5. `targetUuid` + `targetType`（多态模式）

当参数中不包含 `projectUuid` 时，通过 `resolveProjectUuid()` 反查数据库（结果缓存在 Session 级 Map 中，避免重复查询）。

### 3.4 关键实现

```typescript
// src/mcp/tools/tool-logger.ts (简化)
async function persistToolUsage(p: PersistParams): Promise<void> {
  const resource = detectResource(p.params, p.toolName);
  let entityType = resource?.entityType ?? null;
  let entityUuid = resource?.entityUuid ?? null;
  let projectUuid = resource?.projectUuid ?? null;

  if (resource && !projectUuid) {
    projectUuid = await resolveProjectUuid(
      resource.entityType, resource.entityUuid, p.projectUuidCache
    );
  }

  await prisma.toolUsageEvent.create({
    data: {
      companyUuid: p.auth.companyUuid,
      agentUuid: p.auth.actorUuid,
      sessionUuid: extractSessionUuid(p.params),
      toolName: p.toolName,
      source: "mcp",
      durationMs: p.durationMs,
      inputSize: safeJsonSize(p.params),
      outputSize: safeJsonSize(p.result),
      isError: p.isError,
      errorText: p.errorText,
      entityType, entityUuid, projectUuid,
    },
  });
}
```

### 3.5 覆盖范围

- **覆盖：** 所有 60+ Chorus MCP 工具（chorus_claim_task, chorus_pm_create_proposal 等）
- **不覆盖：** CC 内置工具（Bash, Read, Write, Edit, Grep, Agent 等）

---

## 4. Layer 2：CC 插件 Hook 本地聚合 + 批量上报

### 4.1 工作原理

通过 Claude Code 的 `PostToolUse` hook（`async: true`）捕获所有工具调用（包括 CC 内置工具），先写本地 JSONL 文件，在 TeammateIdle 和 SubagentStop 时批量上报。

### 4.2 数据流

```
Claude Code 执行任意工具
  → PostToolUse hook 触发 on-post-tool-log.sh (async:true, 不阻塞)
    → 解析 stdin 中的事件 JSON
    → 如果是 Chorus MCP 工具，更新 Active Context (state.json)
    → 构建紧凑 JSONL 行，追加到 .chorus/tool-log.jsonl
  → Agent 继续工作（不受影响）

TeammateIdle / SubagentStop 触发
  → flush-tool-log 命令
    → 原子移动 tool-log.jsonl → tool-log.jsonl.pending.$$
    → jq -cs 聚合为 JSON 数组
    → POST /api/agent-report/tool-usage （Bearer API Key 认证）
    → 删除 pending 文件
```

### 4.3 Hook 注册

`public/chorus-plugin/hooks/hooks.json` 中注册通配符 matcher：

```json
{
  "type": "PostToolUse",
  "matcher": ".*",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/bin/on-post-tool-log.sh",
    "async": true
  }]
}
```

### 4.4 on-post-tool-log.sh

核心职责：
1. **解析事件**：从 stdin 读取 CC 提供的 JSON（tool_name, tool_input, tool_response, tool_use_id, agent_id）
2. **更新 Active Context**：对 `mcp__chorus__*` 工具，从 tool_input 提取实体 UUID，写入 `.chorus/state.json`
3. **写入 JSONL**：构建紧凑记录追加到 `.chorus/tool-log.jsonl`

JSONL 行格式：
```json
{
  "ts": "2026-04-19T12:00:00Z",
  "tool": "Bash",
  "id": "tool_use_xxx",
  "agent": "agent_id_or_null",
  "input_len": 42,
  "output_len": 1024,
  "is_error": false,
  "entity_type": "task",
  "entity_uuid": "abc-123"
}
```

性能：纯本地文件追加，无网络请求，< 5ms。支持 flock 并发写入保护（macOS 无 flock 时降级为直接追加）。

### 4.5 Active Context 追踪

解决 CC 内置工具（Bash/Read/Write）不携带 Chorus 实体信息的问题。

**原理：** Agent 的工作是聚焦式的——围绕一个实体持续工作，然后切换到下一个。MCP 调用自然标记了当前焦点：

```
chorus_pm_create_proposal({proposalUuid: "abc"})    ← context = proposal abc
Bash("npm test")                                     ← 继承 → proposal abc
Read("src/foo.ts")                                   ← 继承 → proposal abc
chorus_update_task({taskUuid: "xyz"})                ← context 切换到 task xyz
Bash("git commit")                                   ← 继承 → task xyz
```

`.chorus/state.json` 中维护的 Active Context 字段：
- `active_entity_type`：当前实体类型
- `active_entity_uuid`：当前实体 UUID
- `active_task_uuid` / `active_proposal_uuid` 等：按类型的快捷引用

### 4.6 flush-tool-log

`chorus-api.sh flush-tool-log [sessionUuid]` 命令：
1. 用 flock 获取锁，原子移动 JSONL 文件（避免上报期间新数据丢失）
2. 用 `jq -cs` 将 JSONL 聚合为 JSON 数组
3. POST 到 `/api/agent-report/tool-usage`
4. 清理 pending 文件

触发时机：
- `on-teammate-idle.sh`：每次 TeammateIdle 事件（Agent 空闲时，通常每几十秒到几分钟）
- `on-subagent-stop.sh`：Sub-agent 退出前最后一次 flush

---

## 5. Layer 3：SubagentStop 转录文件解析

### 5.1 工作原理

CC 的 `SubagentStop` hook 提供 `agent_transcript_path`——一个 JSONL 格式的完整对话转录文件。文件末尾的 `result` 类型消息包含精确的 Token 用量统计。

### 5.2 转录文件中的 Token 数据

CC 转录文件是 JSONL 格式，每行一条消息。assistant 类型的消息在 `.message.usage` 中携带该轮的 Token 用量：

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [...],
    "usage": {
      "input_tokens": 0,
      "output_tokens": 598,
      "cache_creation_input_tokens": 1223,
      "cache_read_input_tokens": 101609
    }
  }
}
```

**每个 assistant turn 有独立的 usage**，需要遍历所有 assistant 消息并累加。总和包含了整个 Session 的所有 Token 消耗——工具调用、thinking、reasoning、正常文本输出等。这是 Token 总量的唯一可靠来源。

### 5.3 实现

`on-subagent-stop.sh` 中的解析逻辑：

```bash
TRANSCRIPT_PATH=$(echo "$EVENT" | jq -r '.agent_transcript_path // empty')

if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  # Sum usage across ALL assistant messages (each turn has its own usage)
  USAGE_JSON=$(cat "$TRANSCRIPT_PATH" | jq -cs '
    [.[] | select(.type == "assistant") | .message.usage // empty] |
    {
      input_tokens: (map(.input_tokens // 0) | add // 0),
      output_tokens: (map(.output_tokens // 0) | add // 0),
      cache_creation_input_tokens: (map(.cache_creation_input_tokens // 0) | add // 0),
      cache_read_input_tokens: (map(.cache_read_input_tokens // 0) | add // 0)
    }
  ')

  if [ -n "$USAGE_JSON" ]; then
    curl -sS -X POST \
      -H "Authorization: Bearer ${CHORUS_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"sessionUuid\": \"$SESSION_UUID\", \"usage\": $USAGE_JSON}" \
      "${CHORUS_URL}/api/agent-report/token-usage"
  fi
fi
```

### 5.4 Token 累加合并

服务端 `session.service.ts` 的 `updateTokenUsage()` 是累加式的——读取现有值，逐字段相加后写回。这保证了同一 Session 多次上报（多个 Sub-agent 共享 Session）的数据不丢失。

```typescript
const merged: TokenUsage = {
  input_tokens: (existing.input_tokens ?? 0) + (usage.input_tokens ?? 0),
  output_tokens: (existing.output_tokens ?? 0) + (usage.output_tokens ?? 0),
  cache_creation_input_tokens: (existing.cache_creation_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: (existing.cache_read_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0),
};
```

---

## 6. API 设计

### 6.1 Agent 上报端点（Bearer API Key 认证，仅限 Agent 调用）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/agent-report/tool-usage` | Layer 2 批量上报客户端工具调用 |
| POST | `/api/agent-report/token-usage` | Layer 3 上报 Session Token 用量 |

**认证要求：** `auth.type === "agent"`。用户 Token 或 Super Admin 无法调用。

**POST /api/agent-report/tool-usage**

```typescript
// 请求体
{
  sessionUuid?: string,        // 可选，关联到 AgentSession
  events: Array<{
    tool: string,              // 工具名称（必填）
    id?: string,               // tool_use_id
    agent?: string,            // sub-agent ID
    ts?: string,               // ISO 时间戳
    input_len?: number,
    output_len?: number,
    entity_type?: string,      // Active Context 提供
    entity_uuid?: string,
    project_uuid?: string,
    is_error?: boolean,
    error_text?: string,
  }>
}
```

安全检查：
- sessionUuid 存在时，验证该 Session 属于当前 Agent（防止跨 Agent 写入）
- 单批次上限 500 条

**POST /api/agent-report/token-usage**

```typescript
// 请求体
{
  sessionUuid: string,          // 必填
  usage: {
    input_tokens?: number,
    output_tokens?: number,
    cache_creation_input_tokens?: number,
    cache_read_input_tokens?: number,
  }
}
```

同时接受 camelCase 和 snake_case 字段名（兼容不同来源）。

### 6.2 用户查询端点（用户 Session Cookie 认证）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/projects/[uuid]/observability` | Agent 观测仪表盘（按项目聚合） |
| GET | `/api/projects/[uuid]/observability/entity` | 单实体 Token + 工具明细 |
| GET | `/api/projects/[uuid]/observability/idea/[ideaUuid]` | Idea 全生命周期 Token 追踪 |

**GET /api/projects/[uuid]/observability?days=7|30|90**

返回项目级 Agent 观测数据：
```typescript
{
  projectUuid: string,
  dateRange: { days: number, from: string, to: string },
  agents: Array<{
    agentUuid: string,
    agentName: string,
    toolCallCount: number,
    toolErrorCount: number,
    totalInputSize: number,
    totalOutputSize: number,
    sessionTokens: TokenUsage,     // 聚合该 Agent 所有 Session 的 Token
    sessionCount: number,
    dailySeries: Array<{ date: string, toolCallCount: number }>,
    topTools: ToolBreakdownItem[], // 按调用次数排序的 Top 10 工具
  }>
}
```

**GET /api/projects/[uuid]/observability/entity?entityType=task&entityUuid=xxx**

返回单实体的工具调用明细 + Session Token：
```typescript
{
  entityType: string,
  entityUuid: string,
  toolCallCount: number,
  toolErrorCount: number,
  toolBreakdown: ToolBreakdownItem[], // 按工具分组统计
  sessionTokens: TokenUsage,          // 关联 Session 的 Token 总量
  sessionCount: number,
  // 如果 entityType === "proposal"，额外返回 drafting/review 拆分
  proposal?: {
    drafting: { toolCallCount, sessionTokens, toolBreakdown },
    review: { toolCallCount, totalInputSize, totalOutputSize },
  }
}
```

**GET /api/projects/[uuid]/observability/idea/[ideaUuid]**

返回 Idea 全生命周期（从 Elaboration 到 Verify）的 Token 追踪：
```typescript
{
  ideaUuid: string,
  totals: {
    toolCallCount: number,
    sessionTokens: TokenUsage,        // 所有阶段去重后的总 Token
  },
  phases: Array<{
    phase: "elaboration" | "proposal" | "review" | "execution" | "verify",
    toolCallCount: number,
    toolErrorCount: number,
    sessionTokens: TokenUsage,
    toolBreakdown: ToolBreakdownItem[],
  }>,
  tasks: Array<{
    taskUuid: string,
    title: string,
    status: string,
    toolCallCount: number,
    sessionTokens: TokenUsage,
  }>,
}
```

---

## 7. 实体关联策略

### 7.1 优先级链

```
1. MCP 参数直接提取（Layer 1）
   → detectResource() 从 taskUuid/proposalUuid/ideaUuid 等参数中读取
   → 准确率 100%

2. Active Context 追踪（Layer 2）
   → MCP 调用自动更新 state.json 中的 active_entity_type/uuid
   → 非 MCP 工具调用继承最近的 Context
   → 准确率 ~90%（聚焦工作时极高，快速切换时有偏差）

3. Session Task Checkin（Layer 3 Token 归属）
   → Sub-agent 的 Session 通过 SessionTaskCheckin 关联到 Task
   → 准确率 ~100%（Sub-agent 通常只做一个 Task）

4. 仅 Agent 级别
   → 以上都没有时，只记录 agentUuid
   → 用于无法归因的调用（如纯浏览操作）
```

### 7.2 生命周期阶段分类

`observability.service.ts` 中的 `classifyPhase()` 将工具名映射到生命周期阶段：

| 工具名模式 | 阶段 |
|------------|------|
| `*elaboration*` | elaboration |
| `chorus_admin_approve_proposal`, `*reject*`, `*close_proposal` | review |
| `chorus_admin_verify_task`, `*reopen_task`, `*submit_for_verify`, `*self_check` | verify |
| `*proposal*`, `*document_draft*`, `*task_draft*` | proposal |
| 无匹配 + entityType="idea" | elaboration（回退） |
| 无匹配 + entityType="proposal" | proposal（回退） |
| 无匹配 + entityType="task" | execution（回退） |

---

## 8. 前端架构

### 8.1 页面结构

可观测性数据通过三种 UI 形态呈现，与 Chorus 现有页面结构无缝集成：

| UI 位置 | 数据维度 | 接入方式 |
|---------|---------|---------|
| Idea Detail Panel → Tokens tab | Idea 全生命周期 Token | 新增 tab 到现有 TabId 联合类型 |
| Task Detail Panel → Tokens tab | 单 Task Token + 工具明细 | 新增 tab |
| Proposal Detail Page → sidebar Card | Proposal drafting/review Token | 新增 sidebar Card |
| `/projects/[uuid]/observability` | Agent 级仪表盘 | 新增独立页面 |

### 8.2 Idea Tokens Tab

集成到 `idea-detail-panel.tsx` 的 Tab 系统：

```typescript
type TabId = "overview" | "elaboration" | "proposal" | "tasks" | "tokens" | "activity";
```

`tokens` tab 始终可见（即使没有数据也显示空状态）。使用 `useIdeaLifecycleTokens` hook 获取数据，展示：

- **汇总卡片**：Total Tokens (input+output+cache 总和)，Cache Read，Tool Calls
- **生命周期拆分**：按 elaboration → proposal → review → execution → verify 分阶段展示
- **Task 列表**：每个 Task 的 Token 消耗和调用次数，可点击展开 Task Detail

### 8.3 Agent Observability 仪表盘

独立页面 `/projects/[uuid]/observability`，与 sidebar 导航中的 Activity 平级。

- **汇总卡片**：Total Tokens, Tool Calls, Cache Read, Error Rate
- **时间范围切换**：7d / 30d / 90d
- **Agent 列表**：左侧列出所有 Agent，点击右侧展示详情
- **Daily Token Chart**：CSS 纯实现的堆叠柱状图（Input/Output 分色），无第三方图表库
- **Tool Usage Table**：按工具名分组，展示 Calls / Tokens / Avg ms / Errors

### 8.4 数据获取

使用轻量 React hooks（`useState` + `fetch`），不依赖 React Query：

```typescript
// src/hooks/use-observability.ts
useIdeaLifecycleTokens(projectUuid, ideaUuid)  // → IdeaLifecycleResult
useEntityTokens(projectUuid, entityType, entityUuid)  // → EntityTokensResult
```

Agent Dashboard 页面使用 `useState` + `useEffect` 直接 fetch，支持 Agent 选择和时间范围切换。

### 8.5 Token 格式化

`src/lib/format-tokens.ts` 提供统一的 Token 显示格式：
- < 1000: 原值 ("420")
- 1K-999K: 保留一位小数 ("3.8K")
- ≥ 1M: 保留一位小数 ("1.2M")

---

## 9. 三层对比

| 维度 | Layer 1（服务端 MCP） | Layer 2（CC Hook 聚合） | Layer 3（转录解析） |
|------|---------------------|----------------------|-------------------|
| 采集目标 | Chorus MCP 工具（60+） | CC 所有工具（Bash/Read/Write 等） | Session 级 Token 总量 |
| 触发方式 | 自动（registerTool 拦截） | 自动（PostToolUse hook async:true） | 自动（SubagentStop hook） |
| Agent 感知 | 完全无感 | 完全无感 | 完全无感 |
| 网络延迟 | 异步写 DB（~1ms） | 零（本地文件追加） | 结束时一次 HTTP 请求 |
| 实体关联 | 精确（参数直接提取） | Active Context 推断（~90%） | Session → Task Checkin |
| Token 数据 | 无（只有 I/O size） | 无（只有 I/O size） | 精确（input/output/cache） |
| 数据延迟 | 实时 | 准实时（TeammateIdle 周期） | Session 结束时 |
| 依赖 | Prisma + PostgreSQL | jq + Bash 3.2 | jq + CC 转录文件格式 |

---

## 10. 文件清单

### 后端

| 文件 | 职责 |
|------|------|
| `prisma/schema.prisma` | ToolUsageEvent 模型 + AgentSession.tokenUsage 字段 |
| `src/mcp/tools/tool-logger.ts` | Layer 1：MCP 工具调用拦截 + 异步持久化 |
| `src/mcp/tools/presence.ts` | detectResource() + resolveProjectUuid() 实体关联 |
| `src/services/observability.service.ts` | 聚合查询服务（实体/生命周期/Agent 维度） |
| `src/services/session.service.ts` | updateTokenUsage() Token 累加合并 |
| `src/app/api/agent-report/tool-usage/route.ts` | Layer 2 批量上报端点 |
| `src/app/api/agent-report/token-usage/route.ts` | Layer 3 Token 上报端点 |
| `src/app/api/projects/[uuid]/observability/route.ts` | Agent 仪表盘查询 |
| `src/app/api/projects/[uuid]/observability/entity/route.ts` | 单实体查询 |
| `src/app/api/projects/[uuid]/observability/idea/[ideaUuid]/route.ts` | Idea 生命周期查询 |

### CC 插件

| 文件 | 职责 |
|------|------|
| `public/chorus-plugin/hooks/hooks.json` | PostToolUse ".*" matcher 注册 |
| `public/chorus-plugin/bin/on-post-tool-log.sh` | Layer 2：本地 JSONL 采集 + Active Context |
| `public/chorus-plugin/bin/chorus-api.sh` | flush-tool-log 命令：原子移动 + 批量上传 |
| `public/chorus-plugin/bin/on-teammate-idle.sh` | TeammateIdle 时触发 flush |
| `public/chorus-plugin/bin/on-subagent-stop.sh` | SubagentStop 时 flush + Layer 3 转录解析 |

### 前端

| 文件 | 职责 |
|------|------|
| `src/app/(dashboard)/projects/[uuid]/observability/page.tsx` | Agent 仪表盘入口（Server Component） |
| `src/app/(dashboard)/projects/[uuid]/observability/agent-observability.tsx` | 仪表盘主体 |
| `src/app/(dashboard)/projects/[uuid]/observability/daily-token-chart.tsx` | 日 Token 柱状图 |
| `src/app/(dashboard)/projects/[uuid]/observability/tool-usage-table.tsx` | 工具调用明细表 |
| `src/app/(dashboard)/projects/[uuid]/dashboard/panels/tokens-view.tsx` | Idea Tokens Tab |
| `src/app/(dashboard)/projects/[uuid]/tasks/task-tokens-view.tsx` | Task Tokens Tab |
| `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/token-usage-card.tsx` | Proposal Token Card |
| `src/hooks/use-observability.ts` | React hooks for data fetching |
| `src/lib/format-tokens.ts` | Token 数量格式化工具 |

### 测试

| 文件 | 覆盖 |
|------|------|
| `src/mcp/__tests__/tool-logger.test.ts` | Layer 1 持久化逻辑（19 tests） |
| `src/services/__tests__/observability.service.test.ts` | 聚合查询服务（25 tests） |

---

## 11. 安全考虑

1. **多租户隔离**：所有查询都以 `companyUuid` 为前提条件，不存在跨公司数据泄露
2. **Agent 上报端点隔离**：`/api/agent-report/*` 强制 `auth.type === "agent"`，用户 Token 无法调用
3. **Session 归属验证**：上报 Tool Usage 和 Token Usage 时，验证 sessionUuid 属于当前 Agent
4. **批次大小限制**：单次上报上限 500 条事件，防止恶意大量写入
5. **参数截断**：tool-logger 在日志中截断超过 500 字符的参数值，防止敏感数据泄露

---

## 12. 已知限制与未来改进

### 当前限制

1. **Layer 1/2 的 inputSize/outputSize 是 JSON 字节长度，不是 Token 数**：`JSON.stringify(params).length` 和 LLM token 完全不等价——不包含 thinking/reasoning 消耗，不包含系统 prompt 和对话历史的上下文 token，且字节数 ≠ token 数（1 token ≈ 4 bytes 英文，中文差异更大）。当前 I/O size 只能用于工具间的**相对比例对比**，绝对值没有意义。在没有 Layer 3 数据时，前端不应将 I/O size 显示为 "tokens"。
2. **Layer 2 无 durationMs**：CC PostToolUse hook 不提供工具执行耗时，客户端上报事件的 durationMs 默认为 0
3. **主 Agent Token 无法自动采集**：SubagentStop 只能获取 Sub-agent 的转录。主 Agent 的 Token 用量需要手动触发或等待 CC 支持 SessionEnd hook
4. **实时性**：Layer 2 是准实时（依赖 TeammateIdle 周期），不是逐条实时推送
5. **Active Context 切换误差**：快速切换多个实体时，切换瞬间的几条调用可能归属到前一个实体

### 未来改进：用 Tokenizer 计算工具调用的实际 Token 数

当前 Layer 1/2 记录的 `inputSize`/`outputSize` 是 JSON 字节长度，无法作为 token 数展示。解决方案是在服务端引入轻量级 tokenizer，对工具参数和返回值进行真实 token 计数。

**候选 Tokenizer 库（纯 JS/WASM，跨平台）：**

| 包 | 大小 | 类型 | 周下载量 | 说明 |
|----|------|------|---------|------|
| **js-tiktoken** | 11 MB | 纯 JS | 430 万 | 推荐。零原生依赖，支持 cl100k_base（Claude 近似编码） |
| **gpt-tokenizer** | 55 MB | 纯 JS | 55 万 | 支持 o200k_base 等新编码，体积较大 |
| **tiktoken** | 5.4 MB WASM | WASM | 97 万 | 性能最好，但依赖 WASM runtime |
| **@anthropic-ai/tokenizer** | 1.4 MB | tiktoken 封装 | 极少 | Anthropic 官方但功能薄 |

所有候选都满足跨平台要求（linux-x64/arm64, darwin-x64/arm64, Windows）。Claude 使用类似 `cl100k_base` 的编码，`js-tiktoken` 是最佳选择——纯 JS、零原生依赖、成熟稳定。

**集成方案（待实现）：**
- 在 `tool-logger.ts` 的 `persistToolUsage` 中，用 tokenizer 计算 params/result 的 token 数，写入新字段 `inputTokens`/`outputTokens`（替代当前的字节长度 `inputSize`/`outputSize`，或新增字段并行存储）
- 需评估性能影响：每次 MCP 工具调用都跑 tokenizer 编码，可能增加 CPU 开销

### 其他未来改进方向

1. **实时 WebSocket 推送**：PostToolUse hook 中改用 WebSocket 直连，实现逐条实时展示
2. **Token 消耗归因到实体**：将 Session Token 按工具调用的 token 数比例分摊到各实体
3. **成本估算**：基于模型定价计算各维度的 USD 成本
4. **告警阈值**：当单个 Task 或 Agent 的 Token 消耗超过阈值时自动通知
