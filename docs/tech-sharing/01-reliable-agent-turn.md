# 把一次通知可靠地变成一个可恢复的 Agent Turn

## Turning One Notification into a Reliable, Resumable Agent Turn

> 源码基线：`cbbe886a`。行号用于精确说明本文分析的版本；后续版本应以符号名为准。

## 摘要

长运行 coding agent 的可靠性问题，不是“能否收到一条消息”，而是如何把外部事件变成一次有序、可恢复、可归因并最终可观察的执行。本文以 Chorus daemon 为案例，分析一条端到端链路：事件先被解析到稳定的 session key；同 key 严格串行，不同 key 在全局上限内并发；同一 turn 忙碌期间积压的事件不经过 debounce，而是在执行槽释放时自然合并；一个批次只启动一个 subprocess，并在固定 working directory 中创建或恢复同一 agent session；服务端按 turn 记录 `pending → running → ended/interrupted`，将被批次吸收的后续 turn 结算为 `merged`；最后，执行快照和逐 session transcript 事件分别收敛“当前正在做什么”和“历史上发生了什么”。本文的核心结论是：可靠 agent turn 不是单个队列或一次 `resume`，而是调度、位置、执行、记账与可视化五个一致性域之间的组合协议。Chorus 已实现这一协议的重要骨架，但它不是 exactly-once 事务系统；进程内队列持久性、跨故障原子性、无界批次与后端 transcript 能力仍构成明确边界。

## Abstract

The reliability problem of a long-running coding agent is not merely whether it can receive a message. It is whether an external event can become an ordered, resumable, attributable, and observable execution. This paper studies the Chorus daemon pipeline: events are resolved to stable session keys; work is strictly serialized within a key while different keys run concurrently under a global cap; events accumulated during an active turn are naturally coalesced when the slot becomes free, without a debounce timer; one batch launches one subprocess and creates or resumes the same agent session in a pinned working directory; the server accounts for the lifecycle of each turn and settles absorbed pending turns as `merged`; execution snapshots and per-session transcript events then converge the live execution view and durable conversation history separately. The central claim is that a reliable agent turn is a composite protocol across scheduling, placement, execution, accounting, and presentation consistency domains, rather than a queue or resume command in isolation. Chorus implements a substantial version of this protocol, but it does not claim exactly-once transactional execution: in-memory queue durability, cross-failure atomicity, unbounded batches, and backend transcript fidelity remain explicit limitations.

## 1. 引言与动机

### 1.1 为什么 2026 年要讨论 turn，而不只讨论 prompt

早期 agent 应用常把一次用户输入近似为一次模型调用。进入长运行、无终端和多 Agent 场景后，这个抽象不再充分。一条 `@mention`、任务分配、审批结果或人类追加指令，可能在 agent 正忙、daemon 重连、浏览器离线、同一身份运行于多个目录、或上一个 subprocess 异常退出时到达。此时系统必须回答一组比 prompt engineering 更基础的问题：

1. 这条事件属于哪个连续会话？
2. 是否允许两个进程同时恢复同一会话？
3. 忙时积压的事件应逐条执行、丢弃，还是合并？
4. 合并后，原本已经创建的持久 turn 如何结算？
5. session 应在哪个 repository 和 working directory 恢复？
6. UI 如何同时得到当前执行状态与可重放的历史？
7. 断线重连后，哪些工作仍应派发，哪些已经被吸收？

这些问题共同构成 agent harness 的执行语义。模型能力再强，如果 harness 允许同一 session 并发恢复、在错误目录继续、或让 pending turn 永久悬挂，用户看到的仍是一个不可靠系统。

### 1.2 研究问题与主张

本文研究 Chorus 如何实现以下主线：

```text
event
  -> stable session key
  -> same-key serial queue
  -> natural coalescing at slot release
  -> one subprocess / create-or-resume
  -> per-turn accounting
  -> execution and transcript convergence
```

本文主张：

> “可靠 turn”不是把事件成功送达 subprocess，而是让事件、session、cwd、进程、持久 turn 和用户视图在正常运行与恢复路径上得到可解释的一致结果。

这个主张包含两个不能省略的并发条件：

- **同一个 key 串行**：禁止并发恢复同一 session。
- **不同 key 并发**：系统不能退化为全局单线程；并发受全局上限约束。

它也包含一个位置条件：**cwd 是 session 连续性的组成部分，必须 hard-pin，不能在原位置不可用时静默漂移到另一个 repository。**

