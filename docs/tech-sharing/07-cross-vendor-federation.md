# 跨厂商联邦：协作不是共享一个 Context Window

## Cross-Vendor Federation: Collaboration Is Not a Shared Context Window

> 本文源码基线：`docs/tech-sharing` 分支，2026-08-16。源码位置以符号名为准，行号用于帮助定位。

## 摘要

当 Claude Code、Codex、Kiro、Pi 与 OpenClaw 参与同一项工作时，最容易产生的误解是：它们组成了一个更大的共享上下文。实际情况恰好相反。每个 runtime 保有自己的模型会话、工具循环、进程生命周期与本地 transcript；它们不能读取彼此的 context window。Chorus 所做的 federation，是让这些独立参与者通过同一组 authoritative entities、稳定的 MCP contract、可寻址的 daemon connection 与持久化 `@mention` handoff 进行 coordination-by-artifact。本文从 `AgentInstance` / `DaemonConnection` identity、单 daemon 的 `agents[]` 多身份配置、mention 到 Notification/Turn/SSE 的 recipient fan-out，以及 OpenClaw、Codex、Kiro 不同 wake adapter 出发，解释这种联邦拓扑。本文也明确它不提供什么：没有共享 memory，没有统一 scheduler，没有跨厂商 consensus 或文件锁；离线 recipient 只留下 Notification，不会立即 wake；多个 Agent 即使能够并行，也不能因此安全地并发修改同一个 worktree、HEAD 或 branch。

## Abstract

When Claude Code, Codex, Kiro, Pi, and OpenClaw participate in the same body of work, it is tempting to describe them as one larger shared context. The opposite is true. Every runtime retains its own model conversation, tool loop, process lifecycle, and local transcript; none can inspect another runtime's context window. Chorus federates these independent participants through common authoritative entities, a stable MCP contract, addressable daemon connections, and durable `@mention` handoffs. This is coordination by artifact rather than context transfer. This paper grounds that topology in `AgentInstance` and `DaemonConnection` identity, one daemon's multi-identity `agents[]` configuration, recipient fan-out from mentions through Notifications, Turns, and SSE, and the distinct wake adapters used by OpenClaw, Codex, and Kiro. It also states the limits: no shared memory, unified scheduler, cross-vendor consensus, or file lock; an offline recipient gets a Notification but no immediate wake; and the ability to run agents in parallel does not make concurrent mutation of one worktree, HEAD, or branch safe.

---

## 1. 命题：Federation 共享控制面，不共享上下文

### 1.1 五个 runtime 不是五个标签

“Claude、Codex、Kiro、Pi、OpenClaw 一起做一项任务”至少包含五个彼此独立的执行环境：

1. 各自选择何时调用模型、何时调用工具；
2. 各自维护 conversation/session identity；
3. 各自决定如何恢复历史；
4. 各自拥有进程、插件或 embedded runtime 生命周期；
5. 各自看到由 credential 与 permission 塑造的 MCP surface；
6. 各自在选定的 working directory 中读写文件。

其中没有一个步骤要求，也没有一个 Chorus schema 能够，把一个 runtime 的完整 context window 搬进另一个 runtime。跨 runtime 唤醒携带的是 durable entity identity、notification 内容、actor attribution 与 handoff instruction，不是发送方的隐藏模型状态。

因此本文使用 federation 的严格定义：

```text
cross-vendor federation
  = independent runtime contexts
  + common authoritative entities
  + stable control-plane contract
  + addressable delivery
  + durable handoff records
  + runtime-specific execution adapters
```

它不是：

```text
shared context window
shared model memory
one distributed transcript
one swarm scheduler
cross-vendor consensus
```

### 1.2 共享的是 authoritative state

不同 Agent 可以通过 MCP 读取同一个 Idea、Proposal、Task、Document、Comment、Elaboration 与 Reference；Notification 则按 recipient 隔离，每个 Agent 读取自己的 inbox event。共享业务实体是 control plane 的 authoritative state。Agent 被唤醒后重新读取它们，获得当前可验证事实，而不是假设发送方脑中的历史已经同步过来。

