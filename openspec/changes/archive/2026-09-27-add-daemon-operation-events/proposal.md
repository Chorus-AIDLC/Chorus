## Why

创建 Idea 与 Tracker Research 当前都存为 `human_instruction`，CLI 通过正文前缀识别 Research。操作意图依赖文案，实时和重连路径容易分歧；提交后自动打开执行会话也打断用户当前工作。用户已于 2026-09-27 04:33 UTC 在 Chorus 验证澄清，确认两种创建模式一起迁移、取消自动打开会话并保留旧 CLI 兼容。

## What Changes

- 引入 `idea_creation_requested`（`elaborate` / `decompose`）与 `research_requested` 专用轮次，保存版本化上下文。新 CLI 按操作类型分发到 Idea、主题分解或 Research skill。
- 复用 Idea 根会话、实例/cwd、权限、事务及 `deliver_turn`；实时与重连均读取同一持久化轮次，按 turn UUID 去重。
- 增加 `operationProtocol=1` 能力声明。服务器保留规范专用类型，向旧 CLI 投影为既有普通指令；兼容已有 `researchProtocol=1` 客户端与更早的 FIFO 客户端。
- 移除创建和 Research 成功后的自动会话弹窗。创建对话框关闭并显示“已提交”反馈，Research 显示“已排队”，留在当前页面；主动查看会话仍可使用，轮次显示正确操作名称与执行状态。
- 更新数据库、HTTP 投影、CLI 队列及执行回报、会话展示与累计规格中的相关要求。

## Capabilities

### New Capabilities
- `daemon-operation-events`: 专用操作的持久化、交付、恢复、版本协商和执行确认。

### Modified Capabilities
- `conversational-idea-entry`: 两种模式的专用首轮、成功后留在当前页面、保留手动查看。
- `lightweight-research`: 专用 Research 轮次、三代客户端兼容及无自动弹窗。
- `container-decompose-ui`: 初始分解使用专用创建事件，后续确认唤醒保持不变。
- `daemon-session-transcript-read`: 专用操作保留分页位置，但不将兼容系统提示显示为用户消息。
- `openclaw-event-bridge`: 两种专用操作纳入仅由 turn 交付的通知排除集合。

## Impact

- 后端：Prisma `DaemonSessionTurn`、创建/Research 服务、轮次读取与推进、Research 资格与隔离谓词、通知记录及 transcript 展示。
- 客户端：pending-turns/turn-advance HTTP 契约、CLI router/prompts/queue/waker/reporter，以及共用这些 API 的旧 CLI/OpenClaw 回归覆盖。
- 前端：NewIdeaDialog、ResearchAction、会话 trigger 标签、en/zh/ja/ko 文案；沿用现有组件和明暗主题。
- 使用现有持久化实体，仅新增可空 JSON 操作载荷；不新增 Research 实体或生命周期状态，不改普通消息、Yolo、静态创建和手动会话操作。
- 交付包括数据库与 CLI 集成测试、浏览器明暗主题/窄屏验收。`docs/design.pen` 同步原为要求，后由本 Idea 用户于 2026-09-27 08:18 UTC 明确豁免，评论 e072b3a2-15df-4f98-9dd3-595eadc1c49d：“不用管pen文件，继续推进”。这不是沿用父功能豁免。
- 证据：复用来源 Idea `761b9e5d-7bbf-46e2-aff2-7ec1d3ac027c` 的 PR #577 及固定提交源码引用；本方案是后续改造，不修改父功能已批准提案。
