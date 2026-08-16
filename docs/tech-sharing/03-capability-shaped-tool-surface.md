# Capability-Shaped Tool Surface

## 权限即工具面，也是一份认知预算

> 本文基于 Chorus 仓库基线 `cbbe886a`。行号用于定位该基线附近的实现；代码演进后应以文件路径与符号名为准。

## 摘要

Agent 的权限通常被理解为调用之后的允许或拒绝，工具则被理解为权限检查之前的一张固定菜单。这个分工在工具数量很少时尚可工作；当 Agent 同时连接多个 MCP server、工具定义持续占用 context、相似工具产生选择歧义时，固定菜单既扩大攻击面，也消耗模型的认知预算。本文以 Chorus 为案例提出 capability-shaped tool surface：用 `{resource}:{action}` 权限同时塑造 Agent 能看到的 MCP `tools/list` 和实际调用时的授权路径。Chorus 在每个无状态 MCP 请求中重新读取 Agent 记录、计算 role preset 与 custom permission 的并集，并只为当前身份注册其有权使用的 45 个 permission-managed tools；REST route 继续执行同一 permission bit 的 403 gate，handler/service 再检查 assignee、ownership、状态机和依赖等领域不变量。基线实现还包含 37 个始终可见的 public/session tools；developer、PM、admin 分别看到 42、72、82 个工具。该数据同时揭示边界：工具裁剪不是完整 reference monitor，部分 public mutation tools 仍有较宽能力，MCP handler 并不经过 REST route，且 Chorus 尚未完成按任务动态授权、按需 tool search 或工具选择准确率评估。本文因此把“权限即工具面”定义为 defense-in-depth 与 context engineering 的结合，而不是把隐藏工具误称为安全。

## Abstract

Agent permissions are often treated as post-invocation allow/deny checks, while tools are presented as a fixed menu before authorization. That separation becomes costly when agents connect to many MCP servers: tool definitions consume context, overlapping verbs create selection ambiguity, and irrelevant capabilities expand the exposed attack surface. This paper studies Chorus and proposes a capability-shaped tool surface in which `{resource}:{action}` permissions shape both MCP `tools/list` discovery and execution-time authorization. On every stateless MCP request, Chorus reloads the Agent record, computes the union of role presets and custom permission bits, and conditionally registers 45 permission-managed tools. Parallel REST routes retain 403 permission gates, while handlers and services enforce assignee, ownership, state-transition, and dependency invariants. The studied baseline also has 37 always-visible public/session tools; developer, PM, and admin presets see 42, 72, and 82 tools respectively. These measurements expose the limits: discovery filtering is not a complete reference monitor, some public mutation tools remain broad, MCP handlers do not traverse REST routes, and Chorus has not yet implemented task-scoped elevation, on-demand tool search, or selection-accuracy benchmarks. Capability shaping is therefore a defense-in-depth and context-engineering technique, not security by hiding tools.

## 1. 引言与动机

### 1.1 工具面已经成为 Agent 的输入

传统 API client 由程序员选择 endpoint；Agent client 则通常把工具名称、描述和 schema 交给模型，由模型决定调用哪个工具。MCP 规范把 tools 定义为 model-controlled primitive：client 通过 `tools/list` 获取 catalog，模型再根据上下文发起调用[1]。这意味着工具面不只是后端接口清单，也是模型每一轮决策的输入。

工具面扩大后，会同时出现两个问题。

**安全问题。** 一个只负责实现 Task 的 developer Agent 如果能看到 proposal approval、task verification 或 document deletion，即使调用最终得到 403，这些高影响动作仍进入模型的可选行动空间。错误调用、prompt injection 和权限实现漂移都更难审计。

**认知问题。** Anthropic 对 MCP 工程的分析指出，工具定义和中间结果会持续占用 context；连接成百上千工具时，定义本身就可能消耗大量 token[2]。其 tool search 文档进一步建议在 10 个以上工具或定义超过 10k token 时考虑按需发现，并报告工具数量超过约 30–50 后选择准确率会下降[3]。这些是特定平台的工程观察，不等于 Chorus 已测得同样的退化曲线，但足以说明“给模型更多工具”并非单调增益。