Model Context Protocol 将 host、client 与 server 分层，并以协议消息暴露 context 与 capability [1]。这个外部架构帮助解释“稳定 contract”为什么能跨 host，但它不自动提供 Chorus 的业务语义。Idea 状态、Task acceptance criteria、mention routing 与 daemon liveness 仍由 Chorus 自己的 schema 和 service 实现。

第 2 篇已经分析同一语义如何适配不同 runtime，第 5 篇分析 durable conversation object，第 6 篇分析 context isolation 与 attribution。本文只研究三者相交后的协调拓扑，不重新证明 adapter、protocol 或 attribution 各自的内部机制。

### 1.3 Artifact handoff 不是 context transfer

一个可靠 handoff 应当让接收者能够独立重建工作前提：

```text
sender local context
  -> durable comment / state mutation / evidence
  -> recipient-scoped notification
  -> recipient runtime wake
  -> recipient re-reads authoritative entities
  -> recipient builds its own local context
```

箭头中没有“复制 context window”。Comment 可以概括判断，Document 可以保存完整设计，Task 可以保存 acceptance criteria，Activity 可以保留 attribution；但发送方未写入 control plane 的中间推理、临时 tool output 与未保存文件不会神奇地出现在接收方。

### 1.4 四步 federation protocol

本文将跨 identity 的中介式协作压缩为四步：

1. **可寻址事件**：发送方把 request 写入业务实体，并以 `@mention` 指定 recipient；
2. **重读 authoritative state**：Notification/Turn 唤醒接收方后，接收方重新读取 entity、comments、elaboration 与 references；
3. **独立判断**：接收方使用自己的 identity、permission、runtime、thread 与 tool surface 验证请求，而不是继承发送方结论；
4. **durable writeback**：接收方把结论、correction 或 dissent 写回同一实体，成为后续人或 Agent 可重读的 artifact。

“对等”不表示两方拥有相同权限、模型或工具。它表示双方各有独立 principal 和执行边界，并且协议允许接收方提出异议，而不是只能作为发送方的隐藏 sub-agent 返回 “done”。

---

## 2. Addressability：先知道唤醒谁、在哪里唤醒

### 2.1 Agent principal、instance 与 connection 是三层身份

跨厂商 federation 需要区分三类 identity：

| 层 | 含义 | 是否表示在线 |
|---|---|---|
| Agent | credential 对应的业务 principal | 否 |
| AgentInstance | `(company, agent, host, cwd)` 的持久地址 | 否 |
| DaemonConnection | 某 clientType 在该位置的连接与 liveness | 是，带 freshness 语义 |

`AgentInstance` 以 `(companyUuid, agentUuid, host, cwd)` 唯一，注释明确它只保存 durable address，不保存 liveness。Connection reconnect 可以变化，instance UUID 仍可作为 assignment 或 mention pin 的稳定 handle（`prisma/schema.prisma:95-125`）。

`DaemonConnection` 则记录：

```text
companyUuid
agentUuid
clientType
clientVersion?
host
cwd?
startedAt?
agentInstanceUuid?
status
connectedAt / lastSeenAt / disconnectedAt
```

其复合唯一键是 `(agentUuid, clientType, host, cwd)`（`prisma/schema.prisma:475-534`）。这允许同一个 Agent 在同一 host 上服务多个 cwd，也允许 registry 分辨 Claude Code、OpenClaw、Codex、Kiro 等 client type。

### 2.2 Connection identity 不是厂商共享会话

`registerConnection` 对识别出的 daemon client type 注册或刷新 presence。cwd 已知时，reconnect 通过复合键 upsert；cwd 未知的旧 daemon 走兼容的 find/update/create 路径。每次 registration 刷新 `connectedAt`，后续 heartbeat 与 disconnect 用它作为 generation fencing token（`src/services/daemon-connection.service.ts:340-387,553-650`）。

