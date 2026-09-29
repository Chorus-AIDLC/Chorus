## Context

用户确认目标环境为 iPhone Chrome，多处复现，范围为全站移动端输入。现有 UI 使用 Tailwind 4、共享 shadcn 风格控件、cmdk 与 Tiptap。

代码观察（2026-09-29 工作区）：

| 入口 | 当前行为与风险 |
| --- | --- |
| `src/components/ui/input.tsx`、`textarea.tsx` | 默认 `text-base md:text-sm`，但 `cn()` 最后合并调用方 className，较小字号覆盖可移除基础字号；横屏手机也可能跨过 md |
| `src/components/global-search.tsx` | Input 调用方显式使用 `text-sm` |
| `src/components/ui/command.tsx` | CommandInput 默认 `text-sm` |
| `src/components/mention-editor.tsx` | 真正可编辑的 Tiptap 根节点使用 `text-sm`、`prose-sm`；外层 wrapper 并非输入节点 |
| `src/components/manage-project-group-dialog.tsx` | 直接使用原生 textarea；同文件的 checkbox 不属于文本输入字号修复范围 |
| `src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/document-content.tsx` | 文档编辑原生 textarea 使用 `text-sm` |
| `src/app/layout.tsx`、`globals.css` | 未发现为本问题定制的 viewport 缩放限制；保留其现有职责 |

以上是重点清单而非完整覆盖证明。实施时需逐项盘点共享组件调用方、原生控件和可编辑根节点，包含登录/入门、项目与分组、Idea/任务/提案表单、搜索、评论/对话、文档与管理页面。

既有来源记录了 iOS Safari 小于 16px 的输入聚焦缩放现象；文章发表于 2021 年，不能代替 iPhone Chrome 真机验证。[1](ref:02559b31-0c6a-4b5d-8990-dbd0cf23d9d0) MDN 说明缩放限制和键盘视口行为，因此验收需观察比例，而非仅观察视口高度变化。[2](ref:21233df0-15f9-4cd5-9803-4a383bf256fc)

## Goals / Non-Goals

**Goals:** 移动端所有可编辑文本入口使用至少 16 CSS px 的计算字号；手机横竖屏输入不引起自动放大；保持主动缩放、IME、提交、提及选择与桌面体验。

**Non-Goals:** 改造导航或键盘避让机制、整体放大全站文字、更改 API/数据模型、重写编辑器、禁用主动缩放。

## Decisions

### 1. 在实际输入节点复用移动字号规则

在 `globals.css` 定义一个具名、限定范围的 `mobile-input-text` 样式，应用于共享 Input、Textarea、CommandInput、MentionEditor 的实际 editable 根节点以及排查发现的原生文本控件。

规则在 `(max-width: 767px)` 或 `(hover: none) and (pointer: coarse)` 条件下启用。前者覆盖窄屏布局，后者使跨过 md 的横屏手机仍受保护；不通过 UA 字符串检测 iPhone，不依赖 hydration 或聚焦事件才更改字号。宽屏且主指针精细的桌面不触发规则。触屏平板使用可读字号是此移动输入策略的预期结果。

规则的普通字号为 `max(16px, 1rem)`。如盘点发现本就使用更大字号的编辑入口，通过同一规则的显式 CSS 变量（如 `--mobile-input-font-size`）传递较大值，再取 `max(16px, 1rem, var(--mobile-input-font-size, 1rem))`，避免把更大的有意字号缩小。记录这些例外，禁止设置低于下限的覆盖。

移动字号声明使用限定在此具名类上的 `!important`，确保组件调用方的 `text-sm`、`md:text-sm`、内联普通 fontSize 及 Tailwind 工具层不会打破下限。该类不是 `text-*` 工具类，避免被 `tailwind-merge` 合并删除。仅这一移动字号声明需要提升优先级，不扩展到行高、尺寸或全站字体。检查并清理冲突的 important 字号，不叠加更多竞争规则。

对于 Tiptap，检查根节点及当前文本所在的 `p` 等后代的计算字号；消除 `prose-sm` 或后代字号规则对移动输入文字的影响，保证继承或显式应用相同下限。保留非编辑区域、提及菜单和只读 markdown 的文字层级。不使用 transform 缩小视觉文字。

备选方案评估：只改基础组件遗漏调用方与编辑器；逐处仅添加 `text-base md:text-sm` 会遗漏横屏手机且容易再次被覆盖；全局无差别设置所有文字字号会扩大影响范围。因此采用明确标记、统一规则和全入口审计。

### 2. 缩放与输入事件保持原生行为

