# Technical Design — daemon 评论唤醒恢复

## Context And Confirmed Evidence

Idea: `67981f96-c380-4777-81f1-134ef71aeb89`。用户已确认以 2026-10-09 06:38、06:42（UTC+8）为首批样本，并明确只允许隔离验证，操作运行中的服务须另行确认。

### 现场时间线

1. 06:38:32：本机收到 turn `143ced12-54b2-42e5-ac2a-7c5ea90b7338` 的 deliver_turn，同秒 pending-turn GET 与通知 `ba0684ab-9ffd-44a4-a7e4-498d000b6cb4` 路由出现 fetch failed。深入调查时，以只读 API 查询，该 turn 仍 pending、startedAt=null。
2. 06:42:19：turn `a75540f7-a402-427b-9a62-7c637bf22933` 的投递及通知 `cdcef0fc-cec0-49bd-bb07-9ea640195f59` 同样失败。
3. 06:42:34：日志显示 dispatch 的实际输入为新聊天 `0d1522ce-b175-4beb-ad63-7da60aa52c69`，但服务端历史中 startedAt=06:42:34.634 的是旧评论 `a75540f7-…`；新聊天的 startedAt 却是 06:45:48.815，与下一条 mentioned 的实际 dispatch 相同。该下一条评论 `fccb7b3f-66c9-4352-99b8-862a43f84f57` 查询时仍 pending。
4. 所以 UI 不是唯一问题，也不能以某个旧 turn 最终 ended 证明原始评论被正确执行。日志与数据库归属出现顺移，必须保留执行输入与生命周期身份的关联。

日志只读来源为 `journalctl --user -u chorus-daemon.service`；API 使用当前 agent 凭据读取其自身 pending turns 和 session detail，未读取其他 agent 的数据、未修改状态或重放事件。

### 隔离复现

对 checkout 与已安装 CLI 分别直接导入 EventRouter/createBackfill，以假的 MCP/REST、假的 queue 和合成 UUID 运行 Node assert：

- 首次通知读取与 pending GET 同时抛错：队列数量 0，但 notificationUuid 已在 seen。
- 恢复所有假请求，主动调用完整 backfill：队列仍为 0，turn UUID 也进入 seen，因为错误的通知 seen 被视作“已处理”。
- 随后提供新的 human_instruction：队列变为 1，原评论仍未入队。
- 单独令 autonomous pending-turn 的通知重读失败，再以同一 turn 重试：MCP 仅调用一次，队列仍为 0，证明 turn 去重也会中毒。

两套文件均得到以上结果。event-router、backfill、daemon、SSE listener、control handler、REST client 的安装文件与 checkout 字节相同。安装包版本是 `0.21.1-local.bgwait.20261006`，checkout 为 `c2da4bfaf2758b876c5107ae93e0049e25c10ca9`；磁盘相同不证明三天前启动的进程加载过相同字节，也不证明线上服务端 revision 相同。

### 根因链与限制

- 触发条件：HTTP 传输失败。当前会话以原生 Node fetch 对同一 origin 做四次无认证只读 GET，得到一次 `cause.code=ECONNRESET` 后三次 200；认证读取也观察到 ECONNRESET。历史日志没有 cause，不能断言两次历史失败必然也是同一底层原因，更不能归因于 DNS、代理或 CloudFront 的具体配置。
- 永久漏处理机制：router 在异步取数之前写 seen，错误、找不到通知和 lineage 失败不撤销，且 pending-turn 与 notification 双路径共享错误的成功状态。[router](ref:807524b9-e934-4a8e-8548-319a5562e603)
- 恢复触发缺口：pending GET 失败直接返回；SSE 只在断开或 75 秒无字节时重连，正常心跳不会补偿独立 HTTP 失败；新聊天的指定 turn 请求也不会恢复旧 turn。[GET](ref:d73afb2f-110e-4c64-b894-41ed05f036d2) [backfill](ref:bff43567-3059-459b-95ac-9ec9fc4e09fa) [SSE](ref:bfc41a00-cd16-42f9-9850-f10630450e56)
- 状态错位机制：ordinary admission 未携带已知 turn UUID，服务端选最早 pending。此时 daemon 实际处理顺序可能因为前一次失败而与持久化 FIFO 不同。[waker](ref:0da801a6-ee82-4e32-a383-5254008bba79) [server](ref:ee626220-7bc7-474f-9d3a-07faa6ae3181)
- durable context 缺口：自主 turn 的 promptText=null，客户端只读最近 50 条 unread 通知，并存在按 session/trigger 或唯一候选猜测逻辑。checkin 或 UI 已读后，这不是可靠恢复依据。只清 seen 或增加轮询仍不足以安全修复。