这套 identity 回答的是：

- 哪个 Agent principal；
- 哪类 runtime client；
- 哪台 host；
- 哪个 working directory；
- 该 connection 是否仍有效。

它不回答“该 Agent 的 context 里有什么”。把 connection row 当 shared session，会混淆可寻址 transport 与模型 conversation。

### 2.3 同一位置的重复 daemon 防护有意受限

Registration 在真实 cwd 路径上检查同一 `(agent, host, cwd)` 是否已有不同 live process，避免同一 Agent 的两个 backend 在一次 notification batch 中重复执行；冲突时在写入前拒绝新 registration（`src/services/daemon-connection.service.ts:568-610`）。

这个防护不是 workspace lock：

- key 包含同一个 `agentUuid`，不同 Agent principal 不互斥；
- 它保护 daemon delivery identity，不保护 Git index、HEAD 或 branch ref；
- 它不序列化业务 Task；
- 它不构成跨 host 的 distributed lease。

所以 registry 能避免一类重复 wake，却不能推出“一个 cwd 同时只会被一个 Agent 修改”。

---

## 3. One Daemon, N Identities：进程共居不等于上下文共享

### 3.1 `agents[]` 是独立配置列表

CLI daemon 支持在 `~/.chorus/daemon.json` 中声明非空 `agents[]`。每个 entry 解析为独立 `AgentConfig`，包含：

```text
url
apiKey
agentType
cwds[]
permissionMode
maxConcurrency
sigintTimeoutMs
browseRoots[]
label
```

per-agent 值覆盖 top-level default；缺少 credential、未知 backend 或非法 permission mode 会产生可见错误，不会静默换成另一个身份。没有 `agents[]` 时则保持原单 Agent 兼容路径（`cli/daemon-config.mjs:249-269,305-437`）。

这里“一进程服务 N 个 Agent”是部署复用，不是 identity 合并。每个 entry 仍有自己的 API key、backend、cwd set、permission posture 与 concurrency budget。

### 3.2 Runtime isolation 在 builder 中具体发生

`buildMultiAgentDaemon` 对每个 config 调用一次 `buildDaemon`。每份 runtime 拥有自己的：

- credential pair；
- `ChorusClient` / MCP client；
- lineage resolver；
- backend-specific spawner；
- WakeQueue 与 `maxConcurrency`；
- cwd connections。

一个 Agent build/start 失败会被记录并跳过，其他 runtime 继续服务；所有 runtime 都失败才终止 aggregate daemon（`cli/daemon.mjs:595-672`）。Startup 也逐个验证 credential，仅将成功的 config 交给 builder（`cli/daemon.mjs:817-895`）。

共用 OS process 并没有创建共享 model context。它只共享 process-level deployment envelope。两个 config 即使都指向 Codex，也会用不同 credential 和 runtime object 接收各自事件；一个 Codex 与一个 Kiro 共居时，更不可能共享 backend session representation。

### 3.3 N identities 不等于 N-way broadcast

`agents[]` 的存在不意味着每条消息自动唤醒所有 Agent。Fan-out 的 recipient set 来自明确的 mention、assignment 或 stage action。一个 daemon process 可以订阅并承载多个 identity，但每个 identity 只处理发给自己的 notification stream 和 connection target。

因此：

```text
deployment fan-out capacity != message recipient set
```

“一个进程能服务五个 Agent”描述 capacity；“一条 comment 明确 mention 三个有效 recipient”才描述该次 handoff 的 fan-out。

---

## 4. `@mention` Fan-out：持久记录先于 runtime wake

### 4.1 Recipient set 的形成

`parseMentions` 从 `@[Name](type:uuid)` markup 解析 target，按 `type:uuid` 去重，最多保留 10 个；pin 只细化 instance address，不扩大 recipient identity（`src/services/mention.service.ts:330-371`）。

`createMentions` 随后：

