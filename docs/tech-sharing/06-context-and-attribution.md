# 上下文与归因：多 Agent 的第一性成本不是数量

## Context and Attribution: The First-Order Cost of Multi-Agent Systems

> 本文源码基线：`docs/tech-sharing` 分支，2026-08-16。源码位置以符号名为准，行号用于帮助定位。

## 摘要

多 Agent 系统最显眼的变量是 Agent 数量，但数量不是第一性成本。真正改变系统形态的是两件事：工作上下文被拆到彼此隔离的窗口中，以及每份结果、业务动作与 token 消耗必须重新归因到正确的 worker、task 和 execution。隔离让 worker 获得干净上下文并并行探索，也让中间事实、失败原因和成本不再天然存在于主对话中。本文以 Chorus 为案例，研究控制平面如何承接这项代价：runtime 仍由 Claude Code Agent Teams、Codex `spawn_agent`、Pi `subagent_spawn` 等原语创建和管理 worker；Chorus 不充当 swarm scheduler，而以 `AgentSession`、`SessionTaskCheckin`、Activity session fields、per-turn usage 和 DaemonSession rollup 保存它能够看见的 attribution。本文同时限定可观测性边界：AgentSession 与 DaemonSession 仍是两类 identity，没有统一 correlation model；不同 runtime 对 worker start、heartbeat 与 close 的自动化程度不同；token 采集能够回答“记录到多少”，不能凭自身证明 multi-agent 比 single-agent 更省或更贵。LangChain 在特定 multi-domain scenario 中报告的 67% token 降幅，以及 Anthropic 在 BrowseComp 分析中报告的 token usage 单独解释 80% 性能方差与 multi-agent 约消耗 chat 15 倍 token，均是带实验条件的外部观测，不是 Chorus benchmark。

## Abstract

Agent count is the most visible variable in a multi-agent system, but it is not the first-order cost. The architecture changes because work context is split across isolated windows and because every result, business mutation, and token must be attributed back to the correct worker, task, and execution. Isolation gives workers clean contexts and parallel exploration, while removing intermediate facts, failures, and costs from the main conversation. This paper studies how Chorus bears that cost as a control plane. Runtime primitives such as Claude Code Agent Teams, Codex `spawn_agent`, and Pi `subagent_spawn` still create and manage workers. Chorus is not a swarm scheduler; it is a system of record for the attribution it can observe through `AgentSession`, `SessionTaskCheckin`, Activity session fields, per-turn usage, and DaemonSession rollups. We also bound observability claims. AgentSession and DaemonSession remain distinct identities without a unified correlation model. Runtime integrations differ in how automatically they observe worker start, heartbeat, and close. Token capture answers “how much was recorded,” but does not by itself prove that multi-agent execution is cheaper or more expensive than single-agent execution. LangChain's reported 67% reduction in a specific multi-domain scenario, and Anthropic's BrowseComp finding that token usage alone explained 80% of performance variance alongside a roughly 15-times-chat multi-agent cost, are conditioned external observations rather than Chorus benchmarks.

---

## 1. 问题：为什么 “N 个 Agent” 不是成本模型

### 1.1 数量只描述拓扑，不描述信息流

“一个 lead Agent 带三个 worker”描述了拓扑，却没有回答：

1. 每个 worker 启动时得到哪些上下文；
2. 它看不到哪些主会话历史；
3. 中间 tool output 留在哪个窗口；
4. worker 如何把结果压缩回主 Agent；
5. 两个 worker 修改同一业务对象时如何区分责任；
6. 某段 token usage 属于哪个 turn、backend 或 session；
7. worker 崩溃、失联或未正常 close 后，系统还能知道什么。

单 Agent 中，这些问题常被同一个 conversation history 隐式吸收。拆成多个 Agent 后，history 不再共享，identity 也不再唯一。新增一个 worker 的主要成本不是数据库多一行，而是新增一个需要明确输入、输出、lifecycle 和 attribution 的信息边界。

### 1.2 第一性成本：context isolation + attribution

本文把多 Agent 的第一性成本写成：

```text
multi-agent cost
  = isolated context construction
  + handoff compression and stitching
  + worker/task/action attribution
  + lifecycle visibility
  + amplified model/tool execution
```