### 1.2 从固定菜单到 capability-shaped surface

本文的核心主张是：

> 权限不应只在调用后决定“能不能做”，还应在发现阶段决定“哪些动作值得进入 Agent 的选择空间”；同时，发现阶段的裁剪必须与调用时授权和领域不变量组成双层以上的一致性防线。

这里的 “capability” 不是把 tool name 当作不可伪造的 object capability。它指的是一项可调用业务能力，由身份、permission bit、工具注册和 handler guard 共同约束。工具不可见能减少误选和暴露，但不能替代服务器授权。

### 1.3 研究问题

本文回答四个问题：

- **RQ1：** Chorus 如何从 Agent 身份推导出每次请求的工具 catalog？
- **RQ2：** `tools/list` 裁剪如何与 REST、handler 和 service gate 保持一致？
- **RQ3：** 当前裁剪对不同 Agent preset 的工具面有多大影响？
- **RQ4：** 现有机制在哪些路径上仍不是最小权限或最小 context？

## 2. 背景与相关工作

### 2.1 MCP 的 discovery 与 invocation

MCP tools 协议区分 discovery 和 invocation。`tools/list` 返回 name、description、input schema 等模型选择工具所需的 metadata；`tools/call` 才执行具体操作[1]。协议没有要求每个身份必须看到相同 catalog，也没有把 tool annotation 定义为可信授权。服务端可以按认证上下文构造不同列表，但最终调用仍必须在可信执行路径授权。

因此，一项 mutation capability 至少有两个检查点：

1. **Discovery gate**：当前身份是否应该看到这个工具？
2. **Invocation gate**：即使收到调用，服务器是否允许这个身份和这个对象执行动作？

Chorus 又增加第三类：

3. **Domain gate**：permission bit 足够后，是否满足 assignee、owner、status、dependency、acceptance criteria 等业务不变量？

### 2.2 Permission ladder：按动作分级

业界 permission ladder 的共同思想，是不要给整个 Agent 一个粗粒度的“自动/不自动”标签，而要按动作风险逐级授权[4]。Chorus 将这一思想编码为 5 个 resource 与 3 个 action：

```text
resource ∈ {idea, proposal, document, task, project}
action   ∈ {read, write, admin}
permission = resource:action
```

`read`、`write`、`admin` 是独立 bit，不自动继承。`task:admin` 并不隐含 `task:read` 或 `task:write`；常用 preset 只是显式包含相应前缀（`src/lib/authz/types.ts:1-19`，`src/lib/authz/presets.ts:3-41`）。

这种设计优于把逻辑绑定到 “developer/PM/admin” 名称。Role 是便捷 preset，permission 才是授权问题的词汇。

### 2.3 工具设计也是 context engineering

工具数量不是唯一变量。Anthropic 的工具设计经验强调：

- 每个工具应有清晰且互不重叠的目的；
- vague 或 overlap 会让 Agent 选择错误策略；
- namespacing、输入 schema 和描述质量都应通过 evaluation 调整[5]。

因此，工具面治理至少有四个互补手段：

1. **过滤**：不给当前身份注册不相关能力；
2. **去重**：删除语义重叠的 alias；
3. **瘦描述**：把全局 prose 缩为 what/when，把字段约束放回 parameter schema；
4. **瘦结果**：分页、摘要、section drill-down，避免一次结果挤占后续推理空间。

Chorus 已实现四者中的具体切片，但尚未提供通用 tool search。

## 3. Chorus 架构与机制

### 3.1 15-bit 权限模型

权限类型由模板字符串约束为 `${Resource}:${Action}`；5×3 的完整集合由 `RESOURCES.flatMap(ACTIONS)` 生成（`src/lib/authz/types.ts:1-19`）。

三个 preset 是普通 permission 数组：