1. 排除 self-mention；
2. 验证 target 存在且属于同一 company；
3. 批量写 Mention rows；
4. 检查每个 recipient 的 notification preference；
5. 为每个有效且允许通知的 recipient 构造 Notification；
6. 将数组交给 `notificationService.createBatch`。

对应实现位于 `src/services/mention.service.ts:375-543`。所以“N 元 fan-out”的精确含义是：一条内容中的 N 个不同、有效、非自身且允许 mentioned notification 的 target，产生 N 个 recipient notification candidates。它不是自动向所有 vendor 广播。

### 4.2 Notification 与 wake attempt 是两层结果

`createBatch` 先并行创建所有 Notification rows，再按 recipient 逐个调用 `createTurnAndResolveTarget`，最后向 recipient-scoped SSE channel emit `new_notification`。Turn creation 与 ping failure 被隔离，不回滚已经持久化的 Notification（`src/services/notification.service.ts:337-429`）。

这形成清晰的 durability boundary：

| 层 | 成功意味着什么 |
|---|---|
| Mention | 内容中出现了合法 recipient reference |
| Notification | recipient 有一条持久可读记录 |
| DaemonSessionTurn | server 为 wake-triggering action 创建了 execution turn |
| SSE/control delivery | 某在线 connection 收到即时 signal |
| Runtime completion | adapter 实际执行并回报 terminal status |

后层失败不应改写前层已经发生的事实。第 5 篇已经展开这种 durable handoff；本文关注它如何穿过不同 runtime。

### 4.3 在线、pin 与 notify-only

Wake target selection 有四种结果：

- `directed`：pin 或 session-origin 命中指定 online connection；
- `online_first`：无 pin 时选择排序后的首个 online connection；
- `offline_pin`：指定位置不在线，不回退其他 cwd；
- `none`：该 Agent 没有 online connection。

`offline_pin` 与 `none` 都不创建 Turn；Notification 作为 plain record 保留。前者还带 `suppressWake`，避免其他在线 cwd 因 broadcast 误接这次硬 pin（`src/services/notification-turn.ts:570-648,883-900`）。

因此，`@mention` 是 durable notification，不是 durable wake。离线 Agent 稍后可以读取 Notification，但当前实现没有为这条 notify-only 记录承诺“上线后一定自动补跑同一个 wake”。

---

## 5. 同一 Handoff，进入不同 Runtime

### 5.1 通用 daemon event router

CLI daemon 通过 SSE 收到 recipient notification，读取完整 detail、按 action 构造 prompt，并把 wake 放入该 runtime 的 queue。Connection target、cwd 与 session anchor 决定哪个 adapter 在哪里执行。Router 传递的是业务 handoff 与 durable IDs，不是另一个模型的 transcript。

这也是第 2 篇所说 semantic portability 的运行时结果：相同的“你被 mention，请读取 entity、完成工作并回报”语义，通过不同 backend adapter 落到各自可用 primitive。

### 5.2 OpenClaw：embedded runtime path

OpenClaw plugin 自报 `clientType=openclaw`、hostname 与 process cwd（`packages/openclaw-plugin/src/sse-listener.ts:102-118`）。它的 event router 收到 `new_notification` 后：

1. 通过 MCP 读取 unread notification detail；
2. 解析 entity 与 lineage attribution；
3. 按 action dispatch；
4. 对 `mentioned` 等 action 构造 handoff prompt；
5. 通过 embedded runtime 的 wake callback 启动 agent。

Routing switch 与 mention guidance 位于 `packages/openclaw-plugin/src/event-router.ts:89-236`。OpenClaw 没有加入发送方 context；它在自己的 runtime 中消费相同的 durable notification。

### 5.3 Codex：headless subprocess 与 thread map

Codex adapter 以 Chorus entity anchor 查找持久化的 `anchor -> thread_id`：

