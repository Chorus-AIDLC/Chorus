# Portability Is Semantics, Not Prompt Copying

## 跨 Agent 可移植性的本质是语义适配，而不是复制提示词

> 本文基于 Chorus 仓库基线 `cbbe886a`。行号用于定位该基线附近的实现；代码演进后应以文件路径与符号名为准。

## 摘要

当一个 Agent 工作流需要同时运行在 Claude Code、Codex、Pi、Kiro 与 OpenClaw 上时，最直观的做法是复制同一份 prompt 或 skill。然而，文本相同并不意味着行为相同：不同 runtime 暴露的 lifecycle hook、子 Agent 启停事件、可变输入、会话标识、凭据注入、无头执行与 transcript 能力并不一致。本文以 Chorus 的五种真实集成为案例，提出一种两层可移植性模型：上层是稳定的语义内核，包括无状态 MCP 操作、Idea→Proposal→Task→Verify 状态机、持久化 artifact、权限与独立评审协议；下层是 runtime adaptation layer，把这些语义映射到每个宿主实际提供的 primitive。研究表明，移植工作既包含必要的文本移植，也包含 lifecycle observation、context injection、worker/session correlation、credential delivery、resume identity 与 failure degradation 的逐项适配。Chorus 当前已经证明一套 AI-DLC contract 可以跨五种 runtime 保持可辨认的工作流语义，但尚未实现由单一规范自动生成所有 adapter，也不能宣称五种 runtime 具有相同的可观测性和故障语义。

## Abstract

Copying the same prompt or skill is an intuitive way to port an agent workflow across Claude Code, Codex, Pi, Kiro, and OpenClaw. Identical text, however, does not imply identical behavior: the runtimes expose different lifecycle hooks, sub-agent events, mutable-input channels, session identities, credential mechanisms, headless execution modes, and transcript fidelity. Using five production Chorus integrations, this paper proposes a two-layer portability model. A stable semantic kernel defines stateless MCP operations, the Idea→Proposal→Task→Verify state machine, durable artifacts, permissions, and independent-review protocols. A runtime adaptation layer maps those semantics onto host-specific primitives for lifecycle observation, context injection, worker/session correlation, credential delivery, resumption, and failure handling. The evidence shows that textual skill ports remain necessary but are insufficient without semantic adaptation. Chorus demonstrates recognizable AI-DLC semantics across five runtimes, while stopping short of claiming behavioral identity, generated adapters, or equal observability across hosts.

## 1. 引言与动机

### 1.1 从模型可移植到工作流可移植

2026 年的 Agent 工程重心正在从“选哪个模型”移向“模型运行在什么 harness 中”。一个真实 coding agent 不只接收文本并生成文本；它还要获得工具、加载仓库知识、恢复会话、派生 worker、接收异步通知、处理权限，并把结果提交到可审计的工作流。OpenAI 将这种工程概括为构造 agent-legible repository、清晰反馈回路与机械约束，而不是依赖越来越长的指令[1]。Harness 演进的行业综述也显示，prompt、tool use、planning、memory 与 multi-agent orchestration 正逐步组合为运行系统[2]。

因此，“同一模型 API”并不是工作流可移植性的充分条件。即使两个 runtime 都能调用 MCP，它们仍可能在以下问题上给出不同答案：

1. 何时能够向主 Agent 注入启动上下文？
2. 能否在 worker 创建前修改其输入？
3. 是否会通知 worker 已启动或已停止？
4. 会话 ID 由调用方生成，还是由 runtime 生成？
5. 无头进程如何恢复既有会话并导出 transcript？
6. API key 从环境变量、配置文件还是宿主 secret store 进入 MCP？
7. runtime 缺少某项能力时，是显式降级、人工补偿，还是静默丢失语义？

这些问题都不是复制 `SKILL.md` 能回答的。

### 1.2 本文主张

本文的核心主张是：

> 跨 Agent 可移植性，是把一个稳定 workflow contract 映射到不同 runtime primitive；复制 prompt 或 skill 文本是移植的一部分，但仅有文本复制不足以保持工作流语义。

这里有两个需要同时避免的极端。第一，不能声称“prompt 不需要复制”：Chorus 当前确实维护多份 host-specific skill，并替换工具名、调用方式与宿主约定。第二，也不能把这些手工文本 port 当作完整兼容层：会话关联、hook 时序、凭据边界和失败恢复都需要代码级 adapter。