Agent 数量会放大这些项，但不能替代它们。两个共享完整历史且串行工作的 Agent，可能比一个精心隔离的 worker 更拥挤；十个只返回短结论的 researcher，可能让 lead context 更干净，却在系统总 token 上更贵。

### 1.3 Chorus 的位置：system of record，不是 scheduler

Chorus 的 session tools 创建、查询、heartbeat、check in、check out、close 与 reopen 归因记录；它们不生成 OS process，也不调用模型。`registerSessionTools` 注册的八个工具都只操作 session service（`src/mcp/tools/session.ts:18-260`）。

真正的 worker orchestration 留在 runtime：

- Claude Code 通过 Agent Teams/Task 与 Subagent lifecycle hooks 暴露 worker 事件；
- Codex 主 Agent 通过 `spawn_agent` 启动 worker；
- Pi 通过 `subagent_spawn` / `subagent_manage` 启动和关闭 worker。

Chorus 因此是“谁在做什么、记录了什么”的 control-plane system of record，不是决定何时 spawn、如何分配 inference 或如何调度并发的 swarm scheduler。第 2 篇已经分析这些 runtime adaptation；本文只研究它们向 attribution 层暴露了多少事实，不展开第 7 篇的跨厂商 federation。

---

## 2. 隔离为什么有效，也为什么昂贵

### 2.1 干净上下文不是免费副本

LangChain 将 subagent pattern 描述为：每次调用在干净 context window 中工作，主 Agent 只接收简洁结果，从而避免把大量中间 tool calls 塞入主 conversation [1]。Anthropic 也把 sub-agent architecture 描述为 focused worker 在独立窗口中进行深度工作，再返回约 1,000–2,000 token 的压缩摘要 [2]。

这种结构提供三种直接收益：

| 收益 | 机制 |
|---|---|
| 降低主上下文污染 | 大量 search/read/tool output 留在 worker window |
| 减少路径依赖 | worker 可从同一任务的不同假设独立探索 |
| 获取并行性 | 无依赖的子问题可以同时执行 |

但 isolated context 不是主上下文的零成本副本。worker 仍需要 system prompt、tools、task brief、必要文件与约束；如果 brief 过少，worker 会重复发现背景；如果 brief 过多，隔离只是复制。

### 2.2 “主线程更省”不等于“系统总量更省”

Context isolation 至少有三个不同分母：

1. lead Agent 每次 inference 看到的 context；
2. 所有 Agent 累计处理的 input/output tokens；
3. 完成一项任务的 wall-clock、tool calls 与失败重试。

隔离可以显著降低第 1 项，同时增加第 2 项。把两者都叫“token saving”会制造错误结论。

LangChain 的 pattern comparison 在一个 multi-domain 示例中给出 subagents 约 9K tokens、skills 约 15K tokens，并在说明中写 subagents 因 context isolation “processes 67% fewer tokens overall” [3]。若把表中的近似值直接相除，9K 相对 15K 是约 40% 降幅，与正文的 67% 并不算术一致；本文因此只把 67% 作为原文报告值引用，不用近似表格反推新结论。这是其特定 multi-domain query、每个 language agent 约 2,000 tokens 文档、三种语言并行比较与既定 call pattern 下的外部结果，不是普遍定律，也不是 Chorus 复现实验。

Anthropic 对 BrowseComp browsing-agent evaluation 的分析报告：token usage、tool-call 数与 model choice 三个因素合计解释 95% 的 performance variance，其中 token usage 单独解释 80% [4]。这是相关性分析，不是“多花 token 必然得到同等收益”的因果定律；它支持的是在该 hard-to-find information benchmark 上，token budget 与 performance 高度相关。同一篇文章还报告 agent 通常约为 chat interaction 的 4 倍 token，多 Agent 系统约为 chat 的 15 倍。多 Agent 的价值恰恰来自分配更多独立 context capacity；高 token 消耗是收益机制的一部分，而不是实现偶然泄漏。

两组数字并不矛盾：一个比较多 Agent patterns 之间如何避免重复处理 context，另一个比较 agentic/multi-agent execution 与普通 chat。它们测量的 baseline、task 和系统边界不同。

### 2.3 对称成本表