## 2. 背景与相关工作

### 2.1 从 Agent Loop 到 Harness

“From Prompts to Harnesses”把 agentic system 的演进描述为从单次 prompt、tool loop 走向具有生命周期、状态、反馈和治理能力的 harness [1]。这一视角的重要变化是：模型调用只是系统中的一个步骤，系统质量越来越取决于模型外部的调度、持久状态、权限、恢复和观测机制。

Chorus 的案例进一步表明，harness 不应只抽象“调用哪个模型”，还必须定义 turn 的业务语义。这里的 turn 不是 LLM API 的一轮消息，而是一个由外部事件触发、在本地 agent runtime 中执行、由服务端持久化记账的工作单元。

### 2.2 SSE 是通知机制，不是持久队列

Server-Sent Events 提供服务器到客户端的单向事件流和浏览器原生重连能力 [2]，适合通知 daemon 或刷新 UI。但 SSE 本身不等于 durable queue：连接可能中断，客户端的内存去重集合会随进程消失，事件到达也不代表业务动作已经开始。

因此 Chorus 把 SSE 当作“有新状态可读取”的信号，而不是唯一事实来源。daemon 收到 `new_notification` 后重新读取未读通知；重连时又从 canonical turn table 找回未开始的 turn。通知流负责低延迟，持久表负责恢复，两者职责不同。

### 2.3 合并不是 debounce

常见事件聚合会设置一个时间窗口，例如“等待 100 ms，再把窗口内事件合并”。这会引入固定延迟和新的参数。Chorus 采用的是 **natural coalescing**：

- key 空闲时，首个事件立即运行；
- key 忙碌时，新事件进入该 key 的 pending array；
- 当前批次结束、执行槽释放时，一次性 drain 此刻全部 pending 项；
- drain 后到达的事件属于下一个批次。

合并边界由真实执行占用时间决定，而不是人为计时器。它特别适合 coding agent：一次 turn 往往持续数十秒或更久，忙时积压已经自然形成了有意义的 backlog。

### 2.4 恢复必须同时绑定身份与位置

许多 CLI agent 把会话 transcript 放在按 cwd 分区的本地目录。即使 session UUID 相同，在另一个 cwd 中执行 `resume` 也可能找不到 transcript，或更危险地在错误 repository 中继续。Chorus 因此把 session origin connection 与 cwd 视为固定属性，而不是可随意重新选择的 worker placement。

这与一般分布式任务“任一空闲 worker 都可接手”不同：coding-agent session 携带本地文件、git 状态、进程环境和 runtime transcript，恢复位置本身就是正确性条件。

## 3. Chorus 架构与机制

### 3.1 总体分层

这条链路由五层共同完成：

| 层 | 责任 | 主要实现 |
|---|---|---|
| 事件与路由 | 接收事件、去重、定向投递、解析 session key | `cli/event-router.mjs` |
| 调度 | 同 key 串行、跨 key 限并发、自然合并 | `cli/wake-queue.mjs` |
| 执行 | prompt 合并、cwd 解析、spawn/resume、退出分类 | `cli/waker.mjs` |
| 持久记账 | turn 生命周期、`merged` 结算、恢复读取 | `src/services/daemon-session.service.ts` |
| 收敛与呈现 | execution snapshot、transcript events、merged UX | `daemon-execution.service.ts` 与 chat components |

任何一层都不能单独提供端到端保证。例如，队列可以正确合并事件，但如果服务端仍保留多个 `pending` turn，重连会重复派发；服务端可以正确记账，但如果两个本地进程并发 `resume` 同一个 transcript，会话仍可能损坏。

### 3.2 事件入口：低延迟信号与持久恢复

通知创建的 chokepoint 先写 notification，再调用 `createTurnAndResolveTarget` 创建匹配的 daemon turn 并解析定向连接，之后才发出 `new_notification`（`src/services/notification.service.ts:268-305`）。这使 SSE envelope 可以携带 transport-only 的 `targetConnectionUuid`、`runtimeCwd` 和 `suppressWake`，同时让持久 turn 先于实时信号存在。

daemon 的 `EventRouter.dispatch` 在异步读取前就把 notification UUID 放入 connection-local `seen` set（`cli/event-router.mjs:67-72,91-113`）。这个顺序收敛同一进程内的重复实时投递，但它不是永久幂等记录。`#fetchAndRoute` 会重新读取 unread notifications，并对定向投递作 suppress/accept 决策（`cli/event-router.mjs:122-214`）。