### 1.3 研究问题

本文围绕三个问题展开：

- **RQ1：** 五种 runtime 之间，哪些语义可以稳定，哪些机制必须适配？
- **RQ2：** 缺失 runtime primitive 时，如何用显式 orchestration 或持久状态补偿？
- **RQ3：** 怎样检验“工作流等价”，而不是仅检验“插件成功安装”？

## 2. 背景与相关工作

### 2.1 Prompt portability 与 harness portability

Prompt portability 关注输入文本能否被不同模型理解；skill portability 则进一步携带流程说明、工具使用规范和领域知识。两者都重要，却默认 runtime 已经提供相近的执行条件。Harness portability 关注的是更低一层的事实：同一句“spawn reviewer and wait for verdict”，在一个宿主中可能有 `SubagentStart/Stop`，在另一个宿主中只有主 Agent 可显式 `spawn_agent`，在第三个宿主中则可以在 spawn 之前原地修改输入。

因此可移植性至少包含三种层次：

| 层次 | 携带的对象 | 典型失败 |
|---|---|---|
| 文本层 | prompt、skill、术语、步骤 | 工具名或宿主指令不匹配 |
| 协议层 | MCP schema、实体、状态转换、权限 | 客户端能调用工具，但绕过或误解工作流门禁 |
| 运行层 | hook、session、spawn、resume、credential、transcript | 文本正确，但 worker 无归因、会话断裂或凭据不可用 |

Chorus 的实践同时跨越三层：skills 在文本层被手工移植；MCP 与服务端状态机提供协议层稳定性；plugin、extension 与 daemon spawner 在运行层做差异适配。

### 2.2 MCP 解决什么，不解决什么

MCP 为工具发现与调用提供统一协议，但它不规定宿主的完整 lifecycle。Chorus 每次 MCP 请求都以认证上下文创建新的 server 与 transport（`src/app/api/mcp/route.ts:55-72`），再注册公共工具和按权限过滤的工具（`src/mcp/server.ts:14-37`）；`registerPermissionedTool` 在缺少权限时不注册工具（`src/mcp/tools/register-helpers.ts:21-38`）。这使不同 runtime 可以看到一致的业务工具语义。

但 MCP 不负责决定：

- 宿主何时把 check-in 内容加入上下文；
- worker spawn 前能否注入 Chorus session UUID；
- runtime thread ID 如何与业务实体关联；
- 无头进程结束后如何恢复 transcript；
- 宿主如何实施 sandbox 或 tool trust。

统一工具协议与统一 runtime 是两个不同命题。

### 2.3 Agent-legible repository

可移植性还依赖仓库是否能被新会话重新读取。OpenAI 的 harness engineering 经验强调把计划、规范、测试和工程约束放进仓库，让 Agent 能在有限 context 中按需发现，而不是依赖某次对话的隐含记忆[1]。

Chorus 的 OpenSpec mode 是这一原则的具体实现：本地 `proposal.md`、`design.md` 和 `specs/<capability>/spec.md` 映射到 Chorus document draft（`docs/OPENSPEC_MODE.md:106-134`），使文件是 working copy、Chorus 是可评审 mirror。与此同时，该文档明确承认 Claude Code 与 Codex 的 `openspec-aware` skill 是手工维护的两个版本，没有 canonical shared file 或同步脚本（`docs/OPENSPEC_MODE.md:5-12`）。这正说明“可读的共同 artifact”与“自动生成的共同 adapter”还不是一回事。

## 3. Chorus 架构与机制

### 3.1 两层模型

Chorus 的可移植架构可以拆为两层。

**稳定语义内核：**

1. **Authoritative entities 与 durable artifacts**：Idea、Proposal、Document、Task、Acceptance Criterion、Comment、Report 与 Activity 存在于控制面，而非只存在于某次模型上下文。
2. **状态机与门禁**：Idea 使用 `open → elaborating → elaborated`（`src/services/idea.service.ts:163-169`）；Task 使用 `open → assigned → in_progress → to_verify → done` 等受控转换（`src/services/task.service.ts:140-153`）。
3. **无状态 MCP 操作**：请求携带认证上下文，server 按当次权限构造工具面（`src/mcp/server.ts:14-37`）。
4. **权限语义**：业务权限决定工具是否可见；服务端仍需在执行路径继续授权，不能把“工具不可见”当作唯一安全边界。
5. **证据与独立评审协议**：实现者提交 AC、自检与 work report；独立 reviewer 回写 `VERDICT`；管理员决定 verify。

