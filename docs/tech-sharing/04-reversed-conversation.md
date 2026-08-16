# 反向对话：Agent 提议，人只在关键边界作决定

## Reversed Conversation: Agents Propose, Humans Decide at Key Boundaries

> 本文源码基线：`docs/tech-sharing` 分支，2026-08-16。源码位置以符号名为准，行号用于帮助定位。

## 摘要

传统的人机协作以“人给指令，Agent 执行”为默认结构；当 Agent 能持续规划、调用工具、修改代码并组织其他 Agent 时，这种逐步遥控既不能扩展，也不能证明关键决定发生在正确的位置。本文提出 **Reversed Conversation（反向对话）**：Agent 负责产生提案、任务分解、实现和证据，人或持有相应授权的治理主体只在高影响或需授权的状态转换上作决定。Chorus 将 Proposal、结构化 Acceptance Criteria（AC）、独立 reviewer、Task verification 和 Yolo 不自动合并组织为一套 state-machine policy，而非五个孤立功能。本文对照真实实现区分三类约束：服务端强制的状态与权限门禁、由 hook/skill 承载的行为门禁，以及尚未实现的 autonomy metrics。研究表明，Chorus 已具备 activity、daemon turn status、permissions、review/verify decisions 与 token usage 等原始可观测信号，但 **auditability 不等于 measurement**；系统目前没有经定义和验证的 autonomy score。本文最后给出一个可复现的工作示例、诚实边界，以及从审计轨迹走向 bounded-autonomy 度量的路线图。

## Abstract

Conventional human-agent collaboration assumes that humans issue instructions and agents execute them. That interaction model does not scale when agents can plan continuously, invoke tools, modify code, and coordinate other agents, nor does it prove that consequential decisions occur at the right boundaries. This paper presents **Reversed Conversation**: agents produce proposals, task decompositions, implementations, and evidence, while humans or explicitly authorized governance actors decide at high-impact or authorization-requiring state transitions. In Chorus, Proposals, structured Acceptance Criteria (AC), independent reviewers, Task verification, and the rule that Yolo does not merge without explicit human approval form one state-machine policy rather than five unrelated features. We ground the design in the implementation and distinguish server-enforced state and authorization gates, behavioral gates carried by hooks and skills, and proposed autonomy metrics that do not yet exist. Chorus already records raw observability signals including activity, daemon turn status, permissions, review and verification decisions, and token usage. However, **auditability is not measurement**: Chorus currently has no defined or validated autonomy score. We conclude with a worked lifecycle, explicit limitations, and a roadmap from audit trails toward measurable bounded autonomy.

---

## 1. 引言与动机

### 1.1 从逐步遥控到决策边界

早期 coding assistant 的协作单位是一次 prompt：人描述需求，模型回复代码，人逐段确认。到 2026 年，coding agent 的协作单位已经扩展为一个长生命周期：澄清需求、形成设计、拆分任务、按依赖执行、运行测试、请求复核、修复问题并准备交付。若人仍需批准每一个读文件、搜索和测试动作，吞吐会被确认对话锁死；若把所有动作一次性放开，又会把需求误解、权限滥用和未经验证的交付压缩成一次不可见的风险。

问题因此不再是“是否让 Agent 自主”，而是：

1. 哪些状态转换可由执行者推进？
2. 哪些转换需要不同权限或不同主体？
3. 决策前必须存在什么证据？
4. 失败后是否有明确的返回边？
5. 哪些控制是服务端强制，哪些只是 Agent 被要求遵循？

反向对话把人的注意力从操作步骤移到这些问题上。Agent 不是等人逐步派活，而是主动把工作推进到一个决策面：提交 Proposal、提交待验证 Task、提交 reviewer verdict、提交合并请求。人看到的不是“下一步该点什么”，而是“是否允许状态机越过这条边”。

### 1.2 关键边界不等于严格不可逆

