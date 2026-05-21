## Context

`src/services/idea.service.ts:472` 的 `moveIdea()` 当前只动两张表：

```ts
await prisma.$transaction(async (tx) => {
  await tx.idea.update({ where: { uuid: ideaUuid }, data: { projectUuid: targetProjectUuid } });
  await tx.proposal.updateMany({
    where: {
      companyUuid,
      inputType: "idea",
      inputUuids: { array_contains: [ideaUuid] },
      status: { in: ["draft", "pending"] },
    },
    data: { projectUuid: targetProjectUuid },
  });
});
```

`Document` / `Task` / `Activity` 都有 `projectUuid` 字段（Cascade 删除依赖它），但本函数没碰它们。`TaskDependency` / `AcceptanceCriterion` / `Comment` / `SessionTaskCheckin` 等附属表通过外键（`taskUuid` / `targetUuid` / etc.）挂在主体上，自身无 `projectUuid`，只要主体的 `projectUuid` 改了就自然跟着新 Project。

Elaboration round 1（roundUuid `9b017105-…`）已经把 7 个边界问题敲定，详见 proposal.md。本设计聚焦"如何把这些决策准确落地到一个事务里"。

## Goals / Non-Goals

**Goals:**

- 单事务内级联迁移：Idea + 全状态 Proposal + Document + Task + Activity，保证不出现半迁移状态。
- REST/MCP/UI 三处入口都返回迁移计数 `{ proposals, documents, tasks, activities }`，UI 二次确认 dialog 用同一份计数预览。
- 维持现有 MCP 权限边界（`idea:write`）；REST/UI 不引入额外鉴权。
- 向后兼容：旧调用方（不读新字段）行为只是"搬得更多了"，不会失败。

**Non-Goals:**

- 不做 Document/Task 同名冲突检测——schema 本来就允许。
- 不调整 assignee（保留原 user/agent 引用，即便目标 project 没有该成员的概念）。
- 不强制 checkout 活跃 AgentSession 的 `SessionTaskCheckin`——session 表没有 `projectUuid`，跨 project 引用本身合法。
- 不改 Notification 历史——通知是事件快照。`Notification` 表带 `projectUuid` 字段，但用户在 elaboration q7 明确选了"全部不动"。需要 task #1 的实现者顺手验证：Notification 列表的渲染过滤是按 `recipient` 走的（前端按 entity uuid 路由跳转），不是按 `projectUuid` 过滤——如果是后者，则旧 project 的通知点击后跳到新 project 的实体页时可能因当前 project context 不匹配而看不到正文。这一点需要在 task #2 的测试或 task #3 的 manual verification 里包含一次「move 后点击旧通知能否正常打开 entity」的检查。
- 不引入跨公司迁移——保持 `companyUuid` 边界检查不变。

## Decisions

### D1 — Proposal 集合的查询条件

继续用 `inputType: "idea"` + `inputUuids array_contains [ideaUuid]`，但去掉 `status: { in: [...] }`。所有状态（含 approved/rejected/revised/closed 如果未来有）一并搬。

**理由**：用户在 elaboration q1 选了"全部状态都搬"。schema 当前的 `Proposal.status` 枚举是 `draft|pending|approved|rejected|revised`（没有 `closed`，elaboration 里出现的"closed"是表述误用，未来也无计划新增）。去掉 status 过滤后行为对当前枚举值全集生效，未来加新枚举值也自动包含，符合"沿审批链路全部带走"的语义。

**替代方案**：保留 `status` 过滤，加一个白名单。被排除——多一个字段就多一组测试与文档分支，没有收益。

### D2 — Document/Task 通过 `proposalUuid` 反查

`Document.proposalUuid` 与 `Task.proposalUuid` 都是 nullable 的——手动创建的 Document/Task（不通过 Proposal materialize）`proposalUuid` 为空。本次只迁移由该 Idea 关联 Proposal materialize 出来的 Document/Task：

```ts
const proposalUuids = (await tx.proposal.findMany({
  where: { companyUuid, inputType: "idea", inputUuids: { array_contains: [ideaUuid] } },
  select: { uuid: true },
})).map(p => p.uuid);

await tx.document.updateMany({
  where: { companyUuid, proposalUuid: { in: proposalUuids } },
  data: { projectUuid: targetProjectUuid },
});
await tx.task.updateMany({
  where: { companyUuid, proposalUuid: { in: proposalUuids } },
  data: { projectUuid: targetProjectUuid },
});
```

**为什么不靠 idea→proposal 的 `inputUuids array_contains` 直接级联**：那是 JSON 字段查询，每条记录都要重新解析。先一次拉出 `proposalUuids` 数组，后面三个 `updateMany` 全部走 `proposalUuid: { in: [...] }` 索引，O(1) IO 内完成。

**不迁移手动创建的 Document/Task**：本 idea 的语义是"沿 idea 在 AI-DLC 流水线上沉淀的资源"。手动建的 task/document 与 idea 无血缘关系，不应被一起搬。

### D3 — Activity 的迁移条件

Activity 通过 `targetType + targetUuid` 关联，自带 `projectUuid` 字段（idea/proposal/task/document 创建活动时都会写入）。需要更新所有目标命中本次迁移集合的 Activity：