**Runtime adaptation layer：**

1. lifecycle observation；
2. startup 与 worker context injection；
3. worker ID、Chorus session 与 runtime session 的关联；
4. MCP registration 与 credential delivery；
5. headless wake、resume identity 与 transcript extraction；
6. interrupt、orphan cleanup 与能力缺失时的降级。

稳定层定义“必须发生什么”，适配层决定“在这个宿主里怎样发生”。

### 3.2 Claude Code：事件面最完整的基线

Claude Code plugin 的 `public/chorus-plugin/hooks/hooks.json:3-132` 注册了 **9 个事件族、13 个 command registration**：

- `SessionStart` 与 `UserPromptSubmit`；
- 三个 `PostToolUse` reviewer nudge；
- 三个 `PreToolUse`，其中 `Task` 在 spawn 前记录 worker 意图；
- `SubagentStart`、`SubagentStop`；
- `TeammateIdle`、`TaskCompleted`、`SessionEnd`。

子 Agent 生命周期不是只靠 skill 约定。`on-subagent-start.sh` 先通过 atomic `mv` claim 对应的 pending spawn，再查找、复用、重开或创建 Chorus session，最后把 session UUID 与 workflow 通过 `additionalContext` 注入 worker（`public/chorus-plugin/bin/on-subagent-start.sh:48-116`、`:155-160`）。`on-subagent-stop.sh` 读取同一状态分区，执行 task checkout、关闭 session 并清理映射（`public/chorus-plugin/bin/on-subagent-stop.sh:32-103`）。

这使 Claude Code adapter 可以自动观察 worker start/stop。它仍不是零成本：`PreToolUse:Task` 与 `SubagentStart` 给出的字段不同，需要 pending/claimed 文件完成关联；并发 spawn 依赖原子 claim 防止串错 worker。

### 3.3 Codex：较小的 hook surface，显式管理 worker

Codex plugin 的 `plugins/chorus/hooks.json:3-48` 只有 **2 个事件族、4 个 registration**：一个 `SessionStart`，以及三个 `PostToolUse` reviewer nudge。它没有对应 Claude Code `TeammateIdle`、`TaskCompleted`、`SubagentStart` 或 `SubagentStop` 的自动集成。仓库文档因此要求主 Agent 使用内置角色和 `spawn_agent`，通过 task status、work report、AC 与 verify 保存进度（`plugins/chorus/README.md:86-101`）。

准确的说法不是“Codex 是无状态的”，而是：

> Chorus 的 Codex port 不通过 sub-agent lifecycle hook 自动管理 worker session；主 Agent 显式 spawn、wait、close，业务进度持久化在 Chorus task state 中。

其 daemon adapter 又展示了另一种 session 适配。`codex exec --json` 输出 JSONL，首个 `thread.started` 事件给出 runtime 生成的 `thread_id`；adapter 持久化 `anchor → thread_id`，后续用 `codex exec resume` 恢复（`cli/codex-spawner.mjs:7-23`、`:221-246`、`:312-335`）。prompt 经 stdin 而非 argv 发送（`:367-379`），权限映射到 Codex sandbox mode（`:90-108`）。

凭据同样不能照搬 Claude Code：Codex plugin 不发布 `.mcp.json`，安装器把 literal Bearer header 写入 `~/.codex/config.toml`（`plugins/chorus/README.md:15-37`）。daemon 导出的 `CHORUS_API_KEY` 可供 hook 脚本使用，却不会自动替换 Codex MCP 配置中的 header（`cli/codex-spawner.mjs:16-22`）。

### 3.4 Pi：利用 mutable pre-spawn input

Pi integration 不是 JSON manifest 加 shell hook，而是订阅 native event 的 TypeScript extension（`packages/chorus-pi/extensions/chorus.ts:1-30`）。其关键能力是 `tool_call` 在工具执行前暴露**可变输入**：

1. 识别 `subagent_spawn` 和 canonical worker；
2. 调用 `chorus_create_session`；
3. 暂存 `toolCallId → sessionUuid`；
4. 原地追加 `input.task = input.task + sessionWorkflow(session.uuid)`。