本文刻意使用“高影响或需授权的状态转换”。Proposal approval 可以通过 revoke 回到 draft；Task verification 失败可以从 `to_verify` 回到 `in_progress`；reviewer verdict 本身甚至不改变实体状态。它们都不应被笼统描述为严格不可逆。

这些边界仍值得集中 human attention，因为它们可能：

- 把规划草稿物化为可执行 Task 与正式 Document；
- 让下游依赖从阻塞变为可执行；
- 代表组织对“完成”的语义确认；
- 允许代码进入 PR、merge、deploy 等外部副作用阶段；
- 把原本属于人的判断授权给持有 `*:admin` 的 Agent。

因此，Reversed Conversation 的核心不是“人只处理不能撤销的动作”，而是“人不再逐步遥控执行，只在风险、授权、语义确认和外部副作用边界作决定”。

---

## 2. 背景与相关工作

### 2.1 现实中的自主性是按动作分层的

MindStudio 的 Permission Ladder 将 Agent 自主性分为 read-only、suggest、supervised execution、monitored autonomy 与 full autonomy，并强调同一 workflow 的不同步骤可以位于不同层级，应按 action 而非按整个 Agent 分类 [1]。这个视角比“这个 Agent 是自动还是手动”更接近工程现实：同一个 Agent 可以自主读代码和跑测试，却不能自行批准 Proposal 或合并 PR。

Anthropic 对 Claude Code 与 public API 中数百万次 human-agent interactions 的隐私保护分析发现：80% 的 tool calls 来自看起来至少带一种 safeguard 的 Agent，73% 看起来以某种形式有人在环，只有 0.8% 的动作看起来不可逆 [2]。这些数字描述的是 Anthropic 样本与分类方法，不是 Chorus 的测量结果；“看起来”也反映了研究者对真实外部执行结果可见性有限。它们支持的不是“风险已经很低”，而是两个更谨慎的结论：

1. 真实部署通常同时包含自主执行与监督；
2. 平均值会掩盖少量高后果动作，监督应针对 action 与后果设计。

### 2.2 从 HITL 到 HOTL

Human-in-the-loop（HITL）常被理解为人批准每一步；Human-on-the-loop（HOTL）则允许系统持续运行，人监控并在必要时介入。两者并非互斥。一个工程工作流可以让低影响动作 HOTL 化，同时在 Proposal approval、Task verification 和 merge 前保持 HITL。

NIST AI RMF 1.0 的 GOVERN 3.2 要求为 human-AI configuration 与 oversight 明确定义角色和责任 [3]。这提示我们：监督不能只写成“必要时由人检查”的原则，它需要落实到身份、权限、状态、证据和可追踪决定。

### 2.3 Chorus 的研究问题

本文不把 Chorus 描述为一个通用安全证明，而研究一个更窄的问题：

> 能否用可持久化的状态机，把 Agent 的高吞吐执行与人的稀缺判断分开，同时保留回退路径和证据？

回答该问题需要同时观察 Proposal、Task、AC、reviewer、permissions 与 daemon telemetry。只介绍其中任意一个功能，都会丢失真正的系统性质。

---

## 3. Chorus 架构与机制

### 3.1 一套 policy，两个主状态机

Proposal 的主要路径是：

```text
draft --submit--> pending --approve--> approved
  ^                  |
  |                  +--reject(reason)--> draft
  |
  +--revoke approved; close tasks; delete materialized docs-- approved
```

Task 的服务层声明了明确转换表：

```text
open -> assigned -> in_progress -> to_verify -> done
  \        \             \            |
   \        \             \           +-> in_progress (reopen)
    +-------------------------------> closed
```

`TASK_STATUS_TRANSITIONS` 位于 `src/services/task.service.ts:140-148`。重要的不只是状态名，而是人的决策被放在 `pending -> approved` 与 `to_verify -> done`，Agent 的执行则主要发生在这些边之间。

### 3.2 Proposal submission：先证明可审，再请求决定