| 隔离收益 | 对应成本 |
|---|---|
| 每个 worker 获得 focused、clean context | task brief、policy 和必要状态必须重复注入 |
| 中间 tool output 不污染 lead | 关键证据可能只存在于 worker，必须压缩或持久化 |
| 独立探索减少单一路径依赖 | 重复搜索、重复读文件与冲突结论增加 |
| 无依赖任务并行 | dependency、merge、conflict 和 cancellation 需要协调 |
| worker 可使用专门模型/工具 | usage、权限和失败必须按 backend/worker 解释 |
| lead 只接收摘要 | 摘要会丢细节，后续 cross-session stitching 可能再读原始证据 |

因此，正确问题不是“多 Agent 是否省 token”，而是“任务是否可并行、隔离后哪些 context 可以不重复、handoff 丢失什么，以及额外总成本是否换来足够价值”。

---

## 3. Attribution schema：把 worker 从名字变成记录

### 3.1 AgentSession 保存 worker identity

`AgentSession` 是面向 swarm/worker observability 的记录：

```text
AgentSession
  uuid
  companyUuid
  agentUuid
  name
  description?
  status: active | closed
  lastActiveAt
  createdAt / updatedAt
```

它记录所属 Agent principal、可读名称、状态和最后活跃时间；`SessionTaskCheckin` 以 `(sessionUuid, taskUuid)` 唯一约束把 session 与 Task 关联，并保存 check-in / checkout timestamps（`prisma/schema.prisma:438-473`）。

这里有意把 principal 与 worker session 分开：多个 worker 可以使用同一个 Agent credential，却以不同 session 名称和 UUID 承担不同任务。否则 Activity 只能回答“哪个 API key 做了动作”，无法回答“该 key 下哪个 worker context 做了动作”。

### 3.2 Check-in 是 many-to-many attribution，不是调度锁

`sessionCheckinToTask` 验证 active session 与 tenant-scoped Task，必要时尝试为 session 的 Agent auto-claim 未分配 Task，再 upsert check-in；checkout 写 `checkoutAt`；close 会批量 checkout 所有 active check-ins（`src/services/session.service.ts:210-336`）。

这个 relation 表示“session 参与这项工作”，不保证：

- 一个 Task 同时只能有一个 worker；
- check-in 持有文件或数据库锁；
- runtime 一定还活着；
- worker 只处理已 check-in 的 Task；
- check-in 自动把所有后续 Activity 归给该 session。

它是 attribution edge，不是 scheduler lease 或 distributed lock。

### 3.3 Freshness 是视图语义，不是持久状态机

Session status 只有 `active | closed`。当前实现用 `lastActiveAt` 的一小时阈值计算 freshness：UI 和 task worker-count 查询隐藏 stale active sessions，而 MCP audit list/get 不隐藏历史 active rows（`src/services/session.service.ts:46-56,128-208,338-368`）。

这一区分很重要：

- audit read 保留“曾创建但没有正常关闭”的证据；
- operational UI 避免把长期无 heartbeat 的 row 当成当前 worker；
- stale 并不会自动把数据库 status 改成 `closed`。

因此“UI 显示 0 个 active worker”不证明 runtime 从未启动过；“audit list 中 status=active”也不证明进程此刻仍在线。

### 3.4 Ownership gate 限制 session 操作

Session MCP tools 对 get、close、reopen、check-in、checkout 和 heartbeat 检查 `session.agentUuid === auth.actorUuid`。创建时则直接绑定当前 actor（`src/mcp/tools/session.ts:67-259`）。

这避免一个 Agent credential 修改另一个 Agent 的 worker session，却没有把 session 变成防伪 execution identity。Runtime 仍负责把正确 UUID 注入正确 worker；若 integration 丢失 mapping，worker 可以继续执行，而 Chorus 只会失去该段 attribution。

---

## 4. 从 session 到业务动作：Activity attribution

### 4.1 Denormalized fields 是查询锚点

Activity 除 project、target、actor、action 与 value 外，还保存可选：

```text
sessionUuid String?
sessionName String?
```

这两个字段被 denormalize 到 Activity，避免展示历史时依赖 session join，也让 session 名称后来变化或 session row 生命周期变化时保留动作发生时的标签（`prisma/schema.prisma:411-435`）。

