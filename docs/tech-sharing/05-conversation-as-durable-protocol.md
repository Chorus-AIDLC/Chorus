# 对话即持久化协议：没有终端以后，Agent 如何继续协作

## Conversation as a Durable Protocol: Collaboration After the Terminal Disappears

> 本文源码基线：`docs/tech-sharing` 分支，2026-08-16。源码位置以符号名为准，行号用于帮助定位。

## 摘要

交互式 coding assistant 可以把对话暂时放在终端 scrollback 和模型上下文中；headless Agent 不行。当提出问题、等待人类回答、被 `@mention` 唤醒、执行一个 turn、进程退出和下一次继续之间可能相隔数小时，conversation 必须从瞬时 chat 变成持久化协议。本文以 Chorus 为案例，研究这套协议的 schema 与 lifecycle：`ElaborationRound`/`ElaborationQuestion` 将澄清过程结构化；Comment、Mention 与 Notification 将异步 request-reply 绑定到业务实体和参与者；DaemonSession、Turn 与 TranscriptMessage 保存执行会话、触发原因、状态和受限文本轨迹；Activity 记录业务动作及可选 session attribution。它们共同让不同时间、不同进程中的人和 Agent 从 authoritative state 继续工作，而不是依赖某个终端仍然打开。本文也严格限定“可重放”：Chorus 可以重新读取状态、问题、答案、通知、turn 与保留的文本消息，但 transcript 是经过过滤、裁剪和 runtime-specific reconstruction 的观测记录，不是字节级日志，也不能确定性重演模型与工具副作用。`@mention` 对离线 Agent 只留下通知而不立即唤醒；elaboration `resolved` 只证明结构流程完成，不证明答案在语义上正确。

## Abstract

An interactive coding assistant can temporarily keep a conversation in terminal scrollback and model context. A headless agent cannot. Asking a question, waiting for a human answer, receiving an `@mention`, running a turn, exiting, and continuing may be separated by hours and different processes. Conversation must therefore become a durable protocol rather than ephemeral chat. This paper studies that protocol in Chorus. `ElaborationRound` and `ElaborationQuestion` structure requirements clarification; Comment, Mention, and Notification bind asynchronous request-reply exchanges to business entities and participants; DaemonSession, Turn, and TranscriptMessage preserve execution identity, triggers, lifecycle, and a bounded text trace; Activity records business actions with optional session attribution. Together, these objects allow humans and agents to resume from authoritative state instead of depending on an open terminal. We also bound the word “replayable.” Chorus can reread states, questions, answers, notifications, turns, and retained text messages, but its transcript is a filtered, trimmed, runtime-specific reconstruction. It is neither a byte-exact log nor a deterministic replay of model behavior and tool side effects. An `@mention` of an offline agent creates a notification but no immediate wake, and an elaboration marked `resolved` proves structural completion rather than semantic correctness.

---

## 1. 问题：终端消失后，对话还剩什么

### 1.1 瞬时 chat 的隐含前提

传统终端对话依赖几个很少被写出来的前提：

1. 人和 Agent 同时在线；
2. 进程在等待期间不会退出；
3. scrollback 足以保存上下文；
4. 下一条消息天然属于当前会话；
5. “谁说了什么、针对哪个对象”可以从屏幕位置推断；
6. 问题被回答后，当前进程仍在场并能继续。

headless daemon 逐一打破这些前提。Agent 提问后应结束 turn，让人稍后在 UI 回答；人可能在 Task 评论中要求修改，而 Agent 的下一个进程由一条通知重新启动；一次运行结束后，另一次运行需要知道它是被 assignment、mention 还是 human instruction 触发。若这些事实只存在于 prompt 和 stdout，进程退出就等于协议状态丢失。

### 1.2 本文主张

本文把 conversation 定义为一组可持久化的协议对象，而不是一个无限增长的字符串：