对应实现位于 `packages/chorus-pi/extensions/chorus.ts:291-312`。worker 因而在创建时直接收到自己的 Chorus session UUID，而不必等 start event 再查表。spawn 返回后，extension 再建立 `agentId → sessionUuid` 映射（`:313-360`）；若 spawn 失败或 agent ID 无法提取，则关闭 orphan session，并在关闭失败时保留映射供 shutdown 重试（`:398-438`）。

这不是“Pi 与 Claude Code hook 相同”，而是**语义相同、primitive 不同**：Claude Code 在 `SubagentStart` 注入，Pi 在 `subagent_spawn` 执行前修改输入。Pi 的配置也不同：优先读取 `CHORUS_URL` / `CHORUS_API_KEY`，否则从项目或用户 `.mcp.json` 解析（`:48-69`）。

### 3.5 Kiro：纯文本 hook 与事后会话识别

Kiro agent profile 注册 `agentSpawn`、`stop` 与三个 `postToolUse` hook（`public/kiro-plugin/.kiro/agents/chorus.json:25-49`）。`agentSpawn` hook 成功退出时，stdout 会被作为**纯文本**加入上下文；它没有 Claude Code 的 `hookSpecificOutput/additionalContext` JSON envelope（`public/kiro-plugin/bin/on-agent-spawn.sh:4-9`、`:51-80`）。

Credential delivery 同样是 Kiro-specific：

- `.kiro/settings/mcp.json` 使用 `${CHORUS_URL}` 与 `${env:CHORUS_API_KEY}`（`public/kiro-plugin/.kiro/settings/mcp.json:1-12`）；
- daemon 把二者放入 child env，不放入 argv（`cli/kiro-spawner.mjs:277-283`）；
- headless 权限是 `--trust-all-tools` 或 `--trust-tools=fs_read,@chorus`，不是 Codex sandbox mode（`:44-75`）。

Kiro headless stdout 是 plain text，没有携带 session ID 的 stream event。adapter 对新 run 在执行前后 diff Kiro session store，只有恰好发现一个新 session 时才保存 `anchor → sessionId`；发现 0 个或多个新 session 时拒绝猜测，避免把两个 Idea 串到同一会话（`cli/kiro-spawner.mjs:285-288`、`:340-357`）。

这一策略有明确边界：仓库在 Kiro CLI 2.12.1 上观察到 `--no-interactive` 可能不持久化 CLI session，因此 transcript reconstruction 必须退回 raw stdout（`:361-377`）。这比伪造“已完整恢复会话”更可靠，但 fidelity 低于带结构化事件的 runtime。

### 3.6 OpenClaw：进程内 TypeScript runtime

OpenClaw 不是通过外部 CLI spawner 唤醒。其 plugin entry 在 full registration mode 下注册 MCP、in-process daemon client 和后台 SSE service（`packages/openclaw-plugin/src/index.ts:40-77`、`:130-220`）。通知到达后，`OpenClawDaemonClient` 最终调用宿主的 `runEmbeddedAgent`，继续已有 session/workspace 并回报 lifecycle 与 transcript（`:103-169`）。

SSE listener 使用 Bearer 认证请求 `text/event-stream`，解析流并把 `connection_registered` 与 reverse-control event 从普通 wake path 中分流（`packages/openclaw-plugin/src/sse-listener.ts:102-176`、`:194-274`）。这是一种 in-process runtime adapter，而不是“另一种 shell hook”。

OpenClaw 当前也有宿主边界。连接以 `process.cwd()` 上报，现阶段是 single-cwd（`sse-listener.ts:111-116`）；能否恢复 session、workspace 与 model 依赖宿主 runtime 提供的 helper。旧的 `createWake` 注释仍描述部分 drop 行为，但当前主入口使用增加了报告、interrupt registry 与 pending-turn backfill 的 `OpenClawDaemonClient`，应以 `index.ts` 的 wiring 为准。

### 3.7 五种 runtime 的适配矩阵

