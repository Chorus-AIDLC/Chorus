Chorus Proposal: `ea5285b9-d3a1-4653-8443-ee0a5831c20d`. Task drafts are authoritative; local checkboxes mirror implementation progress.

## 1. 实现 Codex App Server RPC 客户端与 CLI 兼容契约

Draft UUID: `f8710528-6295-45e6-ac9e-a6c4f8eac4e8`. Task UUID: `a6bc3749-2727-449d-ac5c-3d6b9734fb72`. Dependencies: none.

- [x] 1.1 T1。实现独立的 stdio JSON-RPC 客户端及协议 fixture 测试，供 T2/T3 使用。遵循 design.md Module Contracts，核对官方文档与目标 codex app-server generate-json-schema 的实际方法、字段、请求取消/拒绝、错误分类、模型配置和 usage 形状，不凭记忆实现。记录实际测试 CLI 版本及最低支持基线。范围：新 cli/codex-app-server-client.mjs、协议 fixtures、客户端测试；此任务不切换生产 spawner。
  - Acceptance: 使用目标 CLI 的实际 schema/握手核实 initialize→initialized、thread/start/resume、turn/start/interrupt、终结事件及 server-request 响应；记录版本、字段与可用于 history fallback 的明确错误类型。
  - Acceptance: 客户端支持分片 UTF-8 JSONL、请求响应关联、通知与反向请求、写入背压，并按技术设计提供可注入超时和有界 frame/stderr 缓冲。
  - Acceptance: EOF、EPIPE、畸形/超限消息、响应超时、未知方法和取消均有确定性测试；pending RPC、定时器与订阅释放，不重复 turn/start，不出现未处理 rejection。
  - Acceptance: 定义 T2/T3 共用的类型/事件契约和消毒后的真实 fixture，测试无 prompt/凭据泄露，记录允许的 model/config 映射及不兼容项。

## 2. 迁移 Codex spawner 的会话、配置与取消生命周期

Draft UUID: `35ce7448-0317-44e8-8461-b61e731d1a14`. Task UUID: `456dfbf0-fc12-46d0-99c2-3f41af6a18a9`. Dependencies: f8710528-6295-45e6-ac9e-a6c4f8eac4e8.

- [x] 2.1 T2，依赖 T1。替换 cli/codex-spawner.mjs 的 exec 路径，保留现有 session/usage store、可执行文件/Windows shim、cwd 和 agent env。实现一次性 history fallback 和用户可见 notice，通过进程关联 stop hook 接入 process-killer，所有 Waker/control/shutdown 调用保持后端无关。更新 agent-cli-config 对 transport 的保护与已支持 model/config 的等价转换。遵循 design.md Module Contracts 与 daemon-codex-backend/daemon-spawner-interface/daemon-interrupt-resume/agent-cli-config deltas。与 T3 对接 onMessage adapter；T2 单测可使用契约 stub。
  - Acceptance: 所有 Codex daemon 新建/恢复调用仅走 app-server stdio，onChild 时机/次数和 wake result 契约保持；prompt/凭据仅经既有安全通道，cwd、CODEX_HOME 与多 agent 隔离、headless 标记正确。
  - Acceptance: 优先 thread/resume，只有 T1 核验的明确历史失效允许一次 thread/start；记录新 ID 在先、turn/start 在后，失败保留旧映射，生成一次用户可见上下文变化 notice，backendSessionId/isNew 与实际一致。
  - Acceptance: 新建和恢复均应用当前权限姿态及模型/config，保护 --listen/远程 host 等运行时控制；不支持的旧参数有无值诊断，前台 argv 和其他 backend 回归通过。
  - Acceptance: 注册 stop hook 后才暴露 child；授权中断、启动中断、正常完成和 shutdown 使用单一 deadline 清理；未知/拒绝/超时原生请求不挂起、不自动批准。
  - Acceptance: 匹配 turn outcome 决定成功/失败，退出码 0 无成功终结也失败；正常、异常、继承管道及残留后代路径均 settle once；现有进程树清理与其他后端 signal 行为通过测试。
  - Acceptance: 新建首轮中断、旧会话重复中断、daemon 重启后恢复、map IO 失败、CLI 缺失/不兼容、未知 resume 错误均有行为测试；无 exec 回退和无 turn/steer。

## 3. 适配 App Server 会话文本与 Token 用量上报