```text
requirements dialogue:
  ElaborationRound -> ElaborationQuestion -> Answer -> resolve

asynchronous handoff:
  Comment -> Mention -> Notification -> optional DaemonSessionTurn

execution conversation:
  DaemonSession -> ordered Turns -> bounded TranscriptMessages

attribution:
  Activity(actor, target, action, value, optional session)
```

协议化的关键不是“保存更多聊天”，而是把恢复工作所需的最小事实写成有 identity、state、actor、target、ordering 和 timestamps 的对象。

### 1.3 与第 4 篇的边界

第 4 篇讨论谁能让 Proposal/Task 越过高影响状态边界；本文讨论没有同步终端时，一次 request、answer、handoff 和 execution trace 如何跨进程存活。Approval policy 可以使用本文的通信载体，但 authorization 不是本文的研究对象。

同样，第 1 篇已经分析 turn queue、natural coalescing、三类 transcript SSE trigger 与 orphan reconciliation。本文只引用这些执行机制，重点放在它们承载的 conversation schema，不重新证明调度可靠性。

---

## 2. 背景：durability、event history 与 attribution

### 2.1 Durable execution 的启发与差异

Temporal 将 durable execution 描述为在 crash、network failure 或 outage 后仍可从持久 event history 恢复 workflow progress [1]。这提供了一个重要启发：长生命周期协作不应依赖单个进程内存。

但 Chorus conversation 不是 Temporal workflow，也不声称 deterministic replay。它保存业务对象和观测轨迹，下一位 Agent 重新读取后作新的推理；模型采样、外部 API、shell、filesystem 与 Git 副作用不会通过 transcript 自动重演。

### 2.2 Event sourcing 不是“存了事件”

Event Sourcing 以事件序列重建应用状态 [2]。Chorus 的 Activity、Notification 和 Turn 都带有事件味道，但数据库中的 Proposal、Idea、Elaboration 与 Task row 仍是 authoritative current state。Activity 是审计与展示记录，不是重建所有 aggregate 的唯一 source of truth。

因此本文使用“可重放”时区分三种能力：

| 能力 | Chorus 当前含义 |
|---|---|
| State replay | 重新读取当前实体、round、question、answer 和 status |
| Conversation replay | 按序展示保留的 turn 与 user/assistant 文本 |
| Execution replay | 用相同输入确定性重做模型、工具与外部副作用 |

前两项部分实现；第三项没有实现。

### 2.3 Attribution 是协议字段，不是日志猜测

W3C Trace Context 用显式 trace/parent 标识跨进程传播请求上下文 [3]。Chorus 没有把 Activity 当作 distributed trace，但原则相同：跨异步边界的归因必须成为数据，而不是事后从时间戳猜测。

Chorus 在不同对象上分别保存：

- question 的 `answeredByType` / `answeredByUuid`；
- comment 的 `authorType` / `authorUuid`；
- mention 的 actor 与 mentioned principal；
- notification 的 actor、recipient 与 entity；
- turn 的 trigger、session 与 sequence；
- Activity 的 actor、target，以及可选 `sessionUuid` / `sessionName`。

这些字段让“谁、针对什么、在哪个协作上下文中做了什么”可查询。

---

## 3. 协议层一：结构化 requirements dialogue

### 3.1 Round 与 Question 是 durable schema

`ElaborationRound` 保存 Idea、round number、状态、创建者和时间；`ElaborationQuestion` 保存 round-scoped `questionId`、文本、category、2–5 个 options、required flag、answer、answerer 与 validation issue（`prisma/schema.prisma:879-922`）。

主要状态路径是：

```text
Round:
pending_answers --all required answered--> answered

Idea elaboration:
pending_answers -> validating -> resolved
```

这比把一组问题塞进评论更强，因为系统可以机械判断：

- 问题属于哪一轮；
- 哪些 required question 尚未回答；
- answer 是 option 还是 custom text；
- 谁在何时回答；
- 是否存在多个 active round；
- Idea 是否满足 resolve 的结构前置条件。

### 3.2 Start：先验证 schema，再发布问题