恢复路径不只依赖 notification。`dispatchPendingTurn` 从 canonical turn table 重建未开始工作：对 `human_instruction` 可直接使用持久化的 `promptText`；对 autonomous wake 则需要重新读取 notification 以恢复完整 prompt context（`cli/event-router.mjs:262-395`）。最终，实时事件与 backfill 都进入同一个 `markQueued → enqueue` 路径（`cli/event-router.mjs:511-547`）。

### 3.3 Session key：把串行域对准会话域

路由器通过 `waker.keyFor` 解析 direct idea，并以它形成 idea-anchored session key；没有 idea ancestry 的 ad-hoc conversation 则以自身实体形成 key。关键点是：**serialization key 与 session anchor 对齐**。如果按 notification entity 串行，两条分别落在 task A 和 task B、但最终恢复同一 direct idea session 的事件，可能被错误地并发执行。

direct idea 和 root idea 不能混用：

- direct idea 决定 session anchor 与串行 key；
- root idea 用于 execution attribution 和上层汇总。

实现显式在线程中传递二者，不从字符串 key 反向切割推断（`cli/waker.mjs:383-388`）。

### 3.4 调度：同 key 串行，不同 key 并发

`WakeQueue` 的状态由三部分组成：每 key 的 `pending` map、当前运行 key 的 `running` set、等待全局槽位的 `readyKeys`，另有 `activeCount`（`cli/wake-queue.mjs:24-45`）。

`enqueue` 只追加数据并立即返回。若 key 已运行，事件只在 pending array 中积累；若 key 未运行且尚未等待槽位，它被加入 `readyKeys`（`cli/wake-queue.mjs:65-75`）。`#pump` 在 `activeCount < maxConcurrency` 时启动其他 ready key，因此：

```text
key A: A1 running -> [A2, A3 pending]     严格串行
key B: B1 running                         可与 A1 并发
key C: C1 ready                           受 maxConcurrency 限制
```

当 A1 完成，`#startBatch` 对 A 的 pending array 执行 `splice(0)`，把当时的全部 A 项交给一次 `runBatch`（`cli/wake-queue.mjs:135-170`）。没有 debounce timer，也没有 batch-size cap。`cli/daemon.mjs:362-373` 把 `runBatch` 接到 `waker.wakeBatch`，且每个 daemon connection 有自己的 queue。

### 3.5 一个批次，一个 subprocess

`Waker.wakeBatch` 把同 key 的 notifications 合成一个 prompt，并调用一次 `spawner.wake`（`cli/waker.mjs:337-360,517-551`）。批次大小与 turn-backed 项数是两个概念：

- `batchSize` 决定这是单项执行还是需要合成 session anchor 的批次；
- `coalescedCount` 只统计真正创建了 server pending turn 的事件。

合成控制事件 `resource_resumed` 没有 notification-backed pending turn，因此必须从 `coalescedCount` 排除（`cli/waker.mjs:363-382`）。否则服务端会多结算一个后到的真实 turn，造成静默丢工作。

单项 batch 保持原语义：自己的 entity 是 execution row，`coalescedCount = 1` 不上 wire。多项 batch 则合成一个以 direct idea 为 anchor 的 running execution，即使批次里的原始实体都是子 task（`cli/waker.mjs:397-405`）。

### 3.6 Cwd hard pin 与 resume

一个 daemon 可服务多个 cwd，但每个声明路径建立独立 connection、SSE listener、Waker、router、backfill 和 queue（`cli/daemon.mjs:158-165,205-220`）。server-side session 在创建时固定 `originConnectionUuid` 和 `directIdeaUuid`，后续 upsert 不改变它们（`src/services/daemon-session.service.ts:391-405`）。

在一次 wake 中，Waker 只解析一次 cwd；transcript probe 与 subprocess spawn 使用同一值（`cli/waker.mjs:454-478`）。若事件携带 directed `runtimeCwd`，它必须先通过 allowlisted directory validation。跨路径恢复不是“找另一个在线 connection 顶上”，而是拒绝错误位置或等待原位置恢复。这是 hard pin，而不是 placement preference。

这个约束牺牲了部分可用性，却保护了 repository 和 transcript 的一致性。对 coding agent 而言，“在错误目录成功运行”通常比“明确无法恢复”更危险。