| Preset | Permission 数 | 典型边界 |
|---|---:|---|
| `developer_agent` | 6 | 五类 read + `task:write` |
| `pm_agent` | 10 | 五类 read + 五类 write |
| `admin_agent` | 15 | 全部 read/write/admin |

`computeEffectivePermissions` 对 preset 展开结果与 custom permission 做 set union，并丢弃无效字符串（`src/lib/authz/permissions.ts:11-40`）。这允许 “PM + `proposal:admin`” 或纯 read-only auditor 等组合，但也意味着 admin bit 是 company-wide 能力，不自动限制为“只审批自己创建的对象”。

### 3.2 每请求重新计算，而不是登录时缓存

MCP endpoint 的处理顺序是：

1. 从 Authorization header 提取 API key；
2. `validateApiKey` 查询 key 及其关联 Agent；
3. 从 Agent 当前 `roles` 与 `permissions` 计算 effective set；
4. 创建新的 `AgentAuthContext`；
5. 创建新的 MCP server 与 transport；
6. 注册工具并处理本次请求。

对应实现位于 `src/app/api/mcp/route.ts:16-72`。`validateApiKey` 使用 `include: { agent: true }` 读取当前 Agent 行，并返回其 `roles` 与 `permissions`（`src/lib/api-key.ts:50-110`）。

这条链路给出一个严格但有限的结论：

> 在没有额外中间缓存的 Chorus server 路径中，权限修改会在下一次 MCP HTTP 请求重新计算并影响该次 server 的工具注册。

它不保证所有 MCP client 会立即刷新本地缓存的 `tools/list` UI；server 的 catalog 已变化，client 何时重拉 catalog 是另一层行为。

### 3.3 Discovery plane：缺权限就不注册

`createMcpServer` 总是注册 public/session tools，再调用 PM、developer 和 admin registration module（`src/mcp/server.ts:14-37`）。每个 gated tool 在 callsite 写明一个 required permission；`registerPermissionedTool` 执行：

```typescript
if (!auth.permissions.includes(required)) return;
server.registerTool(name, config, handler);
```

实现位于 `src/mcp/tools/register-helpers.ts:21-38`。没有 permission 的工具不是“注册后返回 disabled”，而是根本不进入这个 server instance 的 catalog。

`src/mcp/tools/permission-map.ts:23-98` 列出 45 个 gated tools。该 map 是测试用 coverage contract，不是 runtime lookup；生产代码仍在每个 registration callsite 内联 permission，以便 handler 与 gate 相邻（`:3-11`）。

### 3.4 Invocation plane：REST 继续检查相同 bit

Chorus 同时提供 REST surface。它不假设“Agent 在 MCP 里看不到工具，所以 REST 不必授权”。例如 proposal approval route 对 Agent 显式要求 `proposal:admin`，否则返回 403；human user 走独立分支（`src/app/api/proposals/[uuid]/approve/route.ts:14-41`）。

公共 helper 提供两种 gate：

- `checkAgentPermission`：供人和 Agent 共用的 route 使用，只对缺 bit 的 Agent 返回 403；
- `requireAgentPermission`：要求 Agent 或 super admin，缺 bit 返回 403。

实现位于 `src/lib/auth.ts:182-236`。这就是“双层一致性”的第二层：同一能力即使从 REST 而非 MCP 进入，仍要回答 permission 问题。

需要精确说明：**MCP handler 不会先绕一圈 REST route。** MCP registration gate 与 REST gate 是两条并行入口上的重复策略，不是同一请求经过两个网络检查。它们依赖测试和代码审查防止语义漂移。

### 3.5 Domain plane：权限是必要条件，不是充分条件

`task:write` 不能回答“这个 Agent 是否是此 Task 的 assignee”或“依赖是否完成”。Task REST PATCH 在 permission gate 后继续检查：

1. transition 是否在状态机允许集合中；
2. 非 human caller 是否为 assignee；
3. 进入 `in_progress` 时 dependency 是否 resolved。

实现位于 `src/app/api/tasks/[uuid]/route.ts:42-165`。