`submitProposal` 只允许 `draft -> pending`，并在转换前调用完整 validation（`src/services/proposal.service.ts:1089-1127`）。其中 error-level 条件包括：

- 至少一个 document draft；
- document content 至少 100 字符；
- 至少一个 task draft；
- 至少一个输入来源；
- 输入 Idea 的 elaboration 已 resolved；
- 每个 task draft 有结构化 AC。

这些检查位于 `validateProposal`（`src/services/proposal.service.ts:234-343`）。它们不是 reviewer 的主观建议，而是 submission 的服务端前置条件。Agent 可以自主写 Proposal，但不能把一个结构不完整的 draft 推到审批队列。

### 3.3 Proposal approval：权限边界与物化副作用

REST approval route 对 Agent 要求 `proposal:admin`，对 human user 放行，并且只接受 `pending` Proposal（`src/app/api/proposals/[uuid]/approve/route.ts:14-51`）。MCP 侧 `chorus_admin_approve_proposal` 同样映射到 `proposal:admin`（`src/mcp/tools/permission-map.ts:82-84`）。

`approveProposal` 在 transaction 中完成三类动作（`src/services/proposal.service.ts:774-899`）：

1. Proposal 变为 `approved`，记录 reviewer 与时间；
2. document drafts 物化为 Documents；
3. task drafts、依赖边和 AC 物化为 Tasks、TaskDependency 与 AcceptanceCriterion。

因此 approval 是高影响转换：它从“可编辑计划”生成“可执行工作图”。但它不是绝对不可回退。`revokeProposal` 允许 `approved -> draft`，同时关闭已物化 Tasks、删除已物化 Documents，并清理外部依赖（`src/services/proposal.service.ts:932-1017`）。回退本身有明显代价，所以 revoke route 要求 `proposal:write`、approved 状态并记录 activity（`src/app/api/proposals/[uuid]/revoke/route.ts:14-67`）。

Proposal rejection 也说明该状态机是对话而非单向流水线：pending Proposal 可带必填 `reviewNote` 返回 draft（`src/app/api/proposals/[uuid]/reject/route.ts:38-68`）。反馈成为下一轮修订的持久输入。

### 3.4 Task submission：执行者可以提交，不能自称完成

`chorus_submit_for_verify` 要求 `task:write`，还执行两个 handler-level guard：

- 调用者必须是 assignee；
- Task 必须处于 `in_progress`。

满足后才写入 `to_verify` 并记录 `submitted` activity（`src/mcp/tools/developer.ts:164-210`）。`to_verify` 不会解锁下游依赖；只有 admin verification 产生的 `done` 才算 resolved。这把“我做完了”与“系统接受完成”拆成两个状态。

这种拆分也限制了权限语义：`task:write` 允许实现者声明 ready for review，`task:admin` 才允许代表治理主体确认 done。权限映射见 `src/mcp/tools/permission-map.ts:68-73,85-92`。

### 3.5 Acceptance Criteria：自检证据与验收决定分栏

AcceptanceCriterion 同时保存两组字段：

- developer self-check：`devStatus`、`devEvidence`、`devMarkedBy*`；
- admin verification：`status`、`evidence`、`markedBy*`。

`reportCriteriaSelfCheck` 只写 developer 字段（`src/services/task.service.ts:934-971`）；`markAcceptanceCriteria` 写 admin 字段（`src/services/task.service.ts:894-931`）。这不是重复数据，而是把“执行者声称”与“验收者判断”保留下来。

需要精确说明的是：当前 `chorus_submit_for_verify` **不会**检查所有 `devStatus` 是否 passed。self-check 是 skill 所要求的工作流纪律，不是 submission 的硬 gate。真正的服务端 completion gate 位于 `checkAcceptanceCriteriaGate`：若存在结构化 AC，所有 required 项的 admin `status` 必须为 `passed`，否则 `chorus_admin_verify_task` 拒绝 `to_verify -> done`（`src/services/task.service.ts:1021-1054`；`src/mcp/tools/admin.ts:149-177`）。