### 3.7 Per-turn 生命周期与结算

subprocess 成功 spawn 时，`onChild` 把最老的同 session `pending` turn 推进为 `running`；subprocess 退出后再推进为 `ended` 或带原因的 `interrupted`（`cli/waker.mjs:502-538,610-627`）。服务端只允许：

```text
pending -> running -> ended
                   -> interrupted
```

`merged` 是 server-only terminal status，不在 daemon 可上报状态枚举中（`src/services/daemon-session.service.ts:60-80`）。

当 running edge 带 `coalescedCount = N` 时，`advanceTurnForWake`：

1. 找到同 session 最老的 pending turn 并推进为 running；
2. 在 `seq > runningTurn.seq` 范围内；
3. 按 seq 升序取接下来的 `N - 1` 个 pending turn；
4. 将它们更新为 `merged`。

实现位于 `src/services/daemon-session.service.ts:1763-1778,1831-1861`。`take: N - 1` 是并发安全边界：batch drain 后才到达的事件拥有更高 seq，但不会越过本批次计数被误结算。`merged` 不再满足 reconnect backfill 的 `status = pending` 过滤条件，因此不会重复派发。

### 3.8 两种收敛：执行快照与 Transcript

#### 3.8.1 Execution snapshot 收敛当前状态

router 在 enqueue 前为每个资源 `markQueued`。多项 batch 开始时，Waker 删除被 drain 的资源 execution entries，只保留一个 synthesized running anchor；批次结束后再从 active map 删除全部相关 entries（`cli/waker.mjs:389-450,674-690`）。

服务端把 daemon 上传的 executions 数组视为 connection 的**完整当前快照**：快照中存在的 active row 被 upsert，之前 active 但新快照缺失的 row 被置为 `ended`（`src/services/daemon-execution.service.ts:379-476`）。因此，被合并而未独立运行的 task 不会在 UI 中永久停留为 queued。

这解决的是 **live execution projection**，不是 turn history。

#### 3.8.2 Transcript channel 收敛历史

每个 session 有逻辑 channel `transcript:{sessionUuid}`，承载 `turn_created`、`turn_status_changed` 与 `transcript_appended`（`src/services/daemon-session.service.ts:354-386`）。`merged` settlement 使用 `updateMany`，不会自动经过普通状态转换发布逻辑，因此服务端为每个被结算 turn 显式发布 `turn_status_changed`（`src/services/daemon-session.service.ts:1862-1884`）。

浏览器端 `applyTranscriptEvent` 用该事件更新已有 turn 或按 seq 插入缺失 turn（`src/components/agent-presence/chat/daemon-chat.tsx:152-179`）；`groupMergedTurns` 再把连续的 merged turns 折叠到前一个 absorbing turn（`src/components/agent-presence/chat/transcript-view.tsx:68-93`）。

Waker 还在 terminal status 前等待 transcript buffer flush（`cli/waker.mjs:580-608`），避免最后一段 assistant reply 因 turn 已结束而无法附着。

### 3.9 三条实时流必须分开

“Chorus 使用 SSE”不足以描述架构。至少要区分三个语义通道：

1. **Daemon notification/control delivery**：长连接把 `new_notification`、`deliver_turn` 等信号送到本地 daemon，触发读取、定向判断与 wake。每个 cwd connection 有独立 listener（`cli/daemon.mjs:450-510`）。
2. **浏览器 realtime SSE**：`src/app/api/events/route.ts` 向 Web UI 推送 presence、execution 等实时变化，响应类型为 `text/event-stream`（`src/app/api/events/route.ts:79-92,212-218`）。
3. **Per-session transcript channel**：`transcript:{sessionUuid}` 是内部 pub/sub 与授权订阅域；浏览器打开会话时通过 `/api/events?sessionUuid=...` 把它复用到浏览器 SSE 连接上（`src/app/api/events/route.ts:62-77`）。

第三项在传输上可以 multiplex 到第二项的 HTTP SSE response，但在一致性域、授权范围和 payload 语义上仍是独立 channel。把三者混成“一条 SSE”会掩盖关键事实：daemon 是否收到 wake、UI 是否看到 execution、某个 session 的 transcript 是否收敛，是三个不同问题。

## 4. 设计深挖：五个一致性域

### 4.1 调度一致性：key 必须等于冲突域

