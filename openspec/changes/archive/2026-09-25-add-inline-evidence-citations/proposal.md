## Why

资源正文需要直接引用已有证据，并让读者悬浮查看详情、点击打开原链接。用户在 2026-09-25 的纠正明确要求：直接用证据 UUID 链接，主要修改统一渲染层，不修改数据结构，也不扩展 Document 证据挂载能力。

Source Idea: `37e6ac4a-d2fe-4344-9e18-2eee88804317`。本版本覆盖此前“当前资源上下文、Document target 扩展”的过度设计，以用户最新评论为准；YOLO 授权持续有效。

## What Changes

- 使用普通 Markdown 链接语法 `[1](ref:<evidence-uuid>)`，直接指向已有证据 UUID。
- 在共享 MarkdownContent 的链接渲染中识别这种链接，显示紧凑编号 `[1]`，通过现有 `GET /api/references/<uuid>` 获取证据详情。
- hover/focus 展示标题、类型、URL、说明，点击打开最新 HTTP(S) 原链接；证据不存在时保留灰色标记并提示且不可跳转。
- 所有已有 Markdown 正文、文档、评论入口自动获得能力；无需资源上下文，不要求证据挂在正文所属资源，不改变现有租户鉴权。
- 在各端 skill 现有证据章节中增加 UUID 链接示例与使用提醒。

## Capabilities

### New Capabilities

- `inline-evidence-citations`: 基于证据 UUID 的 Markdown 链接及交互。

### Modified Capabilities

无；保留既有统一 Markdown 渲染及证据存储行为。

## Impact

仅前端渲染、相关测试/本地化、skill 文档。复用现有 UUID 详情接口，不修改数据库/schema/service/REST/MCP 数据契约、target types 或 CRUD 通知，不新增 Document 证据管理区、编辑器 picker、编号持久化或快照。

原 Document 扩展任务撤销；实现任务调整为渲染层能力和 skill 使用说明/集成验收。