`startElaboration` 先运行 question format validation，再检查 Idea、assignee 与状态；每个 Idea 最多 10 轮。随后创建 Round 与 Questions，并把非 appended Idea 的 `elaborationStatus` 写为 `pending_answers`，最后记录 `elaboration_started` Activity（`src/services/elaboration.service.ts:44-158`）。

这一步相当于持久化一个 request。Agent 无需停在终端等待；问题已经成为人类可以稍后读取和提交的协议对象。

### 3.3 Answer：回答是带身份的状态转换

`answerElaboration` 在省略 round UUID 时只允许自动定位唯一 active round；零个或多个 active round 都明确报错。每个 answer 必须引用本 round 的 question，且满足“有效 option”或“非空 custom text”之一。保存 answer 时同时记录 `answeredAt`、`answeredByType` 与 `answeredByUuid`（`src/services/elaboration.service.ts:163-243`）。

只有全部 required question 都有 `answeredAt`，Round 才从 `pending_answers` 进入 `answered`；服务同时记录 `elaboration_answered` Activity（同文件 `245-297`）。这使 answer 不只是文字，而是可归因、可校验的 protocol transition。

### 3.4 Resolve：结构完成，不是语义证明

`resolveElaboration` 要求至少一轮，且不存在 `pending_answers` round，之后才把 Idea 写为 `elaborated` / `resolved`（`src/services/elaboration.service.ts:300-360`）。Human verify path 使用相同结构前置条件，但不要求 verifier 是 assignee（同文件 `363-437`）。

这个 gate 证明：

- 至少发生过一轮结构化澄清；
- 所有 required questions 都被回答；
- resolution 有 actor 与 activity。

它不证明：

- 问题覆盖了真实需求；
- 选项设计没有诱导；
- 回答彼此一致；
- Agent 正确理解了 custom text；
- 后续 Proposal 忠实反映答案。

所以 `resolved` 是 protocol completeness，不是 semantic correctness。

### 3.5 为什么 headless 环境不能使用阻塞式提问

headless 进程背后没有正在等待的 terminal user。调用交互式 prompt 会挂起或丢失，而 Elaboration 把 request 写入数据库、让当前 turn 结束，再由人通过 UI 回答。`elaboration_answered` notification 可以启动新的 Agent turn 去审查答案。

这里的核心模式是：

```text
agent persists questions -> process exits
human persists answers   -> notification
new agent turn rereads authoritative round -> continues
```

continuity 来自 schema，不来自进程寿命。

---

## 4. 协议层二：Comment、Mention 与 Notification

### 4.1 Comment 绑定业务上下文

Comment row 保存 target type/UUID、content、author 与 timestamps，可附着到 Idea、Proposal、Task 或 Document（`prisma/schema.prisma:369-385`）。读取按 target scoped、新到旧分页；创建前验证 target 存在（`src/services/comment.service.ts:110-230`）。

因此一句“请补 migration rollback test”不是游离 chat：它可以永久绑定到具体 Task，并由之后的进程重新读取。

### 4.2 Mention 把自然语言 handoff 编译成路由信息

Chorus 使用显式 token：

```text
@[DisplayName](user:uuid)
@[DisplayName](agent:uuid)
```

parser 去重、最多接受 10 个 mention，并可携带 host/cwd pin。`createMentions` 过滤 self-mention、验证目标属于同 company，再写 Mention rows（`src/services/mention.service.ts:328-427`）。

Mention model 同时保存 source、mentioned principal 与 actor（`prisma/schema.prisma:858-877`）。这使 handoff 具有两个方向：

- source 指向 request 出现在哪里；
- mentioned principal 指向谁应接手。

### 4.3 Notification 是 inbox record

对每个允许 `mentioned` notification 的有效目标，service 创建 Notification，包含 recipient、entity、action、message、actor 与 read/archive state（`src/services/mention.service.ts:439-543`；`prisma/schema.prisma:772-800`）。

Notification 与 wake 不能混为一谈：