为兼容旧 Task，零条结构化 AC 时 gate 放行。这是明确的 backward-compatibility 例外，而不是“每个历史 Task 都机械满足 AC”。

### 3.6 Verification 与 reopen：确认完成，也允许返工

`chorus_admin_verify_task` 要求 `task:admin`、当前状态为 `to_verify`，并通过 required-AC gate，之后才写 `done` 和 `verified` activity（`src/mcp/tools/admin.ts:149-192`）。

验证失败时，`chorus_admin_reopen_task` 可执行 `to_verify -> in_progress`（`src/mcp/tools/admin.ts:195-260`）。从 `to_verify` 返回非 `done` 状态时，`updateTask` 在 transaction 内把 developer 与 admin 两组 AC 结果都重置为 pending（`src/services/task.service.ts:627-648`）。返工不是继续沿用旧证明，而是要求在新实现上重新建立证据。

这说明 verify 是语义确认边界，但并非严格不可逆。Chorus 的价值来自显式边和证据失效规则，而非假装状态永远不会后退。

### 3.7 Independent reviewer：独立判断，行为门禁

Chorus 定义 Proposal、Task 与 aggregate code 三类 read-only reviewer。reviewer 只读取目标、文档、评论和代码，并写一个 `VERDICT: PASS | PASS WITH NOTES | FAIL` 评论。canonical pattern 位于 `public/skill/chorus/SKILL.md:415-444`。

Claude Code plugin 在以下工具调用后通过 PostToolUse hook 注入 reviewer nudge：

- `chorus_pm_submit_proposal`；
- `chorus_submit_for_verify`；
- `chorus_admin_verify_task`（最后一个 Task 后触发 aggregate review 检查）。

注册见 `public/chorus-plugin/hooks/hooks.json:24-51`。具体 hook 提示 `FAIL` 时不要 approve/verify，而应 reject/reopen 并修复（`public/chorus-plugin/bin/on-post-submit-proposal.sh:48-60`；`on-post-submit-for-verify.sh:48-60`）。Pi extension 与 Kiro hooks 实现同一语义，但映射到各自 runtime primitive。

必须诚实标注：reviewer verdict **是 advisory**。服务端 approval/verification handler 不读取 `VERDICT` 评论，也不会因 `FAIL` 自动阻塞。hook 只是提醒主 Agent spawn reviewer，且 reviewer 不可用时 skill 允许 inline fallback。它是 harness 执行的 behavioral gate，不是数据库状态机的硬 gate。

### 3.8 Yolo：自动推进不等于自动发布

普通 Idea/Proposal workflow 的默认边界是提交 Proposal 后停止；工具可见、持有 permission，甚至 Proposal 已获批准，都不等于 Agent 被授权连续执行剩余 Task。只有人显式触发 `start_development`，才表示按依赖顺序执行该 Proposal 的剩余 Task；显式触发 Yolo，则授权 workflow 跨阶段推进到 verification 与 completion report（`public/skill/idea-chorus/SKILL.md:341-342`；`public/skill/develop-chorus/SKILL.md:272-273`）。

Yolo 把 planning、proposal review、wave execution、task verification 与 aggregate code review 串成完整流程（`public/skill/yolo-chorus/SKILL.md:20-50`）。在 Proposal/Task review FAIL 时，它按 skill 规则 reject/reopen；超过 review round 上限则升级给人（同文件 `282-343,398-481`）。

“Yolo 不 merge/push，除非有明确 human approval”出现在 Idea/Develop handoff policy，以及 OpenClaw 的 `yolo_requested` runtime prompt：

- `public/skill/idea-chorus/SKILL.md:342`；
- `public/skill/develop-chorus/SKILL.md:273`；
- `packages/openclaw-plugin/src/event-router.ts:435-450`。