| Runtime | 扩展形态 | Lifecycle primitive | Worker/session 关联 | MCP 凭据 | Resume identity | 无头 wake | 诚实降级 |
|---|---|---|---|---|---|---|---|
| Claude Code | plugin manifest + Bash hooks | 9 事件族、含 Subagent start/stop | pre-spawn pending file + start event + session map | env / plugin MCP config | Claude session contract | 外部 CLI adapter | 字段不齐时依赖 pending claim；hook 失败时自动化下降 |
| Codex | plugin manifest + Bash hooks | 2 事件族、无 worker lifecycle hook | 主 Agent 显式 spawn/wait/close；daemon 保存 anchor→thread | literal Bearer in `config.toml` | runtime `thread_id` | `codex exec --json` | 无自动 worker session lifecycle；MCP 配置缺失时 wake 可继续但无 Chorus tools |
| Pi | TypeScript extension | native `pi.on(...)` events | mutable pre-spawn task 注入 + result mapping | env，或 `.mcp.json` fallback | Pi agent/session event | 宿主 extension | session 创建失败时 worker 继续但 observability 降级；orphan best-effort cleanup |
| Kiro | agent profile + Bash hooks | agentSpawn/stop/postToolUse | hook state；daemon 事后 diff session store | env interpolation in Kiro MCP config | runtime store `sessionId` | `kiro-cli --no-interactive` | ID 模糊时不猜；headless transcript 可退回 raw stdout |
| OpenClaw | native TypeScript plugin | service + SSE + embedded runtime | deterministic session key + host session helpers | host plugin config，API key 标记 sensitive | host session entry | in-process `runEmbeddedAgent` | 当前 single-cwd；宿主 helper 不可用时不能执行对应 wake |

这张表表达的是 contract mapping，不是能力排名。一个 runtime 可能 hook 更少但结构化 stdout 更强，也可能 worker injection 更强但 daemon transcript 较弱。

## 4. 设计深挖：从文本 Port 到语义 Adapter

### 4.1 先定义 semantic kernel

适配前应先写出不依赖宿主名词的 invariants。例如 task verification 流程可以定义为：

1. 实现者只能把 `in_progress` task 提交到 `to_verify`；
2. submission 必须引用 AC、自检与证据；
3. reviewer 使用独立上下文读取 authoritative task 与 documents；
4. reviewer 把结构化 `VERDICT` 写回 task；
5. 只有具备 `task:admin` 的身份可以决定 `to_verify → done`；
6. 任何宿主缺失自动 reviewer nudge 时，流程仍须通过 skill 或主 Agent orchestration 显式执行。

这些条件不包含 `SubagentStart`、`spawn_agent`、`subagent_spawn` 或 `runEmbeddedAgent`。它们是语义内核。

### 4.2 再建立 primitive inventory

每个 adapter 应回答一张固定清单：

- **Observe**：能观察哪些 lifecycle event？
- **Inject**：能在 main turn、worker spawn 前后注入什么？
- **Correlate**：runtime ID、Chorus session UUID 与业务 entity 如何映射？
- **Authenticate**：凭据由谁持有、何时读取、是否进入 argv/log？
- **Resume**：谁生成 session ID？如何避免跨 entity 串线？
- **Report**：能拿到结构化事件、token usage 与 transcript，还是只有 stdout？
- **Interrupt**：能否中止整个 process tree 或 embedded run？
- **Degrade**：缺失能力时，流程如何保持可见且不伪造成功？

只有 inventory 完成后，才应决定某段 skill 文本和哪段 adapter code 如何配合。

### 4.3 显式补偿，而不是伪装等价

Codex 缺少自动 sub-agent lifecycle integration 时，Chorus 没有模拟一个不存在的 hook，而是把责任提升到主 Agent：显式 spawn、wait、close，并把 task state 作为持久协调面。Kiro 无 ID-bearing stream 时，adapter 使用 store diff；结果模糊时宁可下次新开会话，也不猜一个 ID。Pi 有 mutable input，就把 session UUID 在 spawn 前注入，而不是复制 Claude Code 的 pending-file 方案。

这三种选择遵循同一原则：

> 优先保持可验证的业务语义；宿主能力不足时记录降级，不伪造低层行为一致。

### 4.4 把 credentials 当作协议的一部分

Credential delivery 经常被误归为安装细节，但它直接影响 identity isolation：

- Codex 的 literal header 与 `CODEX_HOME` 绑定；多 Agent 不同 key 需要隔离配置目录。
- Kiro 通过 environment interpolation，使 daemon 可按 child process 注入连接身份。
- Pi extension 自己也要调用 MCP bookkeeping，因此除主 Agent MCP gateway 外还需解析相同连接配置。
- OpenClaw 由 host plugin config 持有 key，并在 schema 中标记 sensitive。