- 找到 thread ID 则 `resume`；
- 找不到则启动新 run，并从 NDJSON event 捕获 thread ID；
- prompt 经 stdin 传入，不放在 argv；
- child 使用选定 cwd 与该 Agent 自己的 Chorus credential；
- terminal usage event 做 per-turn normalization。

实现位于 `cli/codex-spawner.mjs:221-365`。这里 resume 的是 Codex 自己的 thread，不是 Claude、Kiro 或 OpenClaw 的 session。相同 Idea anchor 可以帮助每个 adapter找到“自己的连续性”，但不会让 backend session ID 变成跨厂商通用 ID。

### 5.4 Kiro：session store 推断与诚实退化

Kiro 没有等价的 ID-bearing stream event。Adapter 在新 run 前后 snapshot session store，以 diff 推断新 session ID；若同时出现零个或多个 candidate，它拒绝猜测，避免把两个 Idea 的 conversation cross-wire。Headless run 不产生可用 store session 时，transcript reconstruction 退化到 raw stdout（`cli/kiro-spawner.mjs:285-399`）。

这说明 federation contract 不能依赖所有 runtime 拥有相同 session primitive。Control plane 保持 entity、notification 与 attribution 语义稳定；adapter 对本地 continuity 做能力范围内的 best effort。

### 5.5 Pi 与 Claude Code 同样保持 runtime ownership

Pi 和 Claude Code 的具体 adaptation 已在第 2 篇说明：Pi 通过 extension/event lifecycle 与 subagent primitive 工作，Claude Code 通过 hooks、headless CLI 与本地 transcript/session 机制工作。它们接入同一 MCP control plane，不会因此交出各自的 scheduler 或 context ownership。

Federation 的可移植单位是：

```text
entity identity + action semantics + evidence + handoff obligation
```

而不是：

```text
vendor transcript format + hidden model state + local process assumptions
```

---

## 6. 一个跨厂商 Handoff 的完整例子

假设 Claude Code 负责 proposal，Codex 负责实现，Kiro 负责独立验证，OpenClaw 负责异步跟进。

### 6.1 Claude Code 写入可重读的前提

Claude Code 不应只在本地 conversation 中说“方案定了”。它把约束写入 Proposal/Document，把可验收行为写入 Task/AC，再 comment：

```text
实现已获批。@[Codex](agent:...) 请领取 Task T，
以 Document D 为约束，完成后附测试证据并 mention Kiro。
```

这条 comment 持久化后，mention service 为 Codex 创建 recipient Notification，并在 Codex connection 在线时尝试创建 Turn 与发送 SSE。

### 6.2 Codex 重建自己的 context

Codex daemon 在自己的 cwd 启动或 resume Codex thread。Codex 读取 Idea、Proposal、Document、Task、AC 与最新 Comment，检查当前 repository state，再开始实现。它不能查看 Claude Code 的隐藏 chain、tool logs 或未提交修改；如果必要事实只在 Claude context 中，handoff 就是不完整的。

完成后 Codex 应把：

- commit 或 diff identity；
- 测试命令与结果；
- 已知 gap；
- 需要 reviewer 决定的问题；

写回 Task/Comment，再明确 mention Kiro。

### 6.3 Kiro 独立验证，而不是继承结论

Kiro 收到自己的 Notification 后，从 authoritative Task/AC 与 repository artifact 开始验证。它可以读取 Codex 的 evidence，但不应把“Codex 说通过”当成已验证事实。Kiro 的本地 session continuity 由 Kiro adapter 维护，与 Codex thread 无关。

如果 Kiro 离线，Notification 仍在，但不会产生即时 wake。在线 Agent 或人需要从 UI/notification state 看见 pending handoff，而不能假设 reviewer 已经开始。

### 6.4 OpenClaw 继续异步闭环

OpenClaw 被 mention 后，通过 plugin event router 在 embedded runtime 中重新读取当前 entity。此时 Proposal、Task status、review comment 与 commit 才是共享事实；此前各 runtime 的 model context 都不是。

