## Context

已验证需求：创建 Idea（普通与主题分解）和 Research 使用专用事件，提交后不自动打开执行会话，保留旧 CLI 执行路径。Research 已完成一次有界调查，本阶段复用证据，进一步读取本地模块核对设计契约。

当前创建服务原子写入 Idea/session/首轮，Research 服务事务内校验资格并写入 turn/notification；两者提交后发 origin-only `deliver_turn`。`cli/event-router.mjs` 的 pending-turn 分支从 `human_instruction.promptText` 恢复执行，Research 前缀决定隔离入队。`daemon-session.service.ts` 多处按该前缀隔离 FIFO、检查资格及准入，不能只改生产者。

前端 `new-idea-dialog.tsx` 的 `onStarted` 和 `research-action.tsx` 的成功分支调用 `openChatForSession`。现有 conversational-idea-entry 规格包含自动 handoff 要求，需要随实现替换；保留手动打开逻辑及其它调用者。

## Goals and non-goals

目标是让操作意图稳定贯通存储、实时、恢复、执行和展示，同时延续原有授权与客户端兼容。协议必须可通过模拟旧客户端和真实数据库验证。

不更换 SSE transport，不新增调度器，不扩大 Research 到开发，不移除已有会话历史，不改变 Yolo 或普通人工指令。无需新的页面、输入控件或视觉风格。

## Decisions and module contracts

### 1. Canonical operation record

`DaemonSessionTurn.trigger` 增加 `idea_creation_requested` 和 `research_requested`。新增可空 `operationPayload Json?`，迁移只增加列，历史行保持原值；旧 `promptText` 保留为服务器生成的兼容指令快照和人类可读上下文。

操作载荷采用判别联合：

```ts
type OperationPayload =
  | { version: 1; kind: "idea_creation"; ideaUuid: string;
      projectUuid: string; mode: "elaborate" | "decompose";
      researchFirst: boolean; descriptionText: string }
  | { version: 1; kind: "research"; ideaUuid: string };
```

trigger 与 kind 必须匹配；所有字段在服务层校验。载荷中的 Idea 必须等于所属 session.directIdeaUuid，项目必须匹配 Idea，公司/agent/connection 以已授权 session 为准，不能由载荷覆盖。请求者身份沿用现有审计字段，cwd 与 origin 沿用 session，避免重复保存互相矛盾的路由信息。

创建服务在同一事务写入 Idea（用户原文）、根 session、专用首轮和载荷。保留 3000 字描述预算、项目标签限长、mode 和 researchFirst 语义。Research 在当前事务内写入专用 turn 和对应 notification；每次点击仍生成独立 turn，不用正文相等作幂等键。

创建与 Research 的通知/日志使用专用操作标签。Research 保留一条审计通知；创建入口继续以 turn 为执行源，不额外生成会触发 assignment wake 的活动。若共享 action→trigger 映射需注册新值，必须标为已持久化、仅由 turn 投递，不能让 notification chokepoint 再写一个 turn。

### 2. Delivery is a projection of one turn

保留现有 `deliver_turn` 控制消息（connectionUuid + turnUuid + runtimeCwd），此消息只是定向交付提示。实时控制路径读取指定 turn，重连读取该 origin 的 pending turns；都从同一数据库记录构建上下文，不依赖未读通知。

`GET /api/daemon/pending-turns` 增加 `operationProtocol=1`，未知值按缺省兼容处理：

| 客户端能力 | pending-turns 响应 | 执行/确认 |
| --- | --- | --- |
| operationProtocol=1 | 规范 trigger + operationPayload + promptText + 原 turn/session/cwd 字段 | 专用路由，两个操作均逐轮隔离；精确 turnUuid 启动和终态 |
| 仅 researchProtocol=1 | 专用 turn 投影为 human_instruction，promptText 为保存的兼容指令 | Research 保持当前前缀识别、隔离和精确准入；创建沿用普通路径 |
| 两者均无 | 同一 human_instruction 投影 | 当前普通 FIFO/批处理/合并确认 |

兼容投影不修改数据库 trigger，不产生新 turn，不改变 UUID、seq、会话或 origin。历史 human_instruction 行继续原样读取；只有历史 Research 的已知前缀参与兼容识别。新的规范操作分类不得依赖正文内容，普通新人工消息不能因内容像某操作而获得专用事件权限。