这条规则是重要的外部副作用边界，但目前不是 Git server、repository protection rule 或 Chorus 服务端 merge API 强制的。Yolo skill 本身也没有执行 merge 的 MCP tool。准确说法是：Chorus 的官方 workflow 与 wake prompt 要求 Yolo 停在发布边界；真正防止绕过还需要 branch protection、CI、runtime sandbox 或 repository policy。

### 3.9 原始可观测信号

Chorus 已有五类与 bounded autonomy 相关的原始信号：

| 信号 | 实现落点 | 能说明什么 | 不能单独说明什么 |
|---|---|---|---|
| Activity | `activity.service.ts:47-158`；`prisma/schema.prisma:411-435` | 谁、何时、对哪个实体执行了何种动作 | 动作是否正确、风险多高 |
| Daemon turn status | `daemon-session.service.ts:65-105,602-769` | turn 的 pending/running/ended/interrupted/merged 生命周期 | Agent 是否做出好决策 |
| Permissions | `permission-map.ts:23-98`；`docs/PERMISSIONS.md:10-47` | 哪个主体被授予哪些调用能力 | 权限是否在每个外部系统都有效 |
| Review/verify decisions | VERDICT comments、Proposal review fields、AC marks、Activity | 哪些 gate 被通过、拒绝或返工 | reviewer 的准确率与独立性 |
| Token usage | `daemon-session.service.ts:117-130,704-735`；`schema.prisma:736-742` | 每 turn 的归一化 token 与 session rollup | 成本、产出价值或 autonomy 水平 |

Activity 记录 `actorType`、`actorUuid`、target、action、value 与可选 session attribution；daemon turn 则严格执行 `pending -> running -> ended|interrupted`，并在 terminal edge 持久化归一化 token usage。它们提供审计和后续计算的底座，但没有自动形成一个 autonomy 结论。

---

## 4. 设计深挖：把协作写成状态机策略

### 4.1 Policy 的五个组成部分

一个可执行的反向对话 policy 至少包含：

1. **Proposer**：谁可以产生候选状态，例如 PM Agent 提交 Proposal、Developer Agent 提交 Task；
2. **Gate**：哪个转换必须经过特定权限、状态与证据；
3. **Decider**：谁能批准、拒绝、验证或 reopen；
4. **Evidence**：Proposal drafts、AC evidence、tests、VERDICT、reviewNote；
5. **Recovery edge**：失败后回到哪个状态，旧证据是否失效。

Chorus 的关键贡献不是引入新的“批准按钮”，而是让这五项在持久化实体上组合。一个 Agent session 可以结束，Proposal、Task、AC、comments 与 activities 仍保留；下一位人或 Agent 可以从 authoritative state 继续。

### 4.2 Hard gate、behavioral gate 与 external gate

本文将控制分为三层：

| 层 | 例子 | 强制点 | 绕过条件 |
|---|---|---|---|
| Hard gate | pending 才可 approve；required AC passed 才可 done；`*:admin` 权限 | REST/MCP handler + service/database transaction | 其他未受控写路径、过宽 admin credential |
| Behavioral gate | spawn independent reviewer；FAIL 不继续；Yolo review loop | skill、hook、runtime prompt、orchestrator | Agent 忽略提示、hook 被禁用、inline review 降低独立性 |
| External gate | 未获人批准不得 merge/push | repo protection、CI、Git host、runtime sandbox | Chorus 当前不能单独覆盖的 shell/network/git 路径 |

把三者都叫“服务端 gate”会夸大能力；把 behavioral gate 说成“只是 prompt”又会忽略其可移植 workflow contract、持久 VERDICT 和失败循环。严谨的治理需要同时描述 enforcement point 与 bypass path。

### 4.3 权限代表授权，不保证主体独立

`proposal:admin` 与 `task:admin` 被设计为 human-level permission，但 Chorus 允许把它们授给 Agent。`admin_agent` preset 持有全部 15 bits；custom permission 甚至可以让 Developer Agent 获得 `task:admin`（`docs/PERMISSIONS.md:31-47`）。