## Goals / Non-Goals

恢复可重试故障，保证同一进程同一连接内准确入队一次、正确 turn 归属，并解释无法恢复的旧数据。不是跨进程任意副作用 exactly-once 系统，不重构 SSE，不强制网络代理/DNS 配置，不补写历史状态，不自动重放存量业务消息。

## Decisions And Module Contracts

### 1. Durable wake identity and compatibility

新增可空 `DaemonSessionTurn.wakeContext` JSON 字段，使用带 version 的校验结构，保存源 notificationUuid 与重建唤醒所必需的最小原始通知上下文：action、entity type/UUID、actor identity 和必要文本。不得保存密钥、执行命令或扩大项目访问授权。读取时沿用现有 company/agent/session/origin 和当前项目访问检查；可变的归属/权限在交付时重新验证。

单条与批量通知创建流程均需传递精确 source notification UUID；在发送任何通知或 deliver_turn 之前将对应 turn 与 context 持久化。失败不得发布“可恢复”的新协议事件；避免生成无法关联的孤立成功记录。新能力标记启用返回 wakeContext、turnUuid 和精确 source identity；旧字段、旧客户端及已有行保持兼容。

跨任务 wire contract：能力参数名为 `wakeRecoveryProtocol=1`（pending GET 与 SSE URL）；turn-advance 的 JSON 标记为 `wakeRecoveryProtocol: 1`。context 形状为 `{ version: 1, notificationUuid, notification }`，其中 notification 为 router 使用的规范化通知对象，至少含 uuid、action、entityType、entityUuid，并保留生成提示需要的 message/entityTitle/actorName 与既有归属信息。新广播事件携带 `turnUuid` 与 `wakeContext`；pending DTO 亦携带它们。精确批次请求使用 `turnUuid` 为主 turn、`turnUuids` 为去重后的成员数组；legacy 请求不带协议标记，继续现有语义。未知 context/protocol 版本不得自动降级为猜测执行。

新 CLI 对协议支持的定向自主唤醒，以 turn 作为执行身份；通知广播与 deliver_turn 归并到同一 admission。不得因通知已读或超过 unread 列表窗口而失去上下文。旧行没有 context 时仅允许能证实身份的恢复，无法证实时保留未处理并输出明确诊断，不以唯一候选猜测或认作成功；本次不批量修补旧行。

### 2. Transactional routing dedup

区分 `inFlight` 与已接受的 `seen`；返回可等待的结构化 routing result：`accepted`、`duplicate`、`ignored`、`retryable`、`blocked`。只有 queue 接受后提交成功去重；异常、超时、keyFor 失败释放本次占位。忽略与永久拒绝与已执行状态分开记录。

通知 UUID 与 turn UUID 的别名关联来自 durable context，而非匹配猜测。并发广播/控制投递等待同一个 admission 结果；首次失败时后续尝试仍有机会。保留原始 targetConnectionUuid、suppressWake 与 runtimeCwd，在重试时复核当前连接；不把定向事件降级成 agent-wide broadcast。

### 3. Connection-scoped recovery

为每个 agent/cwd connection 建立单一协调器，负责定向重试、注册完成后的校验和低频未处理工作协调。定向请求保持只处理目标 UUID；周期扫描是独立动作，不能借新聊天默默重放全部历史 work。

网络异常、超时、429、5xx：快速重试采用 1s/2s/4s 后进入最高 30s 的带抖动恢复周期，不因短期预算耗尽就遗忘责任；最多一个扫描请求和一个定时器，重复 ping 合并。401/403、不可见/不存在、权限撤销、无效 context 则停止热重试并记录原因，等待身份/连接更新或人工处理。所有读取具有 10s 应用层 deadline；通知来源与 pending-turn 来源不能互相无限阻塞。

周期扫描仅对新协议下能证实未被接受、具有可靠身份的 turn 自动投递；旧数据有歧义时诊断而不重放。已运行/已终止 turn 不进入恢复。in-flight 阶段到 queue admission 后由既有执行队列接管，不把“未结束”误作“未接收”。

连接注册/重连完成后使用新的 connection UUID；旧代际返回值不得入队。stop/dispose 清定时器、abort REST、使不能中断的 MCP 回调失效，避免关闭/冲突连接重新开始工作。多 agent/cwd 不共享恢复状态。[接线](ref:fcb35efb-663c-43b0-aa9b-748757e8a77b) [control](ref:72c2b105-f267-4be6-9f76-9f0e077bb201)

### 4. Exact ordinary and batch lifecycle