这个例子中的 federation 不是四个 Agent “在一个房间里思考”，而是四个独立执行者围绕同一份有版本、有身份、有状态的工作记录交接。

---

## 7. Live Demo、并发边界与演进

### 7.1 本 Container Idea 就是 Federation 轨迹

本论文集的 container Idea `caf66e8d-63ef-4655-900b-552bf36828df` 不是虚构案例，而是 Claude 与 Codex 通过 Chorus 完成的一条真实 brokered handoff：

| 阶段 | Actor | Durable artifact |
|---|---|---|
| 发起 | Admin Claude | Comment `fe5ecfc9`：提出 14 个候选并 `@mention` Codex |
| 独立评审 | Codex | Comment `0ed797c3`：合并/删除候选，校准 SSE、token、permission 与 federation 命名 |
| 综合 | Admin Claude | Comment `ed482486`：吸收评审，形成 7+1 shortlist 与 elaboration round |
| 再质疑 | Codex | Comment `12d5ed57`：指出 auditability ≠ measurement 与“不可逆”措辞边界 |
| 人类决策 | User | 在 elaboration 面板选择收录、并入或调整 |
| 派生 | Admin Claude | 创建 8 个 child Ideas，并把约束和 references 写入各 child |
| 交付 | Codex | 写论文、commit，并在 child/container 留下具名验收请求 |
| 验收 | Admin Claude | 重读文档与源码，写回 acceptance 或 correction |

这条轨迹精确体现四步协议：

```text
Admin Claude Comment + @mention
  -> recipient-scoped Notification / Codex Turn
  -> Codex 重新读取 Idea、comments、elaboration、references
  -> Codex 独立删改并写回同一 Idea
  -> Admin Claude 在自己的后续 turn 中重读并继续
```

Claude 没有把 context window 传给 Codex；Codex 也没有把 thread 交给 Claude。共享的是 entity UUID、持久 Comments、结构化 answers、references 和后续 child artifacts。

#### 7.1.1 独立判断不是形式动作

Codex 的回复没有复述草案，而是：

- 把 14 个 feature-like 候选收敛为 7+1 个有独立主张的 talk；
- 将三条不同 SSE path 分开；
- 拒绝把 `coalescedCount` 和 orphan reconciliation 当 autonomy metric；
- 将 cross-vendor coordination 从 “swarm” 改为 brokered/asynchronous federation；
- 对外部 67%/80% 数字要求原始出处、实验条件与成本 caveat；
- 指出 completed Idea 无法 backfill ownership 的 lifecycle gap。

Admin Claude 随后也没有盲目接受文档，而是派只读核查 Agent 对源码 fact-check，并在每篇 acceptance 中记录 line drift、措辞或缺失引用。Dissent 与 correction 被持久化，正是“对等”的可观察证据。

#### 7.1.2 Demo 应展示协议，不只展示两个聊天窗口

现场演示建议按以下顺序：

1. 展示 sender Comment、mention principal 与 target Idea UUID；
2. 展示 recipient Notification 和 `trigger=mentioned` 的 Turn；
3. 切换到 Codex，展示重新调用 Idea/comments/elaboration/reference reads；
4. 展示 Codex 对上游结论的独立删改；
5. 展示 writeback Comment 的独立 author identity；
6. 展示 Admin Claude 后续 acceptance/correction；
7. 叠加 Activity、turn status 与 token usage，并说明它们是不同轨迹。

这样观众看到的是 shared state、addressing、wake、audit 与 policy，而不是一个模型把隐藏 memory 复制给另一个模型。

### 7.2 最危险的误读：能并行，不等于能并发改同一棵树

#### 7.2.1 Control-plane coordination 不提供 filesystem isolation

Chorus 可以让两个 Agent 同时收到不同 Task，也可以让一个 daemon 对不同 Agent 配置不同 cwd。但如果两个 config 最终指向同一个 physical worktree，它们仍可能同时：