`chorus_report_work` 接受可选 `sessionUuid`。若 session 存在且属于当前 Agent，它读取名称并 heartbeat；随后 Comment 保存 report，Activity 保存 `sessionUuid/sessionName`（`src/mcp/tools/developer.ts:249-320`）。`chorus_update_task` 对 task mutation 采用相同归因路径（`src/mcp/tools/public.ts:1218-1394`）。

### 4.2 Attribution 是 optional propagation

这里的诚实边界在 optional：

1. caller 不传 `sessionUuid`，Activity 仍可合法创建；
2. runtime 没有把 session UUID 注入 worker，业务动作只归到 Agent principal；
3. session 无效或不属于 caller 时，当前 handler 不解析 `sessionName`，但仍可能把 caller 提供的 `sessionUuid` 写入 Activity；
4. 并非每个 mutation tool 都自动推导当前 session；
5. Activity 不含通用 parent span、trace ID 或 causal edge。

所以 Activity session fields 提供可查询 attribution，却不是 end-to-end distributed tracing。它们能支持“这份 work report 声称来自哪个 worker session”，不能证明该 session 中每次模型调用与 tool side effect 的完整因果链。

### 4.3 一个最小可归因流程

```text
runtime spawns worker
  -> create/reuse AgentSession S
  -> inject S.uuid into worker context

worker selects Task T
  -> session_checkin_task(S, T)
  -> perform local work
  -> report_work(T, report, sessionUuid=S)

Chorus persists
  -> SessionTaskCheckin(S, T)
  -> Comment(report, actor=Agent)
  -> Activity(T, comment_added, actor=Agent, session=S)

runtime closes worker
  -> checkout T
  -> close S
```

这条链把 runtime lifecycle、Task participation 与业务输出连接起来。任一箭头失败时，其他对象可能仍然存在：例如 report 已保存但 close hook 失败，或 worker 已运行但 create-session 网络请求失败。System of record 必须允许部分事实，而不能用完整 trace 的假象覆盖缺口。

---

## 5. Token attribution：采集能力不等于 benchmark

### 5.1 一套 normalized usage contract

Daemon upload path 将不同 backend 的结束事件规范化为：

```text
TokenUsage {
  inputTokens?
  outputTokens?
  cacheCreationTokens?
  cacheReadTokens?
  model?
  source
}
```

Claude Code 从 `type:"result"` 的 authoritative whole-turn `usage` 读取，不累加 per-message usage；Codex 从 `turn.completed.usage` 读取，并将 backend 标为 `codex`（`cli/upload-hooks.mjs:211-364`）。每次 wake 开始会清空上一 turn 的 usage，结束时与 transcript relay 结果一起返回（同文件 `630-713`）。

Nullable fields 与 `source` 很关键：backend 能力不同，缺失值应保持未知，不能填零后假装可比。

### 5.2 Per-turn evidence 与 per-session rollup

`DaemonSessionTurn.usage` 将整个 normalized object 保存为 JSON；`DaemonSession` 以 scalar counters 保存 input、output、cache-read 和 cache-creation totals（`prisma/schema.prisma:687-699,736-742`）。

`advanceTurn` 只在 `ended` / `interrupted` terminal edge 接受 usage，并在同一个 transaction 中：

1. 写 turn usage；
2. 用 database-side atomic increment 更新 session totals。

这样不会出现 turn 已有 usage 而 rollup 未包含它，或 rollup 增长但 turn evidence 缺失的 torn state（`src/services/daemon-session.service.ts:646-742`）。

### 5.3 AgentSession 与 DaemonSession 不是同一条轴

第 5 篇已经区分：

- `AgentSession`：worker/check-in attribution；
- `DaemonSession`：headless conversation、wake turn 与 transcript/usage。

当前 schema 没有一等关系把每个 AgentSession 连接到唯一 DaemonSessionTurn。Activity 的 `sessionUuid` 最初面向 AgentSession，DaemonSession usage 则跟随 runtime conversation identity。本文引用这一边界，不反向声称已存在统一 trace 或自动的 per-worker cost ledger。

今天可以可靠回答：