- Notification 是持久 inbox record；
- SSE 是低延迟 delivery signal；
- DaemonSessionTurn 是一次实际可执行 wake 的持久工作记录。

`notification.service.createReturningTurn` 先写 Notification，再尝试通过 wake-turn bridge 创建 Turn，最后发 SSE；bridge failure 不回滚已经写入的 Notification（`src/services/notification.service.ts:226-324`）。

### 4.4 在线目标：request 变成新的 Turn

对 wake-triggering action 和 Agent recipient，`createTurnAndResolveTarget` 解析目标 connection、conversation anchor 与 cwd，然后创建或复用 DaemonSession，并创建 `pending` Turn。`mentioned` 映射为独立 trigger；elaboration request/answer 映射为 `elaboration`（`src/services/notification-turn.ts:75-125,730-778`）。

新进程收到的不是原 terminal stack，而是：

1. Notification 提供 actor、entity 与 message；
2. Turn 提供 trigger、session 与 sequence；
3. MCP read 重新取得完整 Comment、Idea、Task 或 Elaboration；
4. Agent 完成后再写 Comment 并 `@mention` 请求者。

这形成异步 request-reply loop：

```text
Comment A + @Agent
  -> Mention + Notification + Turn
  -> Agent rereads entity and acts
  -> Comment B + @Requester
  -> Mention + Notification (+ optional human/agent follow-up)
```

系统当前没有一等 `replyToCommentUuid` 或 correlation ID；loop 的关联主要来自共同 target、source UUID、actor/recipient 和文本约定。

### 4.5 离线目标：有 inbox，不保证立即 wake

只有 online connection 可被唤醒。目标 Agent 完全离线，或一个 hard-pinned host/cwd 不在线时，不创建 Turn、不发 directed ping，也不改投其他目录；已经创建的 Notification 保留为 notify-only record（`src/services/notification-turn.ts:15-42,570-647,883-900`）。

这是一条重要诚实边界：

> `@mention` durable 不等于 wake durable。

请求不会因 terminal 消失而完全没有记录，但离线时没有一个 `pending` Turn 保证自动执行。后续能否被处理取决于 notification retrieval、重新唤醒或人工 handoff；系统不能声称 offline mention 已进入可靠执行队列。

### 4.6 Comment 成功也不等于 Mention side effects 成功

`createComment` 先持久化 Comment，再以 fire-and-forget 方式处理 mentions；解析或通知失败会记录 error，但不会回滚 Comment（`src/services/comment.service.ts:196-258`）。

这选择了“保留原始发言”而不是跨 Comment/Mention/Notification 的原子事务。好处是评论不因通知系统暂时失败而丢失；代价是调用者不能把 Comment create success 解释为 recipient 已收到或已被唤醒。

---

## 5. 协议层三：Daemon conversation

### 5.1 Session 与 Turn 分离 identity 和 execution

`DaemonSession` 是 `(agentUuid, sessionId)` 唯一的 durable conversation；idea-anchored session 通常以 direct Idea UUID 为 business key。它保存 backend resume identity、origin connection、runtime cwd、status 与 last-turn time，即使 connection offline 或 daemon restart 也不因断线删除（`prisma/schema.prisma:657-707`）。

`DaemonSessionTurn` 表示一次 wake，具有 session-local monotonic `seq`、trigger、status、时间和可选 instruction text（同文件 `709-753`）。创建使用 unique `(sessionUuid, seq)` 作为并发 backstop（`src/services/daemon-session.service.ts:465-570`）。

分离后的语义是：

- Session 回答“这是哪段连续 conversation”；
- Turn 回答“哪次外部 request 触发了哪次 execution”。

### 5.2 Turn lifecycle 让沉默与失败可区分

正常 lifecycle 是：

```text
pending -> running -> ended
                   \-> interrupted(reason)
```

`advanceTurn` 拒绝 skip、backward edge、terminal re-entry 和重复 transition，并记录 started/ended time、interrupt reason、relay error 与 usage（`src/services/daemon-session.service.ts:602-769`）。