串行 key 的设计原则不是“选一个方便的 UUID”，而是识别共享可变状态。对 Chorus 而言，共享状态是同一个 agent session transcript 与其工作目录，因此同 direct idea 的 task/comment 事件必须落到同 key。

若 key 过细，例如按 task UUID：

- task A 与 task B 可并发；
- 两者却恢复相同 direct idea session；
- 两个 subprocess 同时读取和追加同一 transcript；
- turn 顺序与输出归属不可预测。

若 key 过粗，例如按 agent UUID：

- 所有独立 idea 相互阻塞；
- 一个长 turn 会让整个 agent 失去并行能力；
- `maxConcurrency` 失去意义。

direct idea session key 是在“避免 session 冲突”和“保留跨工作流并行”之间的业务边界。

### 4.2 合并一致性：内容合并与账本合并必须同步

自然合并在本地只需要 drain array，但服务端已经为每个 wake 创建 pending turn。若只合并 prompt：

```text
本地：1 个 subprocess
服务端：N 个 pending turns，其中 N-1 永不开始
```

重连时，N-1 个 pending turns 会再次派发，造成重复工作。因此 `coalescedCount` 不是 UI 元数据，而是跨 daemon/server 的 reconciliation contract。

这个 contract 的安全性依赖四个条件：

1. queue 按 key 隔离；
2. queue drain 保持到达顺序；
3. server 对同 session 按到达顺序单调分配 `seq`；
4. daemon 上报的计数只包含 turn-backed 项。

只要其中一项不成立，`N - 1` 的窗口结算就可能 overreach 或 under-settle。

### 4.3 位置一致性：cwd 是会话身份的一部分

从纯服务端视角看，session 可以由 `(agentUuid, sessionId)` 唯一标识；从本地执行视角看，真正可恢复的实例更接近：

```text
(agent identity, session id, host, cwd, backend transcript store)
```

Chorus server 通过 origin connection 固定 host/cwd 归属，daemon 又让 transcript probe 和 spawn 使用同一 resolved cwd。这形成两侧约束：

- server 不把 active session 静默路由到另一 cwd；
- daemon 不在 probe 与 spawn 之间切换 cwd。

这不是完整的 distributed lease，但它消除了最危险的 silent drift。

### 4.4 生命周期一致性：运行边缘比“收到事件”更可信

turn 不应在事件入队时标为 running，因为它可能长时间等待全局槽位；也不应在调用 spawn 前标为 running，因为 executable resolution 或 spawn 可能失败。Chorus 把 running edge 挂在 `onChild`，该 callback 只在成功 spawn 后触发。

同理，turn terminal edge 不能早于 transcript flush。否则 UI 会得到一个已结束但缺少尾部回复的 turn。这里的顺序形成局部 write protocol：

```text
spawn success
  -> pending -> running
  -> stream transcript
  -> subprocess exit
  -> flush transcript
  -> running -> ended/interrupted
```

它仍不是数据库与本地进程之间的原子事务，但比“发起 spawn 即记成功”具有更准确的事实语义。

### 4.5 呈现一致性：当前状态与历史事实不可共用一个投影

execution snapshot 回答“现在有哪些实体 queued/running”；turn transcript 回答“这个 session 历史上经历了哪些工作单元与消息”。二者生命周期不同：

- execution row 可因新快照缺席而结束；
- turn row 必须持久保留，包括 `merged`、`interrupted` 和消息；
- execution 的 synthesized idea anchor 不必等于批次中任一 notification entity；
- transcript 仍需保留被吸收 turn 的存在，以解释多个输入为何由一次执行处理。

将两者分离，避免为了清理 stale queued UI 而删除审计历史，也避免为了保留历史而让 UI 永久显示过期 active state。

## 5. 诚实边界与局限

### 5.1 不宣称 exactly-once execution

Chorus 有进程内 dedup、持久 pending turn backfill 和 `merged` reconciliation，但这些机制不构成跨 notification DB、SSE、daemon queue、本地 subprocess 与 transcript DB 的单一事务。极端故障时仍可能出现“进程已产生外部副作用，但 terminal report 未到达”等经典不确定状态。

准确说法是：系统实现了**按 session 串行、可恢复派发与可解释重对账**，显著缩小重复与悬挂窗口；它不保证任意外部副作用 exactly once。真正需要 exactly-once 的动作仍应在 tool/API 层使用 idempotency key 或业务幂等设计。

### 5.2 Local queue 是内存态