Draft UUID: `95938263-a049-4034-9c6a-73d2d7f0d194`. Task UUID: `a5feb46a-ea7a-4a78-bb72-5e3f7db02989`. Dependencies: f8710528-6295-45e6-ac9e-a6c4f8eac4e8.

- [x] 3.1 T3，依赖 T1，可与 T2 并行。新增 cli/codex-app-server-events.mjs，将真实 RPC notifications 转成 upload-hooks 已消费的内部事件；复用/调整 codex-usage-map 的 baseline 归一化。按 design.md 事件表及 Module Contracts 实现线程/turn 过滤、item 去重、连续性提示、累计总量差分，接口供 T2 spawner 调用。保持公共 TokenUsage/turn-advance/persistence/SSE/UI 不变。
  - Acceptance: 多段 delta 加 completed snapshot 只产生一次完整 assistant item；commentary/final item 身份保留，工具/推理/其他 thread/旧 turn 不进入会话文本；连续性 notice 恰好一次。
  - Acceptance: 累计 usage snapshot 只取最新有效总量并减可信同 thread baseline，再做一次 exclusive-input/cache 归一化；重复帧不累计，reasoning 不二次加到 output，source=codex，缺失字段/model 保持既有 null 契约。
  - Acceptance: 旧 exec thread 无 baseline 时仅 seed 并省略首个不可知 turn usage；新 thread 不继承旧 baseline；回退、计数回退和无 usage 情况不虚构数据。
  - Acceptance: 失败/中断前已经观察到的有效 totals 更新持久 baseline，后续 resume 不重复计费；与既有 upload-hooks/terminal turn report 配合恰好一次，不新增服务端 schema。
  - Acceptance: 以 T1 实际协议 fixtures 及重复/乱序/跨 thread/缺字段/多模型请求场景验证文本和 token 转换；Claude/Kiro/Pi 等既有事件消费测试保持通过。

## 4. 完成 App Server daemon 集成验收与迁移文档

Draft UUID: `296cecbf-9933-4448-a4c4-8ded2e7d65ee`. Task UUID: `d3303872-a7d0-470c-8d3f-2c12b6944d82`. Dependencies: 35ce7448-0317-44e8-8461-b61e731d1a14, 95938263-a049-4034-9c6a-73d2d7f0d194.

- [x] 4.1 T4，集成检查点，依赖 T2/T3。将 RPC、spawner、事件适配与真实 Waker/control/upload 流程一起运行。用 pnpm exec vitest run 执行 cli/__tests__ 相关与全量回归；验证支持 CLI 上的真实 new/resume、旧 exec 历史、Chorus MCP/SessionStart、中断再恢复。更新 docs/DAEMON.md 和相关 CLI 使用说明。记录确切版本、平台、命令、结果和限制；不能把 fixture 测试写作真实平台验证。协议/CLI 参数再次以官方文档与 T1 契约为准。
  - Acceptance: 综合测试穿过实际 daemon Waker→App Server→normalized events→turn/transcript/usage reporters，覆盖新建、再次唤醒、daemon 重启、历史失效 fallback、startup/active interrupt、非零/异常退出，验证终态与 resume ID。
  - Acceptance: 使用真实目标 Codex CLI 验证新建、恢复、旧 exec thread 兼容和 first-turn interrupt/resume；验证配置完整时 Chorus check-in/MCP/技能上下文可用且无错误重复警告，配置缺失保留既有 warning-and-run。
  - Acceptance: 若 App Server 不触发既有 SessionStart，适配为等价一次性启动上下文/check-in 并测试；验证各 agent env/权限在 resume 不串用，配置/未知 native request 不阻塞。
  - Acceptance: pnpm exec vitest run cli/__tests__ 通过；Linux/macOS POSIX group 与 Windows shim/taskkill 契约测试覆盖，至少一个实际支持平台完成 live smoke，记录其余平台实测范围和任何残余风险。
  - Acceptance: docs/DAEMON.md 说明 App Server-only 迁移、已验证支持版本、旧参数处理、历史提示、取消与故障诊断，保留合法 foreground exec 用法；无 UI/DB/API 变更或隐式 exec fallback。
  - Acceptance: OpenSpec strict validation 与五个能力 delta 全部验收项对齐；回传具体验证证据，存在未达成的 required criteria 时不提交为完成。