这让查看者能区分：

- request 尚未开始；
- Agent 正在执行；
- subprocess 正常结束但没有保留文本；
- execution 被 user/crash/shutdown/offline 中断；
- reply 产生了，但 transcript relay 最终失败。

状态本身也是 conversation：它表达“对方是否已经接住 request”。

### 5.3 Transcript 是 bounded text projection

`DaemonTranscriptMessage` 只保存 `user | assistant`、plain text、turn-local sequence 与 timestamp。tool calls、tool results 和 thinking 不存储（`prisma/schema.prisma:755-770`）。

ingest 使用 append semantics，并在 service boundary 再次过滤 role 与 blank text。每个 session 最多保留 200 条 message，超过后删除最旧消息；成功 append 后发 `transcript_appended` event（`src/services/daemon-session.service.ts:1370-1453,1455-1644`）。

这个选择控制隐私与存储，也使 transcript 适合人类阅读；但它主动牺牲了完整性。一个旧 Turn 仍可能存在，而其 message 已被 rolling window 裁掉。

### 5.4 Transcript 是 reconstruction，不是 byte replay

Claude/Codex/Kiro 的 runtime 输出格式不同。daemon upload hook 从 stream 中提取可显示文本并批量上传；Kiro 在可读取 session store 时重建 transcript，headless mode 无持久 session 时会退化到 raw stdout fallback（`cli/kiro-spawner.mjs:219-237,340-379`）。

因此同一页面里的“assistant text”可能来自：

- runtime structured event；
- on-disk transcript reconstruction；
- raw stdout fallback；
- synthetic display of persisted `human_instruction` prompt。

这些 source 足以提供 operational visibility，却不保证 byte-for-byte 等于 terminal，也不包含完整 tool trace。Chorus 保存的是跨 runtime 的最小可读 projection。

### 5.5 Read visibility 也是协议边界

Agent key 只能读取自己的 sessions；human user 只能读取自己所拥有 Agent 的 sessions，所有查询同时 company-scoped。不可见、跨 company 与不存在统一返回 negative verdict，避免通过 transcript API 探测其他会话（`src/services/daemon-session.service.ts:934-1020`）。

Durability 不意味着全局可见。谁能重放哪段 conversation 是数据治理的一部分。

---

## 6. Activity：把业务动作归因到执行上下文

### 6.1 Activity 的最小字段

Activity 保存 project、target、actor、action、value、timestamp，以及可选 `sessionUuid` / `sessionName`（`prisma/schema.prisma:411-435`）。service 在 create/list response 中保留 session attribution（`src/services/activity.service.ts:20-45,47-158`）。

它适合回答：

- 哪个 actor 修改了哪个业务实体？
- 是 assign、answer、mention、approve 还是 submit？
- action 携带了什么结构化 value？
- 若调用方提供 session attribution，它属于哪个 worker session？

### 6.2 两种 session 不应混淆

当前代码同时存在：

- `AgentSession`：swarm/worker check-in attribution；
- `DaemonSession`：headless conversation 与 turn history。

Activity 的 `sessionUuid/sessionName` 最初面向 AgentSession，不是每条 daemon Activity 都自动关联 DaemonSessionTurn。本文因此不声称 Activity 已形成从所有业务 mutation 到 daemon turn 的完整 distributed trace。

更准确的说法是：schema 已支持可选 session attribution，部分工作流写入它；daemon turn 则以自身 session/turn foreign-key path 提供 execution history。两条轨迹可以人工关联，但尚无统一 correlation model。

### 6.3 Audit trail 的组合读取

一次完整 handoff 可能需要组合四类 read：

| 问题 | Authoritative source |
|---|---|
| 人问了什么 | Comment / ElaborationQuestion |
| 谁被要求响应 | Mention / Notification recipient |
| Agent 是否启动及如何结束 | DaemonSessionTurn |
| 业务对象发生了什么变化 | Entity current state + Activity |

