## Why

用户已确认：在 iPhone Chrome 中，Chorus 多个输入位置点击后会自动放大，希望统一修复全站移动端输入框。聚焦引起的缩放改变阅读比例和操作位置，干扰连续输入。

Idea `b2343e9a-802b-41fb-85a7-1080399aa4f5` 的两轮澄清已于 2026-09-29 经用户验证。小字号是代码与既有资料支持的排查方向，尚未在目标真机确认根因。[1](ref:02559b31-0c6a-4b5d-8990-dbd0cf23d9d0)

## What Changes

- 全站移动端文本输入采用一致的可读字号策略，覆盖普通输入、多行输入、搜索、评论/对话编辑器及页面直接使用的原生控件。
- 在手机竖屏和横屏下，点击、输入、切换输入框不触发页面自动放大；允许正常键盘弹出和光标可见性滚动。
- 保留主动双指缩放，避免通过 viewport 限制、拦截手势或重置页面缩放实现修复。[2](ref:21233df0-15f9-4cd5-9803-4a383bf256fc)
- 保持桌面端现有字体层级、输入提交、IME、提及和焦点行为。
- 交付包含输入入口清单、浏览器检查和 iPhone Chrome 真机验收记录。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `frontend-input`：追加移动端输入聚焦不放大、字号覆盖、缩放与输入交互保留要求；保留已有 IME 要求。

## Impact

主要涉及 `src/app/globals.css`、`src/components/ui/{input,textarea,command}.tsx`、`src/components/mention-editor.tsx`，以及全站输入调用方和原生 textarea。实施前清点 `src/app`、`src/components` 中所有实际编辑入口。既有 `cn()` 使用 tailwind-merge，调用方的 `text-sm` 可覆盖基础组件的 `text-base`，需在方案中处理。

这是一个完整的输入体验修复任务，包含实现及验收，无任务间依赖。无 API、数据库、依赖包变更或新界面；不扩展为全站排版重设计、键盘布局改造或禁用缩放。

资料复用 Idea 的两份已读来源，不重复外部调研。方案阶段完成代码排查，未声称已验证浏览器修复效果。