`WakeQueue` 是 zero-dependency in-memory scheduler。daemon 进程退出后，尚未开始的本地 pending array 不会保留。恢复依赖服务端 pending turns 和 notifications，而不是恢复本地 batch 边界。因此崩溃前在同一 array 中的事件，重连后可能被重新分批；语义应要求“内容最终被处理”，不能依赖某个历史 batch 形状。

### 5.3 Natural coalescing 改变逐事件执行语义

合并意味着 N 个事件共享一个 prompt 和一个 subprocess。它适合“同一 session 的 backlog 应被当前 agent 一次理解”的场景，但不适合每个事件都要求独立隔离、独立失败或独立 side-effect transaction 的工作。Chorus 保留每个输入 turn 并标记 `merged`，但没有为批次内每个事件提供独立执行结果。

### 5.4 无 batch-size cap 带来输入膨胀风险

当前 drain 全部 pending items，不设条数或 token 上限。持续高流量下，合并 prompt 可能超过 backend context、增加 latency，甚至造成整个 batch 失败。无 cap 简化了“无遗漏”语义，却需要后续引入按 prompt budget 分片，而不能简单按条数截断。

### 5.5 Cwd hard pin 的代价是可用性

原 connection 离线时拒绝跨 cwd resume，意味着即使另一台机器或另一路径在线，也不能自动接手。这个选择对本地 coding state 是合理的，但尚未提供可验证的 workspace replication、git/worktree handoff 或 transcript migration 协议。hard pin 防止错误恢复，不等于已经解决高可用。

### 5.6 Transcript 是 best-effort 的 backend-normalized 视图

不同 agent backend 的流式消息和 usage 能力不同。即使 turn 状态正确，transcript 上传也可能失败；实现会把 `relayError` 附在 terminal turn 上，而不是假装“没有回复”。这提高了可解释性，但不能重建从未被 backend 暴露或从未成功上传的内容。

### 5.7 三类“孤儿/悬挂”问题不能混为一谈

本文链路中至少有三种不同修复：

- `coalescedCount` 把被吸收的 pending turns 结算为 `merged`；
- execution snapshot omission 把 UI 中不再 active 的 queued/running rows 结算为 `ended`；
- Pi extension 在 `subagent_spawn` 失败时关闭预先创建但未映射成功的 Chorus worker session（`packages/chorus-pi/extensions/chorus.ts:398-435`）。

第三项属于 Pi subagent lifecycle bookkeeping，不属于 daemon wake coalescing，也不能作为前两项的实现证据。类似地，daemon 断线后的 stale running-turn reconcile 是另一条 server backstop。用“orphan cleanup”笼统概括这些机制会掩盖不同的事实源、触发条件与恢复动作。

## 6. 评估与 Worked Example

### 6.1 可验证不变量

现有测试覆盖了以下关键不变量：

| 不变量 | 测试证据 |
|---|---|
| 同 key 的下一批必须等待当前批结束 | `cli/__tests__/wake-queue.test.mjs`，`WakeQueue same-key serialization` |
| 不同 key 可并发且不超过全局 cap | 同文件，`WakeQueue cross-key concurrency` |
| 忙时积压在槽释放后一次 drain，无 timer | 同文件，`WakeQueue coalescing` |
| N 条同 key notification 只 spawn 一个 subprocess | `cli/__tests__/wake-orchestration.test.mjs:599-755` |
| Router → Queue → Waker 的真实组合会合并 backlog | `cli/__tests__/wake-orchestration.test.mjs:1047-1102` |
| `coalescedCount=N` 只结算同 session 后续 `N-1` 条 | `src/services/__tests__/daemon-session.service.test.ts:2275-2402` |
| merged status 通过 transcript channel 实时收敛 | 同上，merged event assertions |
| session 不跨 cwd 静默恢复 | `src/services/__tests__/daemon-multipath-e2e.integration.test.ts:312-403` |

这些是机制测试，不是生产 SLO。它们证明代码路径遵守设计不变量，但没有给出事件丢失率、P99 wake latency、超大 batch 成功率或跨区域故障恢复时间。

### 6.2 三事件案例

设 direct idea `D` 对应 session key `idea:D`，全局并发上限为 4。

#### 阶段 A：首个事件立即运行