不增加 `user-scalable=no`、阻止放大的 `maximum-scale`、手势 preventDefault、touch-action 禁止缩放或聚焦后强制恢复比例的 JavaScript。不改变当前 Enter/Shift+Enter/IME guard、粘贴、自动聚焦和 mention picker 的控制逻辑。

checkbox、radio、range、file、hidden、按钮、Radix Select 的按钮触发器、只读 markdown 不纳入文本字号规则；其嵌入的搜索输入如存在则纳入。可编辑文本型 input（含数字等键盘输入）与 textarea 是审计对象。disabled/readOnly 状态保留其语义，验收重点为可编辑状态。

### 3. 覆盖与验收属于同一个交付任务

此变更跨多个入口但共享同一字号契约，拆成多条组件任务会增加交接和遗漏风险。采用一个 5 点任务，顺序完成审计、统一样式、所有入口迁移和验证。

## Module Contracts

- 共享组件将移动规则挂到实际可编辑元素；消费端可以调整布局、颜色和桌面字号，移动文字不得小于 16 CSS px。
- 原生文本控件应用同一规则；富文本后代不得绕过下限。
- 所有支持状态下，文字、光标、placeholder 与多行内容应可见；因字号变大而需要的最小尺寸/行高修复只局限于受影响控件。
- 大于 767px 且精细主指针的桌面保留现有计算字号；移动横屏不能因 md 响应式工具类退回较小字号。
- 现有 IME、内容模型和输入回调契约保持不变。

## Validation

1. 记录源代码入口清单：每个实际编辑入口归入共享控件、原生控件或 Tiptap，注明对应规则与合理排除项；不要仅用 JSX 正则作为完整证明。
2. 在运行中的应用检查真实 DOM 计算样式：至少 390px 竖屏、844px 横屏触摸、767/768px 边界与 1280px 精细指针桌面。覆盖带调用方 `text-sm` 覆盖的 Input、Textarea、CommandInput、MentionEditor 内容后代与两个已知原生 textarea；如 CommandInput 没有现成页面，使用临时组件预览检查并记录。
3. 在 iPhone Chrome 真机记录设备、iOS/Chrome 版本、横竖屏与实际路由。测试键盘打开前后、输入、切换、失焦后再次聚焦；观察页面比例不变。可使用 `visualViewport.scale` 前后差值（稳定后不超过 0.01）或带浏览器环境说明的屏幕录像证明；视口高度变化和为光标滚动本身不算缩放失败。
4. 在同一真机确认双指主动放大仍可用，放大后输入不强制恢复初始比例。检查搜索、评论/对话、表单、文档编辑的代表路径，并对样式审计发现的特殊覆盖单独复测。
5. 对 Android Chrome、iPhone Safari 做代表入口回归；桌面检查现有字号、输入/提交和键盘导航。验证中文 IME、换行、提及插入、长文本及深浅主题无新增裁切或横向溢出。
6. 运行受影响文件的 lint、TypeScript 检查及现有相关输入/IME/提及测试。以真实浏览器检查作为 CSS 证据，不增加仅断言 className 字符串的测试或把 jsdom/桌面 WebKit 当作 iPhone Chrome 缩放验证。

真机不可用时，开发者应先完成可执行检查并通过 Chorus 评论请求设备验收，保留任务待验证；记录限制，不能以模拟器截图或自动化通过冒充真机验收完成。该设备证据是最终关闭此缺陷的条件，不阻塞方案审查。

## Risks / Trade-offs

- [触摸媒体查询覆盖宽屏平板] → 属于移动输入可读性策略；确认布局无裁切，精细主指针桌面保持原样。
- [重要声明让消费端难以覆盖] → 只提升具名类的移动字号优先级；较大字体通过显式变量保留。
- [Tiptap 子元素仍采用较小文字] → 逐层检查实际计算字号与光标位置，而不是只检查 wrapper。
- [字号变化压缩紧凑搜索框/编辑器] → 在现有视觉系统内调整必要行高/高度，并测长文本和横屏。
- [根因尚未真机确认] → 修复前后在目标环境采样；若达标字号仍放大，记录证据继续定位，不采用禁缩放兜底。

## Migration Plan

审批后在同一提交范围实现并验证，走项目正常发布流程；无数据迁移。回滚该样式与标记变更即可恢复旧行为。仅在任务验收完成后归档 OpenSpec 并同步累计 spec。

## Open Questions

产品范围已确认，无需新增澄清轮。实际设备/iOS/Chrome 版本由验收记录补齐，不能从 Safari 历史资料推定。