MCP 的 `chorus_update_task` 同样在 status update 时使用 `isAssignmentOwnedByActor`，再检查 transition 与 dependency（`src/mcp/tools/public.ts:1218-1295`）。这类 domain guard 防止一个拥有一般写权限的 Agent 操作不属于自己的工作，或跳过流程不变量。

三层关系可以写成：

```text
可执行动作
  = discovery 中暴露
  ∩ invocation 身份获准
  ∩ domain invariant 成立
```

任一层缺失都不能由其他层完全补偿。

### 3.6 工具 inventory 与 preset 结果

基线代码有：

- 45 个 `registerPermissionedTool` 管理的 gated tools；
- 29 个 public module 中的 ungated tools；
- 8 个 ungated session tools；
- 合计 82 个 production registrations。

根据 `TOOL_PERMISSIONS` 与 preset 展开，catalog 为：

| 身份 | 始终可见 public/session | 可见 gated | 合计 | 相对 admin 少 |
|---|---:|---:|---:|---:|
| developer preset | 37 | 5 | 42 | 40 |
| PM preset | 37 | 35 | 72 | 10 |
| admin preset | 37 | 45 | 82 | 0 |
| 仅 `task:read` custom | 37 | 0 | 37 | 45 |

这些数字来自该 commit 的 registration inventory，不是跨版本常量。`src/mcp/__tests__/server.test.ts:219-318` 用 capturing server 验证 permission map coverage、preset 兼容性，以及添加 `task:write` 正好暴露 5 个 developer tools。

### 3.7 工具去重：删除 alias，而不是只改文案

Chorus 曾删除三个冗余工具：

- PM-prefixed batch task creation alias；
- add-task-dependency；
- remove-task-dependency。

canonical replacement 是 `chorus_create_tasks` 与 `chorus_update_task`。`src/mcp/__tests__/wave3-integration-smoke.test.ts:158-195` 通过真实 MCP client 调用 `tools/list`，验证三个旧名不再出现、replacement 仍存在、总量正好减少 3。

去重的价值不只是省 token。两个同义工具会让 Agent 必须推断“哪个才是推荐路径”，并让 permission mapping、docs 和测试多一组漂移面。

### 3.8 描述瘦身：what/when 在工具层，red line 在参数层

基线对七个高频工具做了 description slimming。测试要求 top-level description 不超过两句，且不得包含多步骤 numbered/bulleted procedure（`src/mcp/__tests__/tool-description-slimming.test.ts:81-129`）。

约束没有被删除，而是移动到最相关的 schema 字段。例如 completion report 的三个 section contract 从 tool description 移到 `content.describe()`；elaboration 的 “不要手工添加 Other” 移到 nested `options` 参数（`:132-159`）。

这种拆分让模型先用短描述选工具，选中后再在参数 schema 中看到精确 red line。

### 3.9 结果瘦身：section、compact rows 与硬上限

输入 catalog 不是唯一认知成本，工具结果同样进入 context。Chorus 使用三类策略：

1. `chorus_get_proposal` 默认返回 `basic` section，只包含 metadata 与 draft index；需要时再请求 `documents`、`tasks` 或 `full`（`src/mcp/tools/public.ts:640-673`）。
2. collection tool 只保留 compact keys，并截断 summary/preview text。
3. collection JSON 默认不超过 65,536 bytes；超限时从尾部移除 row，单 row 仍超限则返回结构化错误（`src/mcp/tools/collection-contract.ts:3-10`、`:131-177`）。

这是 progressive disclosure，而不是简单截断所有结果。Agent 先扫描 compact collection，再用 single-resource tool 深挖。

### 3.10 已实现机制与工具面收敛 Roadmap

工具面收敛由主题 Idea `32611091` 跟踪，不能把主题中的目标数字当作当前实现。其子项状态为：