没有单张表是“完整 conversation”。协议的价值来自明确分工和稳定 join keys，而不是制造一个包含所有内容的 giant chat log。

---

## 7. Worked Example、可核验边界与演进

### 7.1 无人值守的需求澄清

设 PM Agent 要澄清“订单风险等级”：

| 时间 | 主体 | 持久化动作 | 进程状态 |
|---|---|---|---|
| T1 | Agent | 创建 Round 1 与 3 个 Questions | Agent turn 可结束 |
| T2 | Human | 回答 options/custom text | 无 Agent 进程也可完成 |
| T3 | System | Round -> answered；Notification `elaboration_answered` | 在线时创建 pending Turn |
| T4 | Agent | 新进程读取整个 Elaboration | 不依赖旧 stdout |
| T5 | Agent | 发现矛盾，创建 Round 2 | 再次结束等待 |
| T6 | Human | 回答 Round 2 | answer 带 actor/time |
| T7 | Agent/human | resolve/verify Elaboration | 只证明结构完成 |
| T8 | Agent | 写理解摘要 Comment，`@mention` requester | 建立异步确认 loop |
| T9 | Human | 回复确认 | Proposal 可引用 authoritative answers |

恢复所需的信息分别来自 Round/Question、Notification、Turn、Comment 与 Activity。即使 T1、T4、T8 是三个不同 subprocess，workflow 仍可继续。

#### 7.1.1 失败路径

**Agent 在 T3 离线：** Elaboration answer 与 Notification 仍存在，但不创建可执行 Turn。系统不能说 Agent 已接单；需要之后读取通知或重新 handoff。

**Transcript upload 失败：** Turn 可以正常 `ended` 并携带 `relayError`。业务 Comment 或 Elaboration mutation若已写入，仍是 authoritative artifact；UI 应显示“reply 未上传”，而不是伪造空 reply。

**答案语义有误：** Round 仍可能 `answered/resolved`。正确恢复方式是追加 round 或在 Proposal review 中指出问题，而不是把 structural status 当作 truth。

**旧 transcript 被裁剪：** Turn metadata 仍在，message 可能为空。关键决定应写入 Comment、Document、Elaboration 或 Task evidence，而不应只留在 daemon chat。

---

### 7.2 可核验性质与局限

#### 7.2.1 当前可以机械核验

1. Elaboration questions/options/answers/answerers 被结构化保存；
2. required questions 未全部回答时不能 resolve；
3. Comment 持久绑定业务 target 与 author；
4. Mention 保存 source、actor 与 recipient；
5. Notification 保存 inbox record、read state 与 entity context；
6. online wake 可映射为有 trigger/seq/status 的 Turn；
7. Turn 只允许合法 forward lifecycle；
8. transcript append 只保存非空 user/assistant text；
9. session transcript retention 被限制为 200 messages；
10. transcript/session read 受 company 与 owner/self scope 约束。

#### 7.2.2 当前不能机械保证

1. 每条 Comment mention 都成功创建 Notification，因为 side effects 是 fire-and-forget；
2. 离线 mentioned Agent 最终一定被自动唤醒；
3. `resolved` elaboration 的内容在语义上正确；
4. transcript 包含全部 terminal bytes、tool calls、thinking 与外部副作用；
5. 重读 transcript 会产生与原执行相同的模型输出；
6. 每条 Activity 都关联到唯一 DaemonSessionTurn；
7. Comment B 是 Comment A 的正式 reply，因为缺少一等 reply/correlation edge；
8. Notification delivered 表示 recipient 已理解或处理。

#### 7.2.3 与第 1 篇共享但不重复的执行边界

turn coalescing、SSE reconnect、pending-turn recovery 与 orphan reconciliation 决定 transport/execution reliability。它们不能改变本文的 schema truth：

- 合并 wake 不应合并或删除业务 Comments；
- orphan reconcile 不补全丢失 transcript；
- SSE delivery 不替代 Notification row；
- reliable Turn 不证明 elaboration answer 正确。