1. `E1 = task_assigned(A)` 到达。
2. server 创建 turn `T1(seq=10, pending)`。
3. router 解析 `A` 的 direct idea 为 `D`，执行 `markQueued`，enqueue 到 `idea:D`。
4. `D` 空闲，queue drain `[E1]`。
5. Waker 在 pinned cwd `/repo/x` probe session `D`，spawn 一个 subprocess。
6. `onChild` 推进 `T1: pending → running`。

#### 阶段 B：忙时积压

在 E1 对应 subprocess 运行期间：

1. `E2 = human_instruction("修复测试")` 到达，创建 `T2(seq=11, pending)`。
2. `E3 = mentioned(comment on task B)` 到达，创建 `T3(seq=12, pending)`。
3. 两者都解析到 `idea:D`。
4. queue 不启动新进程，只形成 `pending[D] = [E2, E3]`。

此时同一个 agent 的另一个 key `idea:X` 可以在全局 cap 尚有余量时并发运行；系统不是全局串行。

#### 阶段 C：自然合并

T1 结束并完成 transcript flush 后：

1. queue 释放 D 的槽位；
2. `splice(0)` 得到 `[E2, E3]`，没有等待 debounce；
3. `buildBatchPrompt` 保留两个事件的内容并加入 backlog preamble；
4. Waker 只 spawn/resume 一次 session D；
5. running edge 上报 `coalescedCount=2`。

服务端先推进最老 pending turn `T2 → running`，再选 `seq > 11` 的一个 pending turn，将 `T3 → merged`。这意味着：

```text
T1: ended
T2: running -> ended       # absorbing turn
T3: merged                 # 输入被 T2 的 subprocess 吸收
```

#### 阶段 D：双重收敛

- execution snapshot 在批次开始时删除 task A/B 等 queued projection，只显示一个 `idea:D running` anchor；
- snapshot 在结束时为空，服务端把 active row 结算为 ended；
- transcript channel 发布 T2 running、T3 merged、消息追加与 T2 ended；
- 浏览器把 T3 折叠显示在 T2 下，但不删除 T3 的历史存在。

#### 边界竞态

若 `E4` 在 `[E2,E3]` 已执行 `splice(0)` 后到达，它会得到更高 seq，并进入下一批。因为当前批只报告 `coalescedCount=2`，服务端 settlement 的 `take:1` 不会触及 E4 的 pending turn。这是 batch 边界与 seq window 对齐的关键。

### 6.3 建议的量化指标

要从机制验证走向生产评估，建议至少观测：

- `wake_delivery_to_spawn_latency_ms`：事件持久化到 `onChild` 的延迟；
- `same_key_queue_wait_ms`：同 key 排队时间；
- `coalesced_batch_size` 与合并后 prompt token 分布；
- `pending_turn_age_seconds` 与 reconnect backfill 数量；
- `turn_terminal_without_transcript_rate`，按 relay error 分类；
- `snapshot_stale_active_reconciled_total`；
- `cross_cwd_resume_refused_total`；
- 同 session 并发 subprocess 数，目标恒为 `<= 1`。

最后一项应作为 invariant alert，而不仅是 dashboard 曲线。

## 7. 讨论与 Roadmap

### 7.1 为 batch 引入预算，而不是简单上限

无界 drain 可演进为 budget-aware partition：

1. 保持 pending 到达顺序；
2. 估算每个事件序列化后的 token/byte cost；
3. 在 backend context budget 内取最大前缀；
4. 剩余项留给下一批；
5. `coalescedCount` 只报告当前前缀中 turn-backed 项。

这样既限制 prompt 膨胀，又不破坏 settlement window。简单“最多取 20 条”虽可用，但没有处理单条超大 instruction，也无法跨 backend 适配。

### 7.2 把恢复语义显式化

当前 pending backfill 已提供 durable recovery net，下一步可为每个 turn 记录 dispatch attempt、connection epoch 和 batch identifier。它们不应被用来假装 exactly once，而应帮助回答：

- turn 是否曾被某个 daemon 接受？
- 是否成功 spawn？
- 哪些 turns 被同一 batch 吸收？
- daemon 崩溃发生在 spawn 前、运行中，还是 terminal report 后？

显式 attempt 模型还可支持 operator 选择“重试”“标记未知结果”或“人工核对副作用”。

### 7.3 Cwd pin 之上的可验证迁移

未来若要支持跨 host/cwd 接管，不能取消 hard pin 后任意 fallback，而应引入迁移协议：

