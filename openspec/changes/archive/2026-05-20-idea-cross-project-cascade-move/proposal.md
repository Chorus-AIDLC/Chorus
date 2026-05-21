## Why

`chorus_move_idea` 当前只更新 Idea 自己的 `projectUuid`，并把 `status in [draft, pending]` 的 Proposal 一起搬过去。一旦一个 Idea 已经走过审批，它生出来的 Proposal（approved/rejected/revised）、Document、Task、Activity 全都留在原 Project，形成"Idea 在新 Project，但它的资产还在旧 Project"的孤儿状态。常见场景：把 Backlog 里某个 idea 转入具体版本 Project、或纠正归错 Project Group 时，搬完会发现新 Project 看不到任何沉淀，旧 Project 里又留着没人维护的文档与任务。

本次修复让 `chorus_move_idea` 沿 `Idea → Proposal → Document/Task → Activity` 链路做级联迁移，单事务完成，从根上消除孤儿状态。

## What Changes

- **服务层** `moveIdea()`：在原有 `Idea.projectUuid` + `Proposal.projectUuid (status in [draft,pending])` 的基础上扩展为：
  - Proposal：`status` 不再过滤，所有状态（schema 当前枚举 `draft|pending|approved|rejected|revised`）一并更新 `projectUuid`。
  - Document：所有 `proposalUuid` 指向上述 Proposal 集合的 Document，一并更新 `projectUuid`。
  - Task：所有 `proposalUuid` 指向上述 Proposal 集合的 Task，一并更新 `projectUuid`。
  - Activity：所有 `targetType in {idea, proposal, task, document}` 且 `targetUuid` 命中本次迁移集合的 Activity，一并更新 `projectUuid`。
  - 全程在一个 `prisma.$transaction` 内完成，避免半迁移。
  - 不动：Task assignee、AgentSession、SessionTaskCheckin、Notification 历史、Comment（Comment 表本身没有 `projectUuid` 字段）。
  - 不做同名冲突检查：Document/Task title 重复在 schema 上本来就允许。
- **REST API** `POST /api/ideas/[uuid]/move`：响应在 `data` 里返回迁移计数 `moved: { proposals, documents, tasks, activities }`，便于 UI 展示「已迁移 N 个 proposal、M 个 document...」。不引入跨 Project 的额外鉴权检查。
- **MCP 工具** `chorus_move_idea`：复用同一个 `moveIdea()`，权限维持 `idea:write`，工具描述与返回值同步包含 `moved` 计数。
- **UI**：Idea 详情面板加 "Move to project..." 入口，弹出二次确认 dialog，显示「将一并迁移：N proposals、M documents、K tasks、L activities」预览清单（迁移前调用 service 的"预览"能力计数），用户确认后执行。
- **文档**：`docs/MCP_TOOLS.md`、`public/skill/`、`public/chorus-plugin/skills/chorus/`、`plugins/chorus/` 中关于 `chorus_move_idea` 的描述同步更新，明确级联范围与不动的资源。

## Capabilities

### New Capabilities

- `idea-cross-project-move`: 跨 Project 迁移一个 Idea 时，Idea 自身、所有关联 Proposal（全状态）、Proposal 衍生出的 Document/Task、以及 idea/proposal/task/document 上的 Activity 一并迁移；Comment / TaskDependency / AcceptanceCriterion / SessionCheckin 凭外键自动随主体；assignee / 活跃 session / Notification 历史保持不变；同名不检查；MCP 路径仅检查 `idea:write`，REST/UI 不引入额外鉴权。

### Modified Capabilities

无（这是一次纯新增能力，原有 `chorus_move_idea` 行为是它的子集，向后兼容）。

## Impact

- **代码**：
  - `src/services/idea.service.ts`（`moveIdea` + 新的预览/计数辅助函数）。
  - `src/services/__tests__/idea.service.test.ts`（扩展测试，覆盖 approved 链路）。
  - `src/__tests__/integration/`（新增 idea→proposal→approve→materialize→move 的端到端 integration test）。
  - `src/app/api/ideas/[uuid]/move/route.ts`（响应返回 `moved` 计数）。
  - `src/mcp/tools/pm.ts`（工具描述更新；权限映射不变）。
  - `src/app/(dashboard)/projects/[uuid]/...`（Idea 详情面板新增 Move 入口与确认 dialog）。
  - `messages/en.json` / `messages/zh.json`（新 i18n key）。
- **数据库**：无 schema 变更；仅扩大一次 `$transaction` 内 `updateMany` 的目标集合。
- **文档**：`docs/MCP_TOOLS.md`、`public/skill/`、`public/chorus-plugin/skills/chorus/`、`plugins/chorus/` 的 `chorus_move_idea` 描述。
- **向后兼容**：调用方不传新字段，行为是「之前会搬的更多了」——已经走过审批的 idea 现在能完整带走，已有调用方不会失败。