---

### 7.3 Roadmap：从持久记录到完整协议

#### 7.3.1 一等 request-reply correlation

可为 Comment/Notification 增加：

```text
conversationUuid
requestUuid
replyToUuid
expectedResponderType / expectedResponderUuid
requestStatus: open | acknowledged | answered | closed
```

这样系统无需从共同 target 和 mention 文本推断哪个 reply 回答哪个 request。

#### 7.3.2 Delivery 与 acknowledgement 分离

建议区分：

- notification persisted；
- delivery attempted；
- daemon turn created；
- recipient acknowledged；
- response artifact produced；
- requester closed loop。

当前 Notification `readAt` 只能说明读取，不等于 Agent 已开始或完成 request。

#### 7.3.3 Transcript provenance

每条 message 或每个 turn 可增加：

```text
captureSource: structured_stream | session_store | raw_stdout | synthetic
backend / backendVersion
complete: boolean
redactionPolicyVersion
```

这能让 viewer 与评估程序知道一段 transcript 的 fidelity，而不是把不同 runtime reconstruction 当成同质数据。

#### 7.3.4 统一 correlation

Activity、Notification、Turn 与业务 mutation 可共享一个 correlation ID，并记录 causation chain：

```text
comment -> mention -> notification -> turn -> activity -> reply comment
```

这不是要求把所有对象合并，而是让跨对象因果关系可查询。

#### 7.3.5 Protocol conformance tests

跨 runtime 测试应验证：

1. 相同 request 产生相同的 persisted protocol objects；
2. offline case 明确 notify-only；
3. restart 后可从 schema 继续；
4. transcript degradation 被标注；
5. actor、target、session 与 causation 不丢失；
6. critical decision 不只存在于 transient transcript。

目标不是让五种 runtime 输出相同 bytes，而是让它们满足相同 durable conversation contract。

---

## 8. 结论

headless Agent 把 conversation engineering 从 UI 问题变成协议问题。终端关闭后仍需保存的不是全部 token，而是 request、answer、actor、target、state、ordering、delivery intent、execution outcome 和 durable artifact。

Chorus 用 Elaboration 保存结构化澄清，用 Comment/Mention/Notification 保存异步 handoff，用 DaemonSession/Turn/Transcript 保存受限执行轨迹，用 Activity 保存业务归因。这套组合已经允许人和 Agent 跨时间、跨进程继续协作，并清楚区分 inbox、wake、execution 和 business state。

它仍不是完整 replay system：离线 mention 不保证 wake，Comment 到 Notification 不是原子事务，transcript 会过滤、裁剪并按 runtime 重建，Activity 与 daemon turn 也没有统一 correlation。最稳妥的工程原则因此是：

> 把关键意图和决定写入业务协议对象，把 transcript 当作有边界的观测证据；让进程可以消失，但不要让 workflow state 随它消失。

---

## 参考文献

1. Temporal, “Temporal Platform: Durable Execution.” https://docs.temporal.io/temporal
2. Martin Fowler, “Event Sourcing.” https://martinfowler.com/eaaDev/EventSourcing.html
3. W3C, “Trace Context.” https://www.w3.org/TR/trace-context/
4. Chorus, `docs/tech-sharing/01-reliable-agent-turn.md`, turn scheduling, coalescing, SSE, and recovery.
5. Chorus, `docs/tech-sharing/02-portability-is-semantics.md`, runtime-specific transcript fidelity.
6. Chorus, `src/services/elaboration.service.ts`, structured clarification lifecycle.
7. Chorus, `src/services/comment.service.ts` and `src/services/mention.service.ts`, asynchronous handoff.
8. Chorus, `src/services/notification.service.ts` and `src/services/notification-turn.ts`, inbox-to-wake bridge.
9. Chorus, `src/services/daemon-session.service.ts`, durable sessions, turns, and bounded transcript.
10. Chorus, `src/services/activity.service.ts`, business action attribution.