- repository commit/worktree identity 校验；
- dirty state 与未提交 patch 的可传输 artifact；
- backend transcript export/import 或兼容性声明；
- secrets、tool permissions 和 environment fingerprint 对比；
- 原 connection fencing，防止双写；
- 人工或 policy 授权的 migration record。

只有这些 precondition 成立，hard pin 才能安全升级为 controlled relocation。

### 7.4 从测试不变量到故障注入

现有单元与 integration tests 已覆盖逻辑边界。进一步评估应加入：

- notification 写入后、SSE emit 前 server crash；
- daemon drain 后、spawn 前 crash；
- subprocess 已产生 git/network side effect，但 terminal report 丢失；
- transcript 最后一批上传超时；
- Redis pub/sub 短暂不可用；
- daemon reconnect 与 live event 同时到达；
- 超大 backlog 与 backend context overflow。

故障注入的目标不是证明“不会失败”，而是确认每个失败都落入可解释状态，且 operator 能识别是否可安全重试。

### 7.5 跨 backend 的 turn contract

Chorus 已把 queue、waker、turn lifecycle 与 transcript hooks 放在 backend adapter 之上。未来应把 adapter conformance 固化为测试契约：

- spawn 成功时恰好调用一次 `onChild`；
- spawn 失败不得伪造 running edge；
- probe 与 spawn 使用同一 cwd；
- result 必须给出可分类 exit outcome；
- transcript flush 的完成与错误可观察；
- backend session id 与 Chorus session business key 的关系明确。

可靠 turn 的上层语义只有在每个 backend 都满足这些最小条件时才真正可移植。

## 8. 结论

Chorus 展示了一种比“收到通知后执行 CLI”更严格的 agent harness 设计。它把可靠 turn 分解为相互对齐的协议：

- 以 session 冲突域选择 key；
- 同 key 串行，不同 key 在全局 cap 内并发；
- 以槽释放而非 timer 实现自然合并；
- 一个 batch 只启动一个 subprocess；
- 在同一 pinned cwd 中 probe 与 resume；
- 用 `coalescedCount` 让持久 turn ledger 与本地 batch 对账；
- 用 snapshot omission 清理 stale active projection；
- 用 per-session transcript channel 收敛持久历史和 merged UX。

最重要的工程经验不是某个类或字段，而是不要让一个模糊的“消息已处理”状态承担所有语义。通知投递、队列接纳、进程启动、turn 结算、execution projection 和 transcript history 是不同事实。把它们分开记录，再用明确的边缘和重对账协议连接，才能让长运行 agent 在正常路径和故障路径上都可恢复、可归因、可解释。

与此同时，本文不把这些机制包装成 exactly-once。可靠性来自边界清晰、状态可见和恢复可推理，而不是消除所有不确定性。对 2026 年的 agent harness 而言，这种诚实的系统语义比“自动运行”本身更重要。

## 参考文献

1. Bits & Bytes. “From Prompts to Harnesses — Four Years of AI Agentic Patterns.” 2026. <https://bits-bytes-nn.github.io/insights/agentic-ai/2026/04/05/evolution-of-ai-agentic-patterns-en.html>
2. MDN Web Docs. “Using server-sent events.” <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>
3. Node.js Documentation. “Child process.” <https://nodejs.org/api/child_process.html>
4. Chris Richardson. “Pattern: Idempotent Consumer.” <https://microservices.io/patterns/communication-style/idempotent-consumer.html>
5. Chorus repository. `docs/DAEMON.md`, daemon operation and lifecycle reference. <https://github.com/Chorus-AIDLC/Chorus/blob/develop/docs/DAEMON.md>
6. Chorus repository. `cli/wake-queue.mjs`, per-key scheduler and natural coalescing. <https://github.com/Chorus-AIDLC/Chorus/blob/develop/cli/wake-queue.mjs>
7. Chorus repository. `cli/waker.mjs`, batch execution, cwd binding, turn reporting, and transcript flush. <https://github.com/Chorus-AIDLC/Chorus/blob/develop/cli/waker.mjs>
8. Chorus repository. `src/services/daemon-session.service.ts`, durable turn lifecycle and merged settlement. <https://github.com/Chorus-AIDLC/Chorus/blob/develop/src/services/daemon-session.service.ts>
9. Chorus repository. `src/services/daemon-execution.service.ts`, snapshot-authoritative execution reconciliation. <https://github.com/Chorus-AIDLC/Chorus/blob/develop/src/services/daemon-execution.service.ts>
