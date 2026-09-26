## Context

本设计依据用户纠正：直接使用证据 UUID 链接，主要修改渲染层，不动数据结构。此前按每资源证据集合隔离的方案已作废，Document 不需要新挂载能力即可引用已存在的证据。

现有 `src/app/api/references/[uuid]/route.ts` GET 已按 company 隔离且鉴权，并返回 `{success:true,data: ReferenceArtifactResponse}`；缺失或跨租户为 404。现有 `MarkdownContent` 是 Streamdown 统一入口，所有正文与评论经由该入口。

## Goals / Non-Goals

**Goals**：作者写 `[1](ref:UUID)`；读者看到 `[1]`，hover/focus 看详情、点击打开外链；失效显示灰色提示；Agent skill 能正确生成。

**Non-Goals**：数据库/服务/API/MCP 契约变更、Document target、所属资源绑定、跨资源关联表、自动编号、快照、编辑器选择器、额外列表复制按钮、导出格式扩展。

## Decisions

### Markdown 链接语法

规范示例为 `[1](ref:550e8400-e29b-41d4-a716-446655440000)`。显示文本由作者选择（推荐递增数字、重复同一证据复用数字），渲染为带方括号的小型引用标记；UUID 才是身份。保持标准 Markdown 解析，所以行内/围栏代码、转义文本不会转换。UUID 必须是 8-4-4-4-12 十六进制格式，大小写可读并规范化为小写。无效 ref 目标不能导航到自定义协议。

在 MarkdownContent 合并 anchor override，保留调用者已有 custom tags（尤其 mentions）、components、allowedTags 和 literalTagContent。URL transform 只为合法 `ref:UUID` 保留自定义 scheme，其余交给 Streamdown 默认安全转换；普通链接仍使用 Streamdown 原有 renderer 或调用者原有 anchor override，确保普通链接行为不退化。先验证安装的 Streamdown 实际 API。

### 直接 UUID 读取

引用组件调用现有 GET `/api/references/<uuid>`（same-origin credentials）。渲染代码不接收 targetType/targetUuid，不验证“挂载在当前资源”；权限完全沿用现有接口。

同一 Markdown 渲染树重复 UUID 共用客户端状态；不同渲染树只共用进行中的请求，请求结束即移除，不缓存全局已解析证据。最后一个消费者卸载时取消请求；组件卸载或 UUID 改变后忽略旧响应。IntersectionObserver 延迟屏幕外/被裁切引用的首次读取，进入可见区域或交互时加载；之后 hover/focus 与窗口重新聚焦可刷新已加载引用。请求和响应体解析整体限时 10 秒，超时取消并允许重试。无需改造服务端变更事件。

区分 loading、ready、missing（404）、error（网络/其他 HTTP 错误）。无已加载数据时 loading/error 提示本地化文案且不导航，不能误报“证据不存在”。已 ready 的引用刷新失败时保留已有详情与链接，并显示本地化刷新失败说明；后续成功清除提示，404 必须移除链接。不承诺实时推送。

格式错误的 ref 目标转为无 href 的普通文本，不生成空链接。Streamdown 默认 anchor 缺失时安全降级为文本，并在开发环境告警；sanitizer 匹配失败也在开发环境告警。仅含引用的 Markdown block 使用内容 key，绕过 Streamdown paragraph/list 子元素仅比较源码位置导致的等长 UUID 修改缓存问题；相邻代码/Mermaid block 不因此重新挂载。

### 引用交互

使用现有 Tooltip/Popover 和 semantic tokens；hover/focus 展示 title、type、URL、非空 notes，长内容不超出视口。有效引用是标准 anchor，直接新标签页打开 HTTP(S) 原 URL，`rel=noopener noreferrer`，无额外确认。触屏点击直接打开链接。对旧数据中非 HTTP(S) URL 禁用跳转。

missing 为灰色标记、无 href、保持可聚焦以获得“证据不存在”（以及其他 locale 对等文案）。所有状态有可访问文案，且兼容明暗主题。不要在引用弹层中递归解析 notes 的引用。

### Skill 文档

在现有 References/External Evidence 章节旁补充：先挂载/读取已有证据获取 reference UUID，然后在任意资源正文或评论中写 `[1](ref:UUID)`；UUID 是证据记录 UUID，不是 Idea/Task UUID，也不是证据 URL；有效引用跟随最新详情，失效保留灰色提示。说明现有 create 工具只能在创建返回 UUID 后写入正文引用，不能预先猜 UUID。更新七个文档分发端，保持端特有工具名称与约定。

## Module Contracts

- Task 2：新增纯 ref href 识别、安全 URL helper、客户端 UUID 详情状态和共享引用组件；只在 MarkdownContent 接入，不引入每资源 context props。完成语法/数据加载/真实 renderer 和 locale 测试。
- Task 3：文档分发端同步与实际正文/评论集成验收；复用 Task 2 行为。无服务端改动。
- Task 1：原 Document 扩展撤销并关闭，不再实施。

## Risks / Trade-offs

- 自定义 scheme 被 sanitizer 清掉 → 在 renderer 集成测试核对 urlTransform 管线，且只放行严格 UUID。
- anchor override 破坏普通链接 → 保持普通链接的既有 renderer/安全行为，混合 Markdown 测试验证。
- 详情过期/401/404 → 交互重新读取、区别 loading/error/missing，不持久缓存跨会话数据。
- 代码或转义文字被误解析 → 使用 Markdown 的 link 节点，不做整段字符串替换。

## Verification and Rollout

验证普通 Markdown、mention、frontmatter、代码、Mermaid 与 ref 链接混排；缺失/跨租户 API 404、网络错误、重复 UUID 请求合并、URL 更新与删除、键盘和明暗主题。真实浏览器验证至少资源正文、Document 正文及评论共用渲染路径。运行受影响测试、TypeScript 与 lint。数据无迁移，回滚仅影响显示。

Pencil 当前因没有已连接的应用无法使用。实现后记录 UI 截图作为审阅材料；若仍无法连接，报告设计文件同步限制，不改变代码交付范围或伪称已更新设计文件。