因此，状态机表达的是“需要 admin authority”，不是“数据库证明一个自然人亲自点击”。Yolo 能自动 approve/verify，正是因为它使用带 admin bits 的 credential。要实现真正的 separation of duties，还需：

- 对 author 与 approver 建立不同 principal 约束；
- 禁止同一 principal 同时持有 write 与对应 admin；
- 对高风险项目要求 user-only approval；
- 将 approval 与组织身份、MFA 或 change-management system 对接。

### 4.4 Evidence 不等于 truth

AC 把 definition of done 结构化，reviewer 把独立检查持久化，tests 提供可重复证据。但这些机制仍可能共同犯错：

- AC 写错了，所有 required 项通过也可能交付错功能；
- reviewer 与 implementer 使用同一模型或共享错误假设；
- 测试覆盖了实现，却没有覆盖真实外部系统；
- `reviewNote` 存在，不代表决定经过充分推理。

State-machine policy 能证明“规定的程序发生了”，不能直接证明“结果在现实世界正确”。这也是 human attention 应落在语义确认而不只是机械勾选上的原因。

---

## 5. 诚实边界与局限

### 5.1 Auditability 不等于 measurement

Chorus 能回答“发生了什么、谁执行、在哪个 turn、用了什么权限、是否被 verify”，但目前没有：

- autonomy score 的正式定义；
- 指标的单位、窗口和分母；
- 与风险或结果质量的校准数据；
- 跨 runtime 的可比性验证；
- 对不同项目难度和 action impact 的归一化；
- score 与治理决策之间的 validated threshold。

所以本文不会把 activity 数、token 数或无人干预 turn 数直接命名为“自主性”。它们只是待建指标的输入。

### 5.2 `coalescedCount` 与 orphan reconciliation 不是 autonomy metric

`coalescedCount` 描述同 session wake 被批处理后有多少 pending turns 应结算为 `merged`；orphan/session reconciliation 处理崩溃、断线或 spawn 失败后的执行一致性。二者衡量的是 execution reliability 与 recovery hygiene。

一个系统可以拥有完美的 wake coalescing，却把所有高风险动作完全放开；也可以频繁 reconcile orphan，却始终要求人批准每个关键动作。把这些信号混进 autonomy score 会混淆“运行得是否可靠”与“被授权自主到什么程度”。

### 5.3 Reviewer 不是硬门禁

reviewer hook 可以关闭，main Agent 可以忽略 additional context，某些 runtime 只能 inline self-review，VERDICT comment 也不被 approval/verify handler读取。当前系统依靠 workflow compliance 将 reviewer 放在 gate 前。

Roadmap 若要把它升级为 hard gate，应增加结构化 ReviewDecision 实体或签名状态，并让 approve/verify handler 检查最新有效 verdict、reviewer identity、round 与被审对象版本，而不是解析自由文本评论。

### 5.4 Yolo no-merge 不是 repository enforcement

Chorus 只控制经过其 control plane 的动作。若 runtime 拥有不受限 shell、filesystem、network 与 Git credentials，它可能直接 push 或调用 Git hosting API。当前 no-merge 是官方 workflow policy，不是完整 reference monitor。

生产部署应把 merge authority 留在 Git provider，以 protected branch、required checks、CODEOWNERS 或 deployment approval 实施最终控制。

### 5.5 历史兼容与权限过宽

无结构化 AC 的旧 Task 可通过 verification gate；`chorus_create_tasks` 目前是 public tool；`task:admin` 与 `proposal:admin` 不区分对象作者与审查者。它们都是实际 coverage gap，不能用“已有状态机”掩盖。

### 5.6 外部研究不能替代本系统评估

Anthropic 的 80%、73% 与 0.8% 来自其 Claude Code/public API 样本和分类方法。Chorus 没有复现该测量，也不能据此声称自己的工作流达到相同 safeguard、HITL 或 reversibility 比例。