若 adapter 只证明“tools/list 可见”，却没有证明请求以正确 Agent identity 发出，就没有证明语义可移植。

### 4.5 Agent-legible artifacts 降低 session 耦合

持久 artifact 是 runtime 差异的缓冲层。当一个 worker 没有继承父会话、Kiro resume 失败或 OpenClaw 启动新 session 时，Agent 仍能通过 Idea、Proposal、Task、Document、Comment 与 Report 重建状态。Progressive-disclosure skill 告诉 Agent 在哪个阶段读取哪些对象；OpenSpec mirror 让设计文件可在 repo 与 Chorus review surface 之间流动；AC 与 reviewer gate 把“完成”的判断从临时对话移到机械状态转换。

这不消除 context loss，但把恢复问题从“重现整个聊天”缩小为“读取 authoritative state + 必要证据”。

## 5. 诚实边界与局限

### 5.1 Runtime parity 不等于行为同一

五种 adapter 都能参与 Chorus AI-DLC，不代表它们在 hook 时序、worker observability、interrupt、transcript 或 token accounting 上完全相同。本文使用“语义可辨认”而不是“bit-for-bit equivalent”。

### 5.2 Skills 当前是手工移植

Chorus 没有 canonical workflow IR、adapter compiler 或自动 conformance generator。Claude Code、Codex、Pi、Kiro 与 OpenClaw 的 skills、agents、hooks 和 wrappers 存在手工维护面。`docs/OPENSPEC_MODE.md:5-12` 已明确记录其中两个 OpenSpec skill 无共享 canonical file。文档和实现可能漂移。

### 5.3 不是所有 workflow rule 都由服务端强制

Idea/Task 状态转换与权限检查属于较强的 server-side enforcement；“提交后立即 spawn 独立 reviewer”“完成后关闭 sub-agent”等仍部分依赖 skill、hook 或主 Agent 遵循协议。PostToolUse nudge 是提醒，不是不可绕过的事务。

### 5.4 Vendor primitive 会随版本变化

本文对 Kiro 2.12.1、Codex JSONL event、Pi extension event 与 Claude Code hook contract 的结论绑定到仓库基线所验证的版本。供应商增加、删除或重命名 event 后，adapter 与文档都必须重新验证。

### 5.5 Credential 与 session fidelity 不同

不同 runtime 的 credential 配置有不同泄漏面、轮换方式和多身份隔离成本。不同 transcript 也不能一概用于同等精度的审计：结构化 JSONL、host transcript 与 raw stdout 的信息量不同。

### 5.6 OpenClaw 与 Pi 都是 TypeScript，但不是同一种集成

Pi extension 订阅 coding-agent lifecycle，并在 `subagent_spawn` 前修改输入；OpenClaw plugin 维护后台 SSE service，并调用 embedded runtime。把二者归为“TypeScript adapter”会掩盖真正的 host contract。

### 5.7 未建立跨 runtime conformance benchmark

本文提供 grounded mechanism review 与 worked example，但尚无自动测试在五个真实 vendor binary 上执行完全相同的端到端 scenario，并比较最终 entity state、identity attribution、review evidence、resume 与 transcript。现有单元测试主要验证各 adapter 自身的 parser、mapping 和 failure path。

## 6. 评估与 Worked Example

### 6.1 评估方法

我们不以“安装成功”作为 portability 指标，而使用四类可观察结果：

1. **State convergence**：最终 task 是否沿合法路径到达 `done`；
2. **Attribution**：实现者、reviewer 与 admin 的身份、comment、report 是否可区分；
3. **Lifecycle accounting**：worker/session 是否被创建、关联、关闭，失败时是否留下可见降级；
4. **Recovery**：新的或恢复的 runtime session 能否从 authoritative artifacts 继续流程。

### 6.2 同一验证流程的五种映射

场景：开发者完成一个 task，调用 `chorus_submit_for_verify`；系统需要独立 reviewer 读取 AC 与实现证据，写回 `VERDICT`；admin 最终调用 `chorus_admin_verify_task`。

**Claude Code**