新 CLI 继续发送 researchProtocol=1 并增加 operationProtocol=1，因此新 CLI 连旧服务器时，服务器忽略新参数并返回旧形状，CLI 仍可按原路径执行。即使请求仅携带 operationProtocol=1 而未带 researchProtocol=1，也启用规范投影和操作隔离。仅在专用 trigger 存在时验证对应载荷；缺失/不支持的 version 或矛盾载荷不能启动 subprocess，也不能默认改成 Yolo/普通消息。保留 pending 并给出可见协议错误，重连后可重新尝试，不永久写入 seen 去重集合。

通知广播上的两个新 action 与 human_instruction 一样不直接启动进程；只能从 turn 交付执行。OpenClaw notification switch 同样忽略这两个 action，repository lockstep guard 的排除集合增加它们，不能通过扩大通配排除削弱其它 wake 的覆盖。共享 seen 以 turn UUID 去重，只有校验成功并接受入队后才认领；跨连接由 origin 校验阻止，跨进程以 running 准入状态转换阻止同一 turn 重复启动。此方案不宣称网络及进程故障下的通用 exactly-once 执行。

### 3. CLI routing and execution reporting

router 将规范 trigger 转成明确的操作队列项，携带原 turnUuid、payload、promptText、sessionId/directIdeaUuid/runtimeCwd。两种专用操作在原有按会话串行队列以 isolated=true 入队。邻接 mention/普通消息不能合并吞掉该请求。

prompts 为 `idea_creation_requested`、`research_requested` 增加专用分支，使用结构化 mode/kind 决定 skill 与边界，用户 description 只作为数据。创建 elaborate 调用 Idea 流程，decompose 调用主题分解流程；研究先行请求沿用共享 Research skill。Tracker Research 调用 research-only 流程并结束，不恢复其它流程。服务器保存的 promptText 是兼容快照，不是新客户端用于推断操作类型的依据。

waker 将当前 research-only 的精确准入/回报机制概括为 typed operation admission；发起 spawn 前 await running 确认，失败时不 spawn。请求带 operationProtocol=1、connectionUuid、turnUuid 和 coalescedCount=1。终态、token usage、backendSessionId、异常中断沿用原 turn 回报，不改变 backend session 身份绑定。配置/cwd 错误等发生在 spawn 前时，允许同样 origin-fenced、exact-turn 的 pending→interrupted 受限路径，并记录现有原因，不能将一般终态 API 放宽为任意 pending 可完成。

用户新操作应具有现有“fresh human instruction”重试冲突恢复能力；不要遗留 waker 中只接受 human_instruction 的冲突保护分支。不改变普通消息及自动 crash-resume 的抑制规则。

### 4. Server state machine and Research predicates

统一服务端操作分类及 SQL 条件：规范 Research 由 trigger 判断；历史 human_instruction 的 Research 前缀继续兼容。更新 pending 读取、running 准入、FIFO 排除、coalesced settlement、阶段变化退休及 pending-launch-abort 全部调用点，包含 NULL promptText 的 SQL 语义。专用 Research 即便 promptText 不带前缀，也必须受到同样门禁。

turn-advance 按 operationProtocol/researchProtocol 选择三种模式。operationProtocol=1 下普通未关联 FIFO 和 coalescing 必须排除两个专用 trigger；仅 researchProtocol=1 下排除所有规范/历史 Research，允许创建兼容轮次按普通路径确认；legacy 下允许 origin 的兼容普通 FIFO/合并确认。不属于 origin 的调用不能借兼容模式启动或消费专用轮次。

精确 UUID 操作报告必须匹配 session/company/agent/origin，不能重复接受 running。终态幂等、backend ID 冲突及 usage rollup 保持现有语义。旧客户端因合并而结束的规范轮次也必须终结同一行，不能再次出现在 reconnect pending 结果中。

Research 资格不改变：提交事务、pending read、running transition 都用现有项目锁及后代执行证据判定。排队后启动开发则将未启动 Research 标为既有 research_stage_changed 中断；其它已排队创建/普通消息不被一起退休。Agent 在研究前及保存前仍再次核查并合并正文，保留澄清状态。