- 修改同一个文件；
- 写同一个 Git index；
- checkout 或移动同一个 HEAD；
- 更新同一个 branch ref；
- 运行会互相覆盖 output 的 formatter、codegen 或 build；
- 删除对方尚未提交的临时文件。

`DaemonConnection` conflict detection 只阻止同一个 Agent identity 在同一 host/cwd 的重复 live daemon。它没有阻止两个不同 agentUuid 指向同一路径。

#### 7.2.2 Git worktree 是隔离工具，不是 Chorus 已有保证

Git 官方文档说明，一个 repository 可以通过 `git worktree` 管理多个 working tree，让不同 branch 同时 checkout 到不同路径 [2]。这为并行 Agent 提供实用隔离单元：

```text
Agent A -> /repo/.worktrees/task-a -> branch task-a
Agent B -> /repo/.worktrees/task-b -> branch task-b
Agent C -> read-only review of committed artifact
```

但使用独立 worktree 仍不等于自动 merge safety。Agent 可能产生语义冲突，shared build cache 也可能互相影响；最终 integration 仍需明确 owner、dependency order、review 与 merge policy。

#### 7.2.3 当前最低安全纪律

在没有一等 workspace lease 的当前实现中，至少应遵循：

1. 并行 mutation 使用不同 worktree 与 branch；
2. 一个 integration owner 负责 rebase/merge；
3. reviewer 优先验证 committed artifact，不依赖作者未提交状态；
4. handoff 明确 repository、worktree、branch 与 commit；
5. 发现同一 tree 的未预期修改时停止覆盖并重新协调；
6. 不把 Task assignment 当文件锁。

这些是操作纪律，不是 Chorus server enforcement。

---

### 7.3 Federation 保证什么，不保证什么

#### 7.3.1 当前实现能够支持的结论

基于上述实现，可以合理推出：

- 多种 vendor runtime 可以使用同一 MCP 业务 contract；
- Agent、runtime client、host 与 cwd 可以被独立寻址和观测；
- 一个 daemon process 可以承载多个独立 Agent credential/runtime；
- 一条 comment 可向多个明确 recipient 创建 Mention/Notification；
- 在线 recipient 可以经 SSE/control path 进入各自 runtime wake adapter；
- recipient 可以重读同一 authoritative entity state；
- runtime-specific session continuity 不必泄漏进业务 schema；
- delivery failure 不会抹去已创建的 Notification。

#### 7.3.2 当前实现不能支持的结论

不能由这些机制推出：

1. Agent 共享 context window 或 hidden memory；
2. 一个 vendor 能直接 resume 另一个 vendor 的 model session；
3. 所有 explicit mention 都一定立即执行；
4. 离线 Notification 一定在未来自动补 wake；
5. N 个配置会收到每一条消息；
6. recipient 读取时看到的 state 与 sender 写入时完全相同；
7. 多 Agent 对同一业务对象具备 linearizable consensus；
8. Task assignment、AgentInstance 或 DaemonConnection 是 distributed lock；
9. 多 Agent 能安全并发修改同一 worktree、HEAD 或 branch；
10. control-plane Activity 是完整 cross-vendor distributed trace；
11. 一进程 N Agent 意味着共享 token budget、scheduler 或 context；
12. federation 本身会提高正确率、速度或成本效率。

#### 7.3.3 Federation 与 swarm 的边界

Swarm 通常意味着某种统一 orchestration：worker creation、task decomposition、scheduling、result aggregation 或 shared planning policy。Chorus 的 federation 可以承载由 runtime 发起的 swarm attribution，也可以协调几个完全独立的 top-level Agent，但它本身不创建统一 inference scheduler。

简化地说：

```text
swarm asks: who decomposes and schedules the workers?
federation asks: how do independent runtimes address, hand off, and re-read work?
```

两者可以组合，但不能互换。

---

### 7.4 Roadmap：从可互通到可验证联邦

以下能力尚不能作为当前实现事实。