```ts
const taskUuids = (await tx.task.findMany({ where: { proposalUuid: { in: proposalUuids } }, select: { uuid: true } })).map(t => t.uuid);
const documentUuids = (await tx.document.findMany({ where: { proposalUuid: { in: proposalUuids } }, select: { uuid: true } })).map(d => d.uuid);

await tx.activity.updateMany({
  where: {
    companyUuid,
    OR: [
      { targetType: "idea", targetUuid: ideaUuid },
      { targetType: "proposal", targetUuid: { in: proposalUuids } },
      { targetType: "task", targetUuid: { in: taskUuids } },
      { targetType: "document", targetUuid: { in: documentUuids } },
    ],
  },
  data: { projectUuid: targetProjectUuid },
});
```

**理由**：用户选了"全部跟着走（推荐）"。Activity 不跟着搬，新 Project 的活动流就空了——回看历史失败的体验比小的数据膨胀更重要。

### D4 — 迁移计数 `moved`

`moveIdea()` 的返回类型从 `IdeaResponse` 改为 `IdeaResponse & { moved: { proposals: number; documents: number; tasks: number; activities: number } }`。在 transaction 内部把每个 `updateMany` 的 `count` 累加进 result。

**为什么放进 service 返回值**：UI 二次确认 dialog 需要"将一并迁移：N proposals、M documents..."的预览。预览有两种实现选项：

- **选项 A（被采纳）**：UI 先调一个 dry-run 接口（service 加 `moveIdeaPreview()`，跑一遍 SELECT count 但不写）；用户确认后再调 `moveIdea()` 真做。
- **选项 B（不采纳）**：UI 直接展示"搬完才告诉你搬了多少"——用户确认时看不到影响。被排除——和"二次确认时展示资源清单"的产品决策矛盾。

`moveIdeaPreview(companyUuid, ideaUuid, targetProjectUuid)` 共用同一组 SQL 但只跑 count 查询，REST 路由 `GET /api/ideas/[uuid]/move/preview?targetProjectUuid=...` 暴露给 UI；MCP 工具不暴露 preview（agent 没有"二次确认"环节，agent 直接调真 move 拿到 `moved` 即可）。

### D5 — 权限路径

- **MCP**：`chorus_move_idea` 在 `permission-map.ts` 中保持 `idea:write`，不变。
- **REST**：`POST /api/ideas/[uuid]/move` 已有的鉴权链不变（用户登录 + 同公司即可）。
- **UI**：Move 按钮的可见性沿用 idea 详情面板现有的"可编辑此 idea"判断，不引入新 gating。

理由：用户明确说"用户端不需要鉴权，MCP 需要有 idea write 就好"。维持最小侵入。

### D6 — UI 入口形态

参考已有的 idea-detail-panel 删除入口模式：在 idea 详情面板的 Actions 区域加 "Move to project..." 按钮。点击后弹 shadcn `Dialog`：

1. `Select` 控件列出当前 company 下其他 Project（按 Project Group 分组）。
2. 选定后调 `GET /api/ideas/[uuid]/move/preview?targetProjectUuid=...` 拿计数。
3. Dialog body 渲染：「将一并迁移：**N** proposals、**M** documents、**K** tasks、**L** activities。此操作不可撤销。」
4. 「Confirm」按钮调 `POST /api/ideas/[uuid]/move`，成功后关闭 dialog 并 `router.refresh()`。

i18n key 全部新增到 `messages/en.json` 与 `messages/zh.json`。

## Risks / Trade-offs

- **大事务时长**：[Risk] 一个 idea 如果挂着很多 proposal/task，事务里跑 5+ 个 `updateMany` 加 2 个 `findMany`，PG 行锁可能影响并发。 → Mitigation：所有 where 条件都走索引（`proposalUuid`、`companyUuid`、`targetType+targetUuid`），实测下单次事务在 ms 级；且 idea 体量在产品上限有限（数百量级 task 已是极端）。如果未来出现性能问题，可以拆成"先快速更新 idea + proposal，再异步级联 document/task/activity"，但现阶段单事务的一致性收益压倒性能担忧。
- **预览数和真实数不一致**：[Risk] 预览到真 move 之间窗口里有新 proposal/task 写入，UI 显示的计数与实际略有偏差。 → Mitigation：忽略——这个窗口通常 < 1s，且实际 move 返回的 `moved` 计数是真值，UI 在成功 toast 里展示真值即可（"Moved: 3 proposals, 5 documents..."）。
- **多租户边界**：[Risk] 现有逻辑只检查 `companyUuid`，新增的 cascading where 条件如果漏写 `companyUuid`，会跨公司污染数据。 → Mitigation：每个 `updateMany` 都显式带 `companyUuid` 条件；写一个 integration test 模拟 company A 的 idea move 时不动 company B 的同名资源。
- **测试覆盖度**：[Risk] service 单测容易只覆盖"主体搬了"，遗漏 activity 这类附属表。 → Mitigation：integration test 走完 idea→create proposal→approve→materialize→move→断言 5 张表都更新。
- **文档同步漂移**：`chorus_move_idea` 在 `docs/MCP_TOOLS.md`、`public/skill/`、`public/chorus-plugin/skills/chorus/`、`plugins/chorus/` 都有描述，漏改一处行为说明就和实际不一致。 → Mitigation：用一个独立 task 集中改这些文档，task AC 列出每个文件路径，review 时一次过。

## Migration Plan

无 DB schema 变更。直接合并即可生效。

回滚策略：纯代码回滚——revert PR 即恢复旧行为。已经做过 cascading move 的 idea 不会被 revert 影响（它们的 `projectUuid` 已经更新，回滚后下一次 move 又只搬 idea+draft proposal）。

## Open Questions

无。Elaboration round 1 已经把所有未决问题（包括用户在 q5 customText 里写的"用户端不需要鉴权，MCP 仅 idea:write"）锁定。