| 子项 | 目标 | 基线状态 |
|---|---|---|
| P0 `d02e8e34` | 合并近重复 mutation tools，计划把 82 个 registration 收敛到 78 | elaborating，尚未实现 |
| P1 `f86c9ddb` | 压缩 7 个超长 description，并把 6 类自由字符串参数改为严格 enum | 已由 `d0f736f5` / PR #436 合入 |
| P2 `7376c0a3` | 降低合成 key、嵌套参数与隐式规则的填参难度 | open，尚未实现 |
| P3 `b4a77842` | 削弱 UUID-first 带来的“先取再调”前置回合 | open，尚未实现 |

因此，本节可以把 P1 的 description/enum 变化写成既成实现，也可以引用更早已完成的三个 alias 删除；但 **82→78 仍是 P0 roadmap**。本文基线的 production registration 总数仍为 82，也没有实现通用 deferred loading 或按 workflow stage 动态收敛 catalog。

## 4. 设计深挖：把授权与认知预算放在同一模型中

### 4.1 三个平面

一个可维护的 capability-shaped design 应明确区分三个平面。

**Discovery plane**

- 输入：effective permissions、runtime capability、当前 workflow stage；
- 输出：本轮可发现的 tool metadata；
- 目标：减少不相关能力和选择歧义。

**Invocation plane**

- 输入：认证身份、permission、target company/project；
- 输出：allow、401 或 403；
- 目标：即使 client 伪造 tool call 或直接请求 REST，也不能越权。

**Domain plane**

- 输入：target entity state、assignee/owner、dependency、AC；
- 输出：业务 transition 是否成立；
- 目标：防止“有一般权限但对这个对象或这个时刻无权操作”。

把三者混成一个 `canDo()` 会掩盖不同失败模式；只实现其中一个则会留下明显绕过路径。

### 4.2 Permission bit 是 coarse capability，object guard 是 refinement

`task:write` 表示“一般任务写能力”，不是“可修改任意 Task”。对象级 refinement 还需要：

```text
task:write
AND caller owns assignment
AND requested transition is valid
AND dependencies are resolved
```

同理，`proposal:admin` 当前允许 Agent 审批 company 内 proposal，并不内建“不能审批自己创建的 proposal”。独立 reviewer 约束主要由 workflow skill 与身份分工提供，而不是该 bit 自动表达。若治理目标需要 separation of duties，就必须增加 author/reviewer relation gate，而不能只增加一个更高 role。

### 4.3 Catalog 应由 capability 生成，而不是由 persona 猜

Persona 文字可以告诉 Agent “你是 developer，不要审批”，但它是 advisory。`registerPermissionedTool` 从认证上下文生成 catalog，使 developer 根本看不到 admin mutation verbs。两者的差异是：

| 机制 | 约束位置 | Agent 可否忽略 | 是否减少 tool schema context |
|---|---|---:|---:|
| Persona / prompt | 模型输入 | 可以 | 否 |
| `tools/list` 裁剪 | server registration | client 可伪造调用，但 catalog 不含工具 | 是 |
| Invocation permission | trusted server path | 不可以 | 否 |
| Domain invariant | handler/service | 不可以 | 否 |

最可靠的组合是四层协同，而不是在 persona 与 server gate 之间二选一。

### 4.4 权限变更的生效语义

无状态 MCP 把权限变更的 server-side 生效点缩短到下一次请求：

```text
Agent permission edited
→ next request validates API key
→ reloads Agent.roles + Agent.permissions
→ recomputes effective set
→ creates fresh server
→ registers new catalog
```

这个设计避免长生命周期 MCP server 持有过期 authorization snapshot。代价是每请求认证和建 server，且 client 仍可能缓存旧的 tool metadata。未来若使用 MCP catalog cache hint，cache key 必须包含 authorization context；跨 Agent 共享 catalog 会泄漏能力。

### 4.5 认知预算不能只用工具数量衡量

工具数是可见指标，却不是完整成本函数。更合理的近似是：

```text
Tool Surface Cost
  = schema tokens
  + semantic overlap
  + parameter ambiguity
  + expected result volume
  + risk-weighted irreversible actions
```