### 5. UX and display

这是现有工作界面的局部行为调整（Operate）。沿用既有 shadcn 组件、语义颜色和信息层级。

- 创建成功：关闭创建对话框、显示本地化“已提交”反馈，Idea 通过既有 SSE 更新列表；不调用 openChatForSession、不设置延迟 session-focus、不新增自动导航。现有静态创建行为保持不变。
- Research 成功：保留“已排队” toast 和 onStarted 刷新，解除提交中防重复；不打开 chat。可多次提交，逐轮状态在现有会话入口可查看。
- 失败：保留 inline/toast 错误、Agent/cwd 选择和重试数据，不能把提交失败显示为正在执行；已有手动打开的聊天窗口不因本操作被关闭或切换。
- 主动查看：保留现有手动会话入口、会话列表与实时 transcript，不留下上次提交的隐藏 focus target。
- 新 trigger 在 turn-band、通知及 transcript 中显示“创建 Idea”/“Research”等本地化业务标签，不能把长系统提示当成用户输入消息。可查看执行历史与实际失败状态；协议字段留在诊断层。transcript read 对专用操作保留稳定的 seq=0 分页位置、UUID、cursor 和 page-size 计数，但不将兼容 promptText 合成为 role=user 文本；普通/历史指令与真实 transcript 消息保持原样。

验收覆盖 en/zh/ja/ko、明暗主题、桌面/窄屏、键盘提交后焦点恢复、双击防重复与再次提交、会话原本已打开和关闭的情况。docs/design.pen 同步原为要求；本 Idea 用户于 2026-09-27 08:18 UTC 在评论 e072b3a2-15df-4f98-9dd3-595eadc1c49d 明确指示“不用管pen文件，继续推进”，本次据此豁免文件同步。其它验收要求保持有效。

## Migration and rollout

1. 先添加 nullable operationPayload 并生成 Prisma client；部署能读旧行、写新行并对旧客户端投影的服务器，再发布新 CLI。数据库迁移先于新服务代码。
2. 后端保留生成 human_instruction 的紧急兼容开关（例如服务配置 dedicatedOperationWrites=false），仅控制新写入；读/确认始终支持已经保存的规范行。
3. 回滚 CLI 可直接使用兼容投影；服务器回滚先关闭新写入，并保持兼容读取版本，等待已存专用轮次清空。不要直接回退到不认识新 trigger 的老服务，也不删除载荷列或改写已执行历史。
4. 已存历史行不批量改名或补造 payload；前缀只留在历史/旧客户端边界。部署与发布动作需后续执行阶段授权，本提案不执行。

## Validation and task boundaries

T1 服务端协议与兼容：迁移、分类、事务、pending projection、FSM 和 HTTP 参数，以数据库集成验证。

T2 CLI 专用执行（依赖 T1）：router、prompts、队列、waker、REST/reporter 与历史 fallback；模拟新 CLI/旧服务器、重复实时+backfill、先准入再 spawn。

T3 交互与展示（依赖 T1）：移除两处自动打开、保留反馈与手动入口、操作标签及设计文档，以组件测试与浏览器验收验证。

T4 汇合集成验收（依赖 T2/T3）：运行三代客户端矩阵（包括仅 operationProtocol=1、不带 researchProtocol 的组合）、连续 Research 与普通消息混合、重连及阶段竞态、跨实例/cwd 防护、明暗/窄屏 UI 和 OpenClaw 原有流程；更新验收报告及操作迁移说明。四个任务的验收均可独立执行，T4 是整合检查点。

## Risks and alternatives

只改 notification.action 会漏恢复路径；只换前缀仍依赖文案；服务端同时发新旧两条 turn 会重复执行；强制升级违背已验证要求。选择规范存储加单次响应投影。

新增 JSON 载荷增加 schema/DTO 和协议维护成本，但可持久表达 mode/researchFirst 并验证不一致，避免用 promptText 承担隐式机器协议。三个客户端世代的 FIFO 排除条件是主要风险，需测试对其它轮次无误消费。

尚未验证运行时效果；本提案中的 API 参数/载荷是拟实现契约，不声称已经存在。实施前按当前接口再次核对所有调用者和测试基线。无需新外部库。