- 某个 daemon turn 报告了多少 normalized usage；
- 一个 DaemonSession 已记录 turns 的累计 usage；
- 某条显式携带 session UUID 的 Activity 归到哪个 AgentSession。

今天不能仅靠这些表可靠回答：

- worker S 的所有模型调用总成本；
- Task T 在所有 AgentSession 与 DaemonSession 上的完整 token 总量；
- multi-agent 版本相对 single-agent baseline 节省多少；
- 未上报、被中断或 backend 不提供字段的 usage 应如何估算。

因此 Chorus 当前只提供 per-daemon-turn evidence 与 DaemonSession rollup，本文不承诺完整 per-idea 成本核算。

### 5.4 Chorus 没有 controlled benchmark

Chorus 当前实现是 instrumentation，不是 experiment design。要声称“隔离节省 X%”或“多 Agent 贵 Y 倍”，至少需要固定：

- 相同 task corpus 与 success criteria；
- 相同模型、版本、tools 和 prompt policy；
- single/multi-agent 两套明确 treatment；
- retries、cache、parallel calls 与失败运行的计入规则；
- input/output/cache token 的统一 accounting；
- quality、latency 和 task value，而不只 token。

仓库没有这套 controlled multi-agent-vs-single benchmark。因此本文的 LangChain 67%、Anthropic BrowseComp 80% variance 与 15× chat token 只说明外部系统中三种可能同时成立的现象：局部 context processing 可以下降，更多 token capacity 可与 benchmark performance 高度相关，而系统总 token 仍可能显著上升。

---

## 6. Runtime lifecycle：control plane 只能归因看得见的部分

### 6.1 Claude Code：hook-rich 自动 lifecycle

Claude integration 在 `SubagentStart`：

1. 从 pre-spawn pending metadata 识别 worker；
2. 按名称 reuse/reopen/create AgentSession；
3. 保存 runtime agent ID 到 session UUID mapping；
4. 通过 `additionalContext` 注入 session UUID 与 workflow。

实现位于 `public/chorus-plugin/bin/on-subagent-start.sh:48-218`。`TeammateIdle` 根据名称 mapping 发送 heartbeat（`on-teammate-idle.sh:28-52`）；`SubagentStop` checkout active tasks、close session 并清理 local mapping（`on-subagent-stop.sh:40-104`）。

这是较完整的 lifecycle observation，但仍是 fail-soft hooks。缺少环境变量、API 失败、pending mapping 未命中或 shell 提前退出时，Claude worker 可以运行而 Chorus session 不完整。

### 6.2 Pi：pre-spawn mutable input

Pi extension 在 `subagent_spawn` 的 pre-execution `tool_call`：

1. 正向识别普通 worker，跳过 read-only reviewers；
2. 先创建 Chorus session；
3. 将 UUID 追加到即将传给 worker 的 task；
4. spawn result 返回后建立 `agentId -> sessionUuid` mapping；
5. `subagent_manage close` 时关闭对应 session。

关键路径位于 `packages/chorus-pi/extensions/chorus.ts:291-360`。因为 event input 可变，session identity 能在 worker 第一次 inference 前进入上下文。创建失败时实现明确允许 worker 在无 observability 的情况下继续。

### 6.3 Codex：显式 spawn，session 手工传播

Codex develop skill 由主 Agent 调用 `spawn_agent` 编排 worker（`plugins/chorus/skills/develop/SKILL.md:246-294`）。当前 Codex port 没有与 Claude `SubagentStart/Stop` 等价的 lifecycle event，也没有 Pi 的 pre-spawn mutable channel；因此普通 worker 的 AgentSession 创建、UUID 传递与关闭依赖 workflow 手工执行（`packages/chorus-pi/README.md:46-51,73-77`）。

这不是 Chorus semantic kernel 的差异，而是 host visibility 的差异：

| Runtime | Spawn primitive | Session start/identity | Heartbeat | Close |
|---|---|---|---|---|
| Claude Code | Agent Teams / Task | hooks 自动 create/reuse + inject | TeammateIdle hook | SubagentStop hook |
| Pi | `subagent_spawn` | pre-tool event 自动 create + mutate task | extension/runtime path | `subagent_manage close` |
| Codex | `spawn_agent` | workflow 手工 create/pass | worker 手工 | worker/main 手工 |