---

## 6. 评估与 Worked Example

### 6.1 案例：一个包含迁移、服务与 API 的功能

设一个 Agent 要实现“为订单增加风险等级”。Proposal 包含：

- Tech Design：数据模型、回滚策略、权限影响；
- Task A：数据库 migration；
- Task B：service 读写，依赖 A；
- Task C：API contract 与 integration test，依赖 B；
- 每个 Task 至少一个 required AC。

从状态机观察完整协作：

| 步骤 | 发起者 | 转换/产物 | 系统强制 | 人或授权主体的决定 |
|---|---|---|---|---|
| 1 | PM Agent | 创建 draft | Proposal row | 无 |
| 2 | PM Agent | draft -> pending | validation：doc、task、resolved elaboration、AC | 无 |
| 3 | reviewer | VERDICT comment | 无硬 gate；hook/skill 提醒 | Admin 读取 verdict |
| 4 | Admin/user | pending -> approved | `proposal:admin`/human + pending | 接受规划并物化工作图 |
| 5 | Developer Agent | assigned -> in_progress -> to_verify | assignee、状态、依赖 | 无 |
| 6 | task reviewer | VERDICT + evidence | 行为门禁 | Admin 判断证据 |
| 7 | Admin/user | mark AC；to_verify -> done | `task:admin` + required AC passed | 确认 definition of done |
| 8 | scheduler | 解锁下游 Task | 依赖只认 done/closed | 无 |
| 9 | aggregate reviewer | Idea-level VERDICT | 行为门禁 | 是否进入 ship |
| 10 | human/repo | merge/deploy | 外部 repository policy | 接受外部副作用 |

这个例子体现“Agent 提议，人决定”的真正含义：人没有批准每次 SQL 查询、文件编辑和测试运行，却仍控制计划物化、完成语义与发布。

### 6.2 失败路径

若 Proposal reviewer 发现 migration 无回滚方案：

```text
pending --reject(reviewNote)--> draft --revise--> pending
```

若 Task reviewer 发现 API 未验证权限：

```text
to_verify --reopen--> in_progress
AC marks reset -> implement fix -> self-check -> to_verify -> verify
```

若 aggregate reviewer 发现跨 Task contract 不一致，Yolo 不重开已 done Task，而是在 approved Proposal 上创建 fix Task，重新经过 AC、task review 与 verification。每条失败路径都产生持久 artifact，而不是只存在于某次 chat context。

### 6.3 可以机械核验的性质

基于实现，可核验以下性质：

1. 非 draft Proposal 不能 submit；
2. validation error 会阻止 pending；
3. 非 pending Proposal 不能通过正常 route approve；
4. 无 `proposal:admin` 的 Agent 不能 approve；
5. 非 assignee 不能通过 developer tool submit for verify；
6. 非 `to_verify` Task 不能 verify/reopen；
7. required AC 未全部由 admin 标为 passed 时不能 done；
8. reopen 会使旧 AC 证据失效；
9. `to_verify` 不解锁依赖，`done/closed` 才解锁。

不可仅凭服务端核验的性质包括 reviewer 一定运行、VERDICT 一定被遵守、Yolo 一定没有通过 shell push，以及最终人类判断一定正确。

---

## 7. 讨论与 Roadmap

### 7.1 从原始信号到候选 metrics

以下指标是 **待设计的 roadmap proposals**，不是 Chorus 当前能力：

| 候选指标 | 初步定义 | 需要的校准 |
|---|---|---|
| 无干预连续时长/turn 数 | 两次 human decision 之间的 elapsed time 与 completed turns | 区分等待、卡死与有效工作 |
| 高影响转换审批占比 | 被标为 high-impact 的转换中，需要 user/admin approval 的比例 | 先建立 action impact taxonomy |
| Permission exposure | 每个 turn 实际可见/可用 capability 的风险加权面积 | 权限存在不等于被调用 |
| Failure recoverability | 失败后回到一致状态并重新通过 gate 的成功率/时间 | 区分模型错误与基础设施故障 |
| Human rejection/rework rate | Proposal reject、Task reopen、review FAIL 的条件化比例 | 按任务难度与 reviewer 政策归一 |