1. `PostToolUse` hook 在 submission 后发出 reviewer nudge。
2. 主 Agent 调用 `Task` 启动只读 reviewer。
3. `SubagentStart` 能观察该启动，但 `on-subagent-start.sh` 会识别并跳过 `chorus:task-reviewer`；只读 reviewer 不创建 worker session（`public/chorus-plugin/bin/on-subagent-start.sh:48-59`）。
4. reviewer 使用自己的独立上下文读取 task 与 AC，并写回 `VERDICT`。普通开发 worker 才走 pending claim、session 注入与 `SubagentStop` cleanup。

**Codex**

1. `PostToolUse` hook 发出相同业务 nudge。
2. 主 Agent 显式调用 `spawn_agent`，把 reviewer skill 挂到内置角色。
3. 主 Agent 显式 `wait_agent`，读取 reviewer 结果，再 `close_agent`。
4. Chorus task/comment 是权威进度；没有 sub-agent hook 自动替主 Agent 维护 worker session。

**Pi**

1. `tool_result` 识别 submission，并通过 steer message 提醒 reviewer。
2. reviewer 通过 blocking `subagent` 运行，`isWorkerAgent` 会把 Chorus reviewer 排除在 worker session 自动化之外。
3. 对普通开发 worker 的 `subagent_spawn`，`tool_call` 才会在执行前创建 Chorus session、修改 task 输入，并在结果返回后建立 `agentId → sessionUuid`。
4. 若普通 worker spawn 失败，extension 关闭预先创建的 orphan session。

**Kiro**

1. `postToolUse` hook 给出 reviewer nudge。
2. `agentSpawn` hook 的 plain-text stdout 提供 Chorus startup context。
3. headless daemon run 通过 `--agent chorus` 加载 MCP 与 skills，凭据由环境变量进入 plugin config。
4. 若 session store 无法给出唯一新 ID，adapter 不保存错误映射；transcript 回退 raw stdout。

**OpenClaw**

1. 后台 SSE 收到事件并路由到 in-process daemon client。
2. client 解析现有 session/workspace，调用 `runEmbeddedAgent`。
3. Agent 通过相同 MCP 工具读取 task、提交 reviewer result 或 admin decision。
4. lifecycle、interrupt 与 transcript 由 daemon client 回报；当前连接服务一个 cwd。

### 6.3 结果解释

五条路径使用不同 primitive，却可以检验同一组后置条件：

```text
task.status == done
review comment contains independently produced VERDICT
admin identity owns the final verify transition
durable task/AC/report state survives runtime session replacement
no adapter claims a worker/session mapping it could not establish
```

这就是 semantic portability 的可操作定义。它不要求所有 runtime 产生同样的 hook log，而要求关键业务状态、权限边界与证据协议收敛。

### 6.4 机制覆盖结果

| 检查项 | Claude Code | Codex | Pi | Kiro | OpenClaw |
|---|---:|---:|---:|---:|---:|
| 稳定 MCP / entity contract | 是 | 是 | 是 | 是 | 是 |
| 自动观察 worker start/stop | 是 | 否 | 通过 tool events | 受 agent hook 能力限制 | 依 host embedded runtime |
| spawn 前注入 worker session UUID | 间接：pre-spawn + start | 否 | 是：mutable input | 未宣称 | 不适用同一 spawn 模型 |
| 结构化 headless event stream | 依 Claude adapter | JSONL | 依 Pi host event | 否，plain stdout | host in-process event/report |
| 明确 session resume mapping | 是 | anchor→thread ID | agent/session map | anchor→store session ID，可能降级 | host session key/entry |
| 缺失能力时避免伪造成功 | best effort hook | 显式 orchestration | orphan cleanup / observability warning | ID 模糊不猜、stdout fallback | runtime 不可用则记录失败/不执行 |

该结果支持 RQ1 与 RQ2：稳定的是业务 contract；变化最大的是 lifecycle、identity correlation 与 transcript。缺失 primitive 可以由显式 orchestration 和 durable state 部分补偿，但不能被描述为完全自动化。

## 7. 讨论与 Roadmap

### 7.1 从手工 port 走向可验证 adapter

下一步不应只是继续复制更多 skill 目录，而应建立 machine-readable capability manifest，例如：

```yaml
runtime:
  lifecycle:
    session_start: true
    worker_start: false
    worker_stop: false
    mutable_pre_spawn_input: false
  session:
    id_owner: runtime
    structured_start_event: true
  credentials:
    delivery: config_literal
  transcript:
    fidelity: structured_jsonl
```