#### 7.4.1 Handoff envelope 与 idempotency

将跨 runtime handoff 提升为一等对象：

```text
handoffUuid
sender
recipient
entityVersion / expectedState
instruction
evidenceRefs[]
createdAt
deliveryState
ackState
completionState
idempotencyKey
```

这能把“Notification 已创建”“runtime 已收到”“Agent 已接受”“工作已完成”拆成不同状态，并为 retry/dedup 提供 contract。

#### 7.4.2 Workspace lease 与 mutation scope

为会修改 repository 的 execution 显式记录：

- repo identity；
- physical worktree；
- branch/ref；
- base commit；
- mutation owner；
- lease/fencing generation；
- integration target。

Server 或 daemon 可以在注册 execution 前检测明显重叠，但仍需承认 Git 与 filesystem 是外部 consistency domain。

#### 7.4.3 Cross-runtime conformance suite

以同一组 black-box scenario 验证每个 adapter：

1. mention online recipient；
2. mention offline recipient；
3. hard-pin online/offline cwd；
4. fresh session 与 resume；
5. duplicate SSE 与 idempotent handling；
6. interrupt/reconnect；
7. transcript/usage degradation；
8. terminal report 与 actor attribution。

测试目标不是让所有 runtime 内部实现相同，而是验证相同业务语义与诚实退化。

#### 7.4.4 Versioned artifact reads

Recipient 当前重读的是“最新 state”。更严格的 handoff 可以同时保存 expected entity version 或 content hash，让 recipient 明确知道 sender 基于哪个版本作出请求，并在 state 已变化时重新确认，而不是默默沿用过时前提。

#### 7.4.5 Federation observability

未来可将 Notification、Turn、runtime session、Activity、commit 与 verification 连接成一等 correlation graph，同时保留 provenance：

```text
requested -> persisted -> delivered -> accepted -> executed -> evidenced -> verified
```

这会提高可审计性，但仍不等于共享 context 或 deterministic replay。

---

## 8. 结论

跨厂商 Agent 协作的正确抽象不是“把五个模型塞进一个更大的对话”，而是“让五个独立 runtime 围绕同一组可寻址、可重读、可归因的 artifact 工作”。

Chorus 当前实现已经给出这套 topology 的关键部件：

- `AgentInstance` 提供持久 place identity；
- `DaemonConnection` 提供 runtime presence；
- `agents[]` 让一个 daemon 承载多个独立 principal；
- Mention/Notification 提供 recipient-scoped durable handoff；
- Turn/SSE/control path 将在线 handoff 送到具体 connection；
- OpenClaw、Codex、Kiro 等 adapter 在各自 session model 中执行；
- MCP 与业务实体保持跨 runtime 的 semantic contract。

它的价值来自边界清楚，而不是边界消失。每个 Agent 必须重新读取 authoritative state，每次 handoff 必须把必要事实写成 artifact，每个 runtime 仍拥有自己的 context 与失败模式。也正因为如此，系统必须诚实承认离线 wake、版本漂移、workspace 冲突、缺少 consensus/lock 与不完整 correlation。

Federation 不是 shared memory。它是一套让不共享 memory 的参与者仍能可靠协作的控制面。

---

## 参考资料

1. Model Context Protocol, “Architecture overview.”
   <https://modelcontextprotocol.io/docs/learn/architecture>
2. Git, “git-worktree Documentation.”
   <https://git-scm.com/docs/git-worktree>
3. Chorus 技术分享第 2 篇，[Portability is Semantics, Not Prompt Copying](02-portability-is-semantics.md)。
4. Chorus 技术分享第 5 篇，[Conversation as a Durable Protocol](05-conversation-as-durable-protocol.md)。
5. Chorus 技术分享第 6 篇，[Context and Attribution](06-context-and-attribution.md)。

> 外部资料用于说明协议分层与 repository working-tree isolation 的通用概念；Chorus 的实现结论均以本文引用的仓库源码为准。