已知 turn UUID 的普通 human_instruction 与自主唤醒必须在 running/terminal/reporting 中保留该身份。服务端精确 admission 不得以另一个 FIFO turn 代替，并需在执行前确认当前授权、origin 与 pending 状态；拒绝时不启动模型。

合并批次保留实际成员 turn UUID 列表，事务性校验同一授权 session 的成员身份并准确结算这些成员，而不是取 N 个最老 pending。保留既有单 session 顺序与合并提示语义，不因一个旧漏投 turn 吞掉新事件的状态。旧客户端的计数/FIFO 协议保持兼容但不宣称具备新保证；新客户端降级时必须显式诊断，不把失败当成功。

准入阶段的恢复责任属于已经持有该批次的 waker，不再由 pending 扫描负责。批次在排队时生成并保留 `admissionUuid`，每次精确 admission 使用相同 token、主 turn 与有序成员；服务端在新增可空 admission 标识/成员记录中原子保存这三者与 running/merged 结果。同 token 且完全相同身份的重试在原准入仍有效且未终止时返回同一成功结果，不再次改变状态；不同 token、成员不一致、越权或已终止返回明确拒绝。每次重试仍重新检查访问和 origin。

对网络/超时/429/5xx（包括服务端已提交但响应丢失）waker 在同一队列执行槽保留批次，采用 1/2/4s 后最高30s退避及10s deadline，直至取得可确认的成功、永久拒绝或停止；不在有限重试后把批次抛掉，不删除已接受去重以制造第二个执行者。仅确认成功后启动模型一次。停止时取消等待；如已确认或可能已提交准入，使用同 token 的精确状态/幂等结算协调，不能伪报已执行。进程崩溃仍使用既有 offline/crash interrupted 语义，不在本变更内宣称跨进程自动 exactly-once。

验收必须覆盖：single/batch admission 首次5xx且未提交；已提交后响应丢失，再发同token；重复SSE在准入等待中；停止发生在等待期间。断言最终要么准确启动一次并归属原turn，要么明确终止/拒绝且无模型启动，绝不“已经seen但永远没人负责”。

### 5. Diagnostics

失败日志包含操作、connection、turn/notification 标识、attempt、下一次计划、HTTP 状态或安全 cause code。保留原有可检索错误前缀，不打印 API key、Authorization、完整 prompt 或任意异常对象。网络 reset 的具体外部原因不能凭增强日志前的样本断言。

## Validation / Delivery

- server：context 持久化单/批通知、已读通知恢复、访问撤销、跨 agent/connection、迁移旧 null 行、能力协商及精确 batch admission。
- router：首次双失败后重试成功、并发双路、lineage 失败、已读/列表窗口外、无匹配/歧义不得误执行。
- coordinator：稳定 SSE、连续故障、429/5xx 与永久拒绝、饥饿/请求合并、重连代际、读取超时及停止期间迟到响应，均用 fake timers/fake transports。
- integration：两条样本形态 + 后到聊天，断言实际队列内容、每个 turn UUID 的状态/消息归属，不只断言“有一次 wake”。现有队列合并、隔离操作、session 生命周期与多实例测试必须通过。
- 本轮调查脚本使用 fake queue，不产生真实 agent；实施后的真实部署仍须人类另行授权。若实现需要改变以上权限、兼容或行为边界，回到方案审核，不自行扩大范围。

## Implementation And Review Evidence