删除三个 alias 降低 overlap；描述瘦身降低 schema tokens；enum 减少参数歧义；section 与 bounded collections 限制 result volume；permission filtering 移除不相关高风险动作。它们处理的是不同项，不应只汇总成“少了多少工具”。

### 4.6 Tool shaping 与 tool search 的关系

Permission filtering 和 tool search 不是替代关系：

- permission filtering 决定**不应访问**的全集；
- tool search 在获准全集内决定**此刻需要加载**的子集。

理想顺序应是：

```text
authorized catalog
→ stage/task relevance filter
→ on-demand search
→ selected tool schemas
→ invocation + domain gates
```

Chorus 当前实现第一步和部分 schema/result slimming，尚未实现 stage-aware catalog 或 server-side deferred loading。

## 5. 诚实边界与局限

### 5.1 隐藏工具不是安全边界的全部

一个 client 可以绕过自己的 `tools/list` UI，直接构造已知 tool name 或访问 REST endpoint。因此“看不见”只减少模型选择和误调用；真正授权必须在 server invocation path 存在。本文不使用 security through obscurity 描述 Chorus。

### 5.2 MCP 与 REST 是并行 gate，不是串行双检

MCP tool handler 直接调用 service，并不先调用 REST route。所谓“双层一致性”是两种外部入口分别应用同一 permission vocabulary，加上 handler/service domain guard。若某一入口漏 gate，另一入口不会自动补救。

### 5.3 37 个 public/session tools 不受 permission catalog 裁剪

当前 82 个 tools 中有 37 个对所有已认证 Agent 可见。大多数是 read、comment、notification 和 session 操作，但并非全部只读：

- `chorus_create_tasks` 是 public registration；实际 handler 检查 company/project、proposal existence 与非空 AC，但没有 `{resource}:write` permission gate（`src/mcp/tools/public.ts:1055-1103`）。
- `chorus_update_task` 的 field/AC/dependency edits 对所有角色开放，只有 status change 明确要求 assignee（`:1218-1269`）。

`docs/PERMISSIONS.md:83-90` 也把 `chorus_create_tasks` 无 handler-level permission guard 记录为 follow-up。由此不能声称当前每个 mutation capability 都由 permission-shaped catalog 覆盖。

### 5.4 `*:read` 目前不塑造 read tool visibility

Read tools 普遍位于 public surface。一个没有 `idea:read` 的已认证 Agent 仍可能在 MCP catalog 看到 `chorus_get_idea`；实际 service 主要用 company scope 隔离，而不是每个 read bit。REST read routes 则常用 `checkAgentPermission`。这构成 MCP/REST 语义不完全对称，也是未来需要收口的 gap。

### 5.5 Admin bit 较宽，缺少 object-level separation of duties

`proposal:admin`、`task:admin` 是 company scope 能力；它们不自动表达“只能审核他人工作”“只对某 project 生效”或“只在某 task 临时生效”。Project header 当前主要过滤部分 read/tracker 结果，不是通用 authorization scope。

### 5.6 未测得 Chorus 自身的选择准确率收益

本文可以精确报告 tool count 和 payload bound，不能据此宣称 developer Agent 的成功率提高了某个百分比。Anthropic 的 30–50 tool 退化和 85% context reduction 属于其平台条件[3]；Chorus 还没有对自己的模型/runtime/tool mix 运行 controlled evaluation。

### 5.7 Client cache 与 runtime 行为不由 server 完全控制

Server 下一请求会重算 permission，不代表所有 client 会立即重发 `tools/list`。旧 catalog 中的 tool call 最终应被 server 拒绝或因未注册失败，但 UI 可见性可能短暂滞后。本文区分 server freshness 与 client presentation freshness。

### 5.8 描述瘦身可能移除必要语境

把 procedure 从 top-level description 移到 parameter schema 通常更聚焦，但过度瘦身会让模型在选工具前看不到关键风险。当前测试只限制句数和格式，不证明语义完整性；仍需要基于真实失败案例的 tool-use evaluation。

## 6. 评估与 Worked Example

### 6.1 评估方法