安装器和 skill 可以根据 manifest 选择策略；测试可检查 adapter 是否对缺失能力声明了 degradation。

### 7.2 定义 semantic conformance suite

Conformance 不应只 mock parser。建议建立最小跨 runtime scenario：

1. 启动并 check in；
2. 读取同一 task；
3. spawn 独立 reviewer；
4. 写回 `VERDICT`；
5. 中断并恢复；
6. 完成 admin verify；
7. 比较最终 entity graph、activity attribution、session closure 与 transcript evidence。

评分应区分 **required semantics** 与 **optional automation**。例如，独立 reviewer verdict 是 required；自动 worker session start/stop 是 optional capability，Codex 可通过显式管理通过核心 conformance。

### 7.3 生成共享文本，但保留 host binding

Chorus 可以从 canonical workflow source 生成重复的状态机说明、工具契约和 reviewer protocol，再在各 runtime 中保留小型 binding：

- 工具调用语法；
- sub-agent API；
- hook output envelope；
- wrapper 路径；
- credential 与 session contract。

这会减少 prose drift，但不能消除 adapter code。生成“共同语义”与手写“宿主绑定”应被视为两个构建产物。

### 7.4 把降级变成一等观测信号

当前 adapter 已有若干诚实降级：Codex 缺 MCP config 时 warning、Pi session 创建失败时 worker 继续但 observability 降低、Kiro ID 模糊时不保存、OpenClaw runtime helper 不可用时不执行 wake。未来应将这些统一为 control-plane capability/degradation event，使管理员能回答：

- 这次 task 是否完整归因到 worker session？
- transcript 是 structured、reconstructed 还是 raw stdout？
- reviewer 是自动触发还是主 Agent 手工触发？
- resume 延续了原 runtime session，还是从 durable artifact 重建？

### 7.5 用 repository contract 降低厂商锁定

OpenSpec mirror、结构化 AC、review comments 与 state machine 的价值，不只是提高单个 Agent 表现。它们把关键知识从 vendor-owned context window 移到 repo 与 Chorus control plane。Runtime 可以替换，authoritative artifact 仍可被下一个 Agent 读取。真正可移植的不是某段隐藏 chain-of-thought，而是可检查的状态、证据和约束。

## 8. 结论

跨 Agent 工作流不能靠复制同一份 prompt 或 skill 就获得。Chorus 的五种集成显示，真正的移植对象分为两层：稳定语义内核定义 entity、状态机、权限、artifact 和评审协议；runtime adaptation layer 负责 hook、context injection、worker/session correlation、credential、resume、headless wake 与 transcript。

Claude Code 用完整 lifecycle hook 自动管理 worker；Codex 用较小 hook surface 加主 Agent 显式 orchestration；Pi 利用 mutable pre-spawn input；Kiro 接受 plain-text hook 与事后 session-store 识别；OpenClaw 通过进程内 SSE service 和 embedded runtime 执行。它们不是相同实现，却能围绕同一业务 contract 收敛。

因此，Agent 标准化的关键不只是模型 API，也不只是 prompt 格式，而是**可持久、可授权、可恢复、可验证的工作流语义**。Chorus 已经给出一个可运行的多 runtime 样本；下一步是把手工 port 升级为 capability manifest、生成式共享语义和跨 vendor conformance suite。

## 参考文献

1. OpenAI, “Harness engineering: leveraging Codex in an agent-first world,” 2026. <https://openai.com/index/harness-engineering/>
2. Bits, Bytes, and Neural Networks, “From Prompts to Harnesses — Four Years of AI Agentic Patterns,” 2026. <https://bits-bytes-nn.github.io/insights/agentic-ai/2026/04/05/evolution-of-ai-agentic-patterns-en.html>
3. Anthropic, “Hooks reference,” Claude Code Documentation. <https://docs.anthropic.com/en/docs/claude-code/hooks>
4. Kiro, “Hooks,” Kiro CLI Documentation. <https://kiro.dev/docs/cli/hooks/>
5. Model Context Protocol, “Architecture,” MCP Documentation. <https://modelcontextprotocol.io/docs/learn/architecture>
6. Chorus-AIDLC, “Chorus source repository,” GitHub. <https://github.com/Chorus-AIDLC/Chorus>
7. Fission-AI, “OpenSpec,” GitHub. <https://github.com/Fission-AI/OpenSpec>