- 服务端任务 `368851b1-05bb-4d08-9509-a08abdc60ec3` 经独立审查 PASS WITH NOTES：可空迁移、durable context、当前访问检查、精确原子准入和幂等 token；2896 项相关测试通过、127 项环境依赖测试跳过。隔离 PGlite fixture 使用单连接池，验证真实 SQL/事务行为但不宣称覆盖多连接竞争。
- CLI 任务 `2e1d40d6-b444-4024-8d1d-7614adc7de82` 第二轮独立审查 PASS。首轮发现真实 LineageResolver 把失败当 null 祖先缓存，及普通准入等待无法接受用户中断；均补真实组件回归并修复。失败 lineage 不缓存，合法 null 祖先仍受支持；每个未启动 wake 独立取消，不影响其他 session。
- 精确 transcript 在准入成功后绑定主 turn UUID；按 turn 隔离缓冲、usage 与 relay error，POST 仅发送 turnUuid 而不是 sessionId，迟到 flush 不能归属新 turn。旧协议保留原 sessionId 路径。
- 入队成功与模型启动是不同边界。连接替换/停止可取消未确认准入；从未提交的取消不伪报已执行，释放本地 alias 后由持久化 pending 再协调。用户中断锁定本地取消身份，不释放该 wake 的去重；晚到的成功准入响应再次做同 token 精确终止，绝不启动模型。网络中断使服务端提交结果完全不可观测时，仍依赖既有离线/crash 协调，不承诺跨进程 exactly-once。
- CLI 全量回归：`pnpm exec vitest run cli --reporter=dot`，121 文件、3176 测试通过。第二轮 reviewer 独立运行 234 项聚焦测试和原始失败复现，并额外验证 sibling session 中断、并行另一会话不受影响。
- 首次全仓回归（审查修正前）：449 文件通过、10 文件跳过；10104 测试通过、237 跳过。类型检查通过，聚焦 lint 零错误，REST client 有一项既有 `_rawData` 未使用警告。最终跨层补测与回归结果记录在本任务和完成报告，不把环境跳过标作执行通过。
- 跨层补测：`src/services/__tests__/daemon-wake-delivery.database.integration.test.ts` 的 8 项测试通过。以临时 socket 上的内存 PGlite 应用实际 migrations，连接真实 Prisma、notification/session 服务、API routes、router/backfill/recovery/waker/REST/transcript hooks；只替换认证、HTTP/MCP transport 与模型子进程。覆盖两种现场形态、已读/窗口外上下文、后到聊天、single/batch 的提交前503及提交后响应丢失、等待中重复 delivery、停止/撤权与精确 transcript，且历史无 context turn 保持不动。没有执行 live SSE、真实 agent 或线上故障注入；不把这些边界描述成生产验收。`tsc --noEmit --incremental false` 通过。

## Deployment Handoff — Not Executed

### Aggregate-review correction: immutable admission ownership

Final review `B1-origin-repoint-orphans-admitted-turn` reproduced a canonical session moving from connection A to B while A already executes its admitted turn. Using mutable session origin for A's terminal report stranded that turn as running. The unshipped migration now also adds nullable `admissionConnectionUuid`, persisted atomically on the primary at admission. Running admission/retry still requires current session origin and, for an existing token, the saved admitting connection. Terminal ended/interrupted reporting instead requires the immutable admitting connection plus the same tenant, agent, token, members and current resource access; it does not require the session to still route new work to A. B cannot settle A's execution using A's token, and A cannot admit B's new pending work. Legacy rows remain null rather than guessing ownership. This corrects settlement ownership without weakening new-admission fencing.

实现与隔离验收阶段只完成源码、测试及审查证据；该阶段没有更新/重启在线 daemon、应用线上迁移、重放历史消息或 commit/push/merge。2026-10-09 后续用户明确授权重试同步，并在成功后向 develop 开 PR；该授权允许分支提交、推送和创建 PR，不包含合并、部署、本机切换或存量处置。

### Authorized rollout order

1. 先确认目标服务端 revision、数据库备份与回滚窗口，检查迁移 `20261008233000_daemon_wake_recovery`。它只增加 nullable wakeContext、唯一 admissionUuid、admissionConnectionUuid 与 admissionTurnUuids，不回填历史来源或执行所有权，不自动改变 pending/running。
2. 先部署兼容新协议的数据库/服务端，再在经授权的隔离 canary daemon 上安装匹配 CLI。旧客户端仍用 legacy DTO；新 CLI 对无法确认精确 turn 的旧服务端响应拒绝启动而不是静默 FIFO 降级，所以不能先滚动新 CLI 再升级服务端。
3. 使用新的合成 Idea/comment 测试短时 GET/准入失败。验证同一 notification/turn 从 pending 到精确 running/ended，transcript 只落在主 turn；模拟稳定 SSE 时不需要人工聊天或重连。分别确认不同 agent、cwd/origin 不互相接管。
4. 观察安全日志里的 connection、turn、attempt、status/cause、next retry。若持久 401/403/404、未知 context version 或旧行无法还原来源，应诊断并人工处理，不反复投递或猜测通知。短暂 ECONNRESET 只证明传输重置，不能据此声称 DNS/代理/CDN 根因已修好。
5. 授权后逐步切换本机 daemon；切换前记录活动 session，确认未启动准入与运行模型各自的收尾行为。数据库新增列保留通常便于代码回滚，但回滚至旧 CLI 会重新暴露已知漏恢复/FIFO 风险，不能把回滚当修复。

### Historical pending / running rows

原样本含无 context 的 pending 及可能错误归属的 running/ended。不得据状态猜测原评论是否执行，不得批量 replay、补造 wakeContext 或修改 startedAt。逐条关联 notification/turn UUID、日志中的实际输入、agent transcript 与业务副作用，经人类判断后选择新建后续消息或显式清理；本轮未执行这些动作。