本文使用四种 repository-grounded 评估：

1. **Static inventory**：统计五个 production registration module；
2. **Permission projection**：将 45-tool map 投影到三个 preset；
3. **Contract tests**：运行 `server.test.ts`、permission integration、description slimming、proposal section 与 collection bound tests；
4. **Worked example**：比较同一高影响动作在 discovery、REST invocation 和 domain plane 的结果。

它评估实现 contract，不评估模型任务成功率。

### 6.2 Worked example：developer 尝试审批 Proposal

假设 Agent 使用 `developer_agent` preset，只有 6 个 permission，其中没有 `proposal:admin`。

**路径 A：正常 MCP discovery**

1. API key 查到 developer Agent；
2. effective set 包含五个 read 与 `task:write`；
3. `registerAdminTools` 尝试注册 `chorus_admin_approve_proposal`；
4. `registerPermissionedTool` 因缺 `proposal:admin` 直接 return；
5. `tools/list` 不包含 approval tool。

结果：高影响 verb 不进入模型的正常选择空间。

**路径 B：client 直接请求 REST approval**

1. REST route 重新认证 Agent；
2. `hasPermission(auth, "proposal:admin")` 为 false；
3. route 返回 `403 Missing permission: proposal:admin`。

结果：即使知道 endpoint，也不能靠绕过 discovery 获得审批能力。

**路径 C：admin 调用，但 Proposal 状态错误**

1. admin 通过 permission gate；
2. route 读取 Proposal；
3. 若 status 不是 `pending`，返回 bad request。

结果：permission 允许“谁可能审批”，domain state 决定“此刻能否审批”。

这三个结果分别验证 discovery、invocation 和 domain plane。

### 6.3 Tool count 结果

从 admin 到 developer，工具面减少 40 个，即 48.8%：

```text
(82 - 42) / 82 = 48.8%
```

PM 相对 admin 减少 10 个，即 12.2%。差异主要来自 admin-only approval、verify、close 与 delete capabilities。developer 的 42 tools 仍高于外部 tool-search 文档提到的 30–50 风险区间下沿，说明 permission filtering 是必要但未必充分的 context 策略。

### 6.4 Payload 与描述约束

实现提供可机械验证的上限：

- collection 默认 page size 20，最大 100；
- collection JSON 默认上限 65,536 bytes；
- summary text 256 code points，preview 512；
- 七个已 slimmed tool description 不超过两句；
- proposal 默认 basic section 不返回 document body 或 task description。

这些指标比笼统声称“payload 更小”更可验，但仍未转换为真实 turn token savings。

### 6.5 预期测试断言

关键 contract tests应保证：

```text
all-permission registered gated set == TOOL_PERMISSIONS keys
developer preset gated set == 5 task:write tools
PM preset contains no admin-only tools
custom task:read exposes 0 gated tools
three deleted aliases absent from real tools/list
proposal basic view excludes full draft content
bounded collection serialized bytes <= 65,536
REST caller without required bit receives 403
```

任何新增 tool 若没有 classification 或 permission decision，应让测试失败，而不是默认为 public。

## 7. 讨论与 Roadmap

### 7.1 先收口 public mutation gaps

最高优先级不是增加更多 permission bit，而是逐项审计 37 个 public/session tools：

| Tool 类型 | 建议 |
|---|---|
| 纯 read/discovery | 明确是否真的对所有 Agent public，或接入 `*:read` |
| comment/answer | 保留协作可达性，但增加 target scope 与 rate/audit 检查 |
| task create/update | 迁移到 `task:write` / `proposal:write`，或写出严格 object guard |
| session lifecycle | 绑定 caller Agent ownership，避免跨 Agent session 操作 |

目标是让“public”成为明确安全决策，不是历史兼容默认。

### 7.2 建立单一 policy manifest

当前 runtime gate 内联在 registration callsite，测试 map 独立维护，REST route 又手写 permission。可引入 machine-readable policy manifest：

