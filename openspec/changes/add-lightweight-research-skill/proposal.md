## Why

Idea 初始化需要少量外部背景来改善澄清问题，当前对话式入口却要求立即开始 elaboration。用户在 Idea `fa4fb713-e37c-43a7-ae5d-825842a5cb02` 第 2 轮明确选择创建入口 Checkbox，并要求 Research 为独立 skill，在 Idea／Proposal 流程引用；本方案以此取代此前内联 skill 的建议。

## What Changes

- 新增独立轻量 research skill，覆盖七个分发端，并从 idea／proposal 流程按需调用。用户主动要求或存在影响当前判断的可查证信息缺口时启动。
- 每次有明确焦点的一轮调研以 2–5 分钟、约 3–5 个深入阅读来源为预算；数量不必凑满，工具不可用或无新发现时说明未知并返回。它不拥有问卷、审批或阶段生命周期。
- Idea 结论进入正文并引用真实证据 UUID；Proposal 复用已有证据，新增结论进入其正文或本地规格及对应文档镜像。
- 对话式创建增加默认未勾选的「先调研再澄清」Checkbox。未勾选仍为 Agent 自动判断，显式跳过优先；checkbox 是本次请求，不是全局开关。
- `researchFirst?: boolean` 贯通前端、既有 POST 请求校验、服务参数与 elaborate／decompose 两种初始化指令；不新增互斥 research mode。
- 按用户 2026-09-26 10:10 的补充，在 Idea Tracker action 菜单增加 Research：在实际进入开发前可随时显式调用，包括已有澄清问答、Proposal 待审，以及 Proposal 已批准但尚未开工的情况；保留原有问答和审批状态。
- 沿用会话状态及正文证据展示，零 schema 变更、零迁移、零新 MCP 工具。

## Capabilities

### New Capabilities

- `lightweight-research`: 共享 skill、Idea／Proposal 调用、开发前 Tracker 菜单入口、停止与证据产出约定、七端分发。

### Modified Capabilities

- `conversational-idea-entry`: 可选显式调研请求，以及在同一 wake 内先按需调研再进入澄清的初始化指令。

## Impact

- 新建七端 research skill；修改 idea／proposal 路由及必要的 brainstorm／yolo 边界、overview／安装清单。保留每个运行端的命名和工具差异。
- 修改 `src/app/(dashboard)/projects/[uuid]/dashboard/new-idea-dialog.tsx`、`src/app/api/ideas/conversational/route.ts`、`src/services/daemon-instruction.service.ts`，增加 Tracker `idea-actions-menu.tsx`／父面板及服务端 Research action，连同相关测试、设计稿、en／zh／ja／ko 文案。
- 现有 ReferenceArtifact、Idea.content、Activity 和 daemon turn 足以承载这次功能。独立调研状态、取消／重试、自动跨 Idea 复用和深度调研不在范围内。

参考既有挂载证据：GSD 的提问前搜索 [GSD](ref:d102cd82-ca4f-4473-bcf9-51da9c6d0c09)、按范围控制调查深度 [Superpowers](ref:065dffec-dfed-4832-93cc-9176ed2e4603)、上下文传递原则 [BMad](ref:02869f60-1baf-4761-aa0b-28734214b1ed)。