这些指标不应被简单加权成一个看似精确的总分。至少应先回答：测量对象是 Agent、session、workflow 还是 action？“更高”代表效率更好还是风险更大？不同项目是否可比较？

### 7.2 建议的数据模型

可新增结构化 PolicyDecision：

```text
decisionUuid
targetType / targetUuid / targetVersion
transitionFrom / transitionTo
impactClass
requiredAuthority
deciderType / deciderUuid
evidenceRefs[]
decision: allow | deny | request_changes
createdAt
```

它能把自由文本 Activity 与 VERDICT 提升为可查询决策，不必从评论中猜测。配合 version binding，可防止“review 通过后内容又被修改”的证据漂移。

### 7.3 把 behavioral gate 升级为 enforceable policy

优先级建议：

1. approve/verify 可配置要求有效 reviewer decision；
2. author 与 approver 可配置 separation of duties；
3. high-impact transition policy 按 project 风险级别设置；
4. merge/deploy 对接 Git provider 与 CI evidence；
5. 每次授权记录 permission snapshot，而非只读当前权限；
6. 建立 metric definitions、测试数据与误差分析后，再展示 autonomy dashboard。

### 7.4 不追求“最少人类点击”

优化目标不应是把 human intervention 降到零。更合理的目标是：

- 低风险执行尽量连续；
- 高影响转换有明确授权；
- 人看到足够但不过载的 evidence；
- 拒绝后能低成本恢复；
- Agent 的权限暴露与工作需要相称；
- 每个决定能被重放和追责。

这比单一 autonomy level 更符合现实：同一 workflow 可以同时拥有高执行自主性和严格发布治理。

---

## 8. 结论

Reversed Conversation 不是把人从流程中删除，而是重构人出现的位置。Agent 负责将模糊意图转成 Proposal，将 Proposal 转成 Task DAG，将实现转成 AC evidence 与 reviewer input；人或显式授权的治理主体负责让状态机越过高影响或需授权的边。

Chorus 已经通过 Proposal validation/approval、Task submission/verification、双栏 AC、permissions、reopen/revoke 与持久 activity 建立了可执行骨架。Independent reviewer 与 Yolo no-merge 补充了跨 runtime 的行为政策，但它们目前不是全部由服务端强制；repository 外部副作用仍需要 Git/CI/OS 层控制。

最后，审计底座不是 autonomy measurement。Activity、turn status、permission、review/verify 与 token usage 让未来度量成为可能，却尚未构成一个经定义和验证的 score。负责任的下一步不是先画一个仪表盘，而是先定义 action impact、决策主体、指标分母、恢复语义和验证方法。

---

## 参考文献

1. MindStudio, “How to Grant AI Agents the Right Level of Autonomy,” *The Permission Ladder*. https://www.mindstudio.ai/blog/ai-agent-permission-ladder-autonomy-levels
2. Anthropic, “Measuring AI agent autonomy in practice.” https://www.anthropic.com/research/measuring-agent-autonomy
3. NIST, *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*, NIST AI 100-1, 2023. https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf
4. Chorus, `docs/PERMISSIONS.md`, permission model and enforcement boundaries.
5. Chorus, `docs/MCP_TOOLS.md`, Proposal, Task, AC, and verification tool contracts.
6. Chorus, `src/services/proposal.service.ts`, Proposal validation, approval, reject, and revoke implementation.
7. Chorus, `src/services/task.service.ts`, Task state transitions and Acceptance Criteria implementation.
8. Chorus, `public/skill/chorus/SKILL.md`, independent reviewer contract.
9. Chorus, `public/skill/yolo-chorus/SKILL.md`, automated review and verification loops.