```yaml
capability: proposal.approve
permission: proposal:admin
mcpTool: chorus_admin_approve_proposal
rest:
  method: POST
  path: /api/proposals/:uuid/approve
domain:
  - proposal.status == pending
separationOfDuties:
  - actor != proposal.author
```

生成测试而不是生成全部业务代码，可以减少 MCP/REST 漂移，同时保留 handler 可读性。

### 7.3 增加 stage-aware relevance filter

Permission 只回答“最多能做什么”，workflow stage 可以进一步回答“现在需要什么”。例如：

- Idea elaboration 时不加载 task verification tools；
- developer 执行中不加载 project-group admin tools；
- reviewer 只加载 read、comment 与 verdict 所需工具。

这种 relevance filter 必须在 permission filter 之后运行，不能让 workflow stage 扩大权限。

### 7.4 接入按需 tool search

当 authorized catalog 仍有 42–82 个工具时，可将低频工具标记为 deferred，只保留：

- checkin/search；
- 当前 stage 的常用 read/write；
- capability search 本身。

Tool search 的索引应只包含已授权 metadata，避免通过搜索结果泄露隐藏 tool name、description 或参数。

### 7.5 做模型与 runtime 分层 evaluation

建议记录以下指标：

- task success rate；
- wrong-tool call rate；
- 403 / business rejection rate；
- 首次正确工具命中率；
- tool schema input tokens；
- tool result tokens；
- permission change 到 client catalog refresh 的延迟；
- prompt injection 场景下的越权尝试率。

按模型、runtime、preset 和 workflow stage 分层，否则一个平台的 tool-search 收益不能泛化到所有 Agent。

### 7.6 引入临时 elevation 与可撤销 capability

固定 preset 容易导致长期过权。更细的演进方向是：

1. 默认最小 catalog；
2. Agent 对一个具体 action/target 请求 elevation；
3. human 或 policy engine 批准带 TTL、target UUID、reason 的 grant；
4. 下一 MCP 请求出现对应工具；
5. 完成或超时后自动撤销，并记录 activity。

这会把 `{resource}:{action}` 从 company-wide coarse bit 扩展为 scoped capability lease。

## 8. 结论

工具面不是中性的接口目录。对 Agent 而言，它同时定义可见行动空间、消耗 context，并影响错误与越权的概率。Chorus 用 15-bit `{resource}:{action}` 模型把权限投影到 MCP registration：每个请求重新读取 Agent 权限，缺 bit 的 mutation tool 不进入 `tools/list`；REST route 继续执行 permission gate，handler/service 再约束 assignee、状态和依赖。

基线中，developer、PM、admin 分别看到 42、72、82 个工具；工具去重、描述瘦身、section view 与 64 KiB collection bound 继续降低认知成本。与此同时，37 个 public/session tools、public mutation gaps、MCP/REST 并行策略和宽 scope admin bit 说明当前系统仍不是完整 reference monitor。

因此，“权限即工具面”最准确的含义不是把隐藏当安全，而是把最小权限与 context engineering 统一起来：**先缩小 Agent 正常看见的能力，再在每条可信执行路径重复授权，最后用领域不变量约束具体对象和时机。**

## 参考文献

1. Model Context Protocol, “Tools,” 2025-06-18 Specification. <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
2. Anthropic, “Code execution with MCP: building more efficient AI agents.” <https://www.anthropic.com/engineering/code-execution-with-mcp>
3. Anthropic, “Tool search tool,” Claude Platform Documentation. <https://console.anthropic.com/docs/en/agents-and-tools/tool-use/tool-search-tool>
4. MindStudio, “The Permission Ladder: Granting AI Agents the Right Level of Autonomy.” <https://www.mindstudio.ai/blog/ai-agent-permission-ladder-autonomy-levels>
5. Anthropic, “Writing effective tools for AI agents — using AI agents.” <https://www.anthropic.com/engineering/writing-tools-for-agents>
6. Anthropic, “Effective context engineering for AI agents.” <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
7. Chorus-AIDLC, “Chorus source repository.” <https://github.com/Chorus-AIDLC/Chorus>