因此 dashboard 中 session 数量不能直接用来比较 runtime 实际 spawned worker 数量。它测量的是成功进入 Chorus attribution path 的 worker。

---

## 7. Worked Example、诚实边界与演进

### 7.1 并行研究的收益与 stitching bill

假设 lead Agent 要评估三个互不依赖的 migration 方案：

```text
lead
  -> worker A: schema compatibility
  -> worker B: runtime lifecycle impact
  -> worker C: token/latency evidence
```

#### 7.1.1 隔离后的理想路径

每个 worker 只收到共享 acceptance criteria 和自己的研究问题。A 不加载 token benchmark，C 不加载所有 migration code。三者分别 check in 到同一个 Task，report work 时携带各自 AgentSession UUID。Lead 最后读取三份 report 进行 synthesis。

收益是：

- 三个大规模 read/search history 不进入 lead conversation；
- 相互独立的假设可并行；
- Activity 能区分 A/B/C 的报告来源；
- 某个 worker 失败不抹掉其他 worker 已持久化的报告。

#### 7.1.2 真实成本不会消失

Lead 仍要支付：

1. 把共同 invariants 写入三个 brief；
2. 处理 A 与 B 对同一 schema 行的冲突解释；
3. 检查 C 引用的数字是否与 Chorus 自身数据混淆；
4. 重新打开关键 source，而不是盲信摘要；
5. 识别某个 session 没有 close 是 hook gap 还是 worker 仍运行；
6. 将 DaemonSession usage 与 AgentSession report 人工对齐，因为当前无统一 correlation。

若三个子问题高度耦合，lead 反复把一个 worker 的发现转发给另一个，context isolation 会退化为 expensive message passing。Anthropic 也明确指出需要共享同一上下文或依赖密集的任务不适合当前 multi-agent architecture [4]。

#### 7.1.3 最低交付契约

一个可审计 worker 不应只返回“done”，而应至少留下：

```text
identity: AgentSession UUID and readable name
scope: Task check-in and explicit subproblem
evidence: files/lines, tests, external references
result: concise report with uncertainty
usage: runtime turn usage when available
lifecycle: heartbeat/close or an explicit visibility gap
```

这套契约不会让结果自动正确，但能让 lead 判断应该信什么、复查什么，以及 attribution 在哪一段断开。

---

### 7.2 诚实边界：当前系统不保证什么

#### 7.2.1 已实现

1. AgentSession identity、active/closed status、heartbeat 与 audit-visible stale rows；
2. SessionTaskCheckin 对 worker participation 的 many-to-many 记录；
3. 部分 Task mutation/report 的 optional Activity session attribution；
4. Claude/Codex daemon turns 的 normalized per-turn token usage；
5. DaemonSession 级 input/output/cache token atomic rollup；
6. Claude 与 Pi 较自动、Codex 较手工的 worker session lifecycle adaptation。

#### 7.2.2 不可由当前实现推出

1. Chorus 创建、调度或取消了 runtime worker；
2. 所有实际 worker 都有 AgentSession；
3. active AgentSession 等于 live process；
4. 每个业务 mutation 都携带正确 session UUID；
5. AgentSession、Activity、DaemonSessionTurn 已组成统一 distributed trace；
6. session rollup 是 Task、Idea 或 worker 的完整 cost；
7. 缺失 usage 等于零 usage；
8. context isolation 在 Chorus 中已验证节省 67%；
9. Chorus 数据已证明 token usage 单独解释 80% 的任务性能方差；
10. Chorus multi-agent execution 已验证消耗 chat 的 15 倍；
11. worker 摘要完整保留了 isolated context 中的所有关键事实。

#### 7.2.3 与第 5、7 篇的边界

第 5 篇讨论 conversation schema 如何跨进程持久化，并已经定义 AgentSession 与 DaemonSession 的区别；本文只使用该区别分析 attribution 和 cost visibility。第 7 篇将讨论不同 vendor/runtime 之间如何形成 federation；本文不把 runtime-specific lifecycle parity 扩展成跨厂商调度协议。

---

### 7.3 Roadmap：从可选标签走向可计算归因

#### 7.3.1 一等 correlation model

未来可以引入显式 correlation，而不是复用语义不同的 UUID：

```text
WorkExecution
  executionUuid
  taskUuid?
  agentSessionUuid?
  daemonSessionUuid?
  daemonTurnUuid?
  parentExecutionUuid?
  runtime
  startedAt / endedAt
```

这会把 business attribution、worker lifecycle 与 daemon usage 连接起来，同时保留各对象独立 identity。它应是新增 schema 与 propagation contract，不应通过名称和时间戳模糊 join。

#### 7.3.2 Attribution completeness

每次执行可以报告 completeness，而不是只展示存在的记录：

| Signal | Example |
|---|---|
| session observed | yes/no |
| task check-in observed | yes/no |
| activity session propagated | all/partial/none |
| turn correlation observed | yes/no |
| usage reported | complete/partial/missing |
| lifecycle close observed | yes/no/stale |

这样用户能区分“总成本为 0”与“该 backend 未上报”，也能区分“没有 worker”与“runtime integration 看不到 worker”。

#### 7.3.3 Controlled benchmark

若 Chorus 要验证 multi-agent economics，应建立版本化 benchmark：

1. 选择可并行与高依赖两类 Task；
2. 固定模型、tool surface、repository snapshot 与 success rubric；
3. 运行 single-agent、isolated-subagent 和 shared-context variants；
4. 记录 success、latency、tool calls、input/output/cache tokens；
5. 将 failed/retried runs 纳入；
6. 报告 confidence interval 与 task-level raw results。

在此之前，UI 可以展示 observation，不应展示“节省百分比”或“multi-agent efficiency score”。

#### 7.3.4 Runtime conformance

跨 runtime 的 attribution conformance test 应验证语义结果，而不是 hook 名称：

- worker 获得唯一 execution/session identity；
- Task check-in 可查询；
- report Activity 携带同一 identity；
- heartbeat/freshness 语义一致；
- normal close 与 abnormal disappearance 可区分；
- usage 缺失带 provenance，不默认为零。

这会把“Claude 自动、Pi 自动、Codex 手工”的实现差异转换为可测 contract，而不是假设所有 host 提供相同 lifecycle events。

---

## 8. 结论

多 Agent 并不因为数量增长而自动变成系统；它因为 context 被切开、因果链被切开，才需要新的系统结构。隔离让 worker 在干净窗口中并行处理复杂问题，并把主线程从大量中间输出中释放出来；同一隔离也制造了 brief duplication、summary loss、coordination overhead、token amplification 和 cross-session stitching。

Chorus 当前承担的是 attribution system of record：AgentSession 标记 worker identity，SessionTaskCheckin 标记 Task participation，Activity 可选地标记业务动作来源，DaemonSessionTurn 保存 runtime usage，DaemonSession 保存 rollup。Runtime 自己 spawn worker，Chorus 不冒充 scheduler；control plane 只记录成功进入它视野的事实。

这套边界也决定了数字如何表达。外部系统可以在特定比较中观察到 context isolation 降低处理量，也可以观察到 multi-agent 总 token 远高于 chat。Chorus 已经具备采集部分 usage 的基础，但尚未建立统一 worker-to-turn correlation 或 controlled benchmark。严谨的结论不是“多 Agent 更省”或“更多 Agent 更好”，而是：隔离必须用可归因、可恢复、带缺失语义的记录来支付；只有在任务价值超过这张账单时，并行 capacity 才有意义。

---

## 参考资料

1. LangChain, “Subagents,” *LangChain Documentation*. <https://docs.langchain.com/oss/python/langchain/multi-agent/subagents>
2. Anthropic, “Effective context engineering for AI agents.” <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
3. LangChain, “Multi-agent: Performance comparison,” *LangChain Documentation*. <https://docs.langchain.com/oss/python/langchain/multi-agent>
4. Anthropic, “How we built our multi-agent research system.” <https://www.anthropic.com/engineering/multi-agent-research-system>
5. Chorus, “Portability is Semantics, Not Prompt Copying.” [`02-portability-is-semantics.md`](02-portability-is-semantics.md)
6. Chorus, “Conversation as a Durable Protocol.” [`05-conversation-as-durable-protocol.md`](05-conversation-as-durable-protocol.md)
