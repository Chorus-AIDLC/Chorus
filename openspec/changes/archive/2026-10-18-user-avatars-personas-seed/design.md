## Context

已核对的本地实现：`src/components/ui/agent-avatar.tsx` 使用 DiceBear `Style`、`Avatar` 和单个 Voxel Bot JSON；当前安装 core 10.6.0、styles 10.5.0。`User` 有 `avatarUrl`，没有 seed。用户评论仍使用首字母。`AuthProvider` 实际读取 `/api/session`，而不是 `/api/auth/me`；dashboard layout 还自行读取会话并维护用户快照。只扩展 `/api/auth/me` 不足以完成展示与即时更新。

复用 Idea 已保存的官方证据，不重复外部研究：本地渲染与 seed 能力见 [DiceBear JS](ref:f2ca8023-d52e-49d3-81c7-7b62c914143c)；所选 Personas 与许可见 [Personas](ref:ae699e5d-d32d-4040-8d14-4d2bcfca154d)。官网示例版本与安装版本可能不同；实施和测试以 lockfile 安装版本为准，不顺带升级库。

## Decisions

### 1. 持久化与迁移

新增 `User.avatarSeed String @default(dbgenerated("(gen_random_uuid())::text"))`，不要求全局唯一索引，因为它不是身份或认证凭据。迁移先加可空列，再将已有用户的 `uuid` 复制到独立列作为初始 seed，最后设置数据库 DEFAULT `gen_random_uuid()::text` 和 NOT NULL。新老 Prisma Client、原始 SQL 或任何省略 seed 的建号路径均由数据库默认值生成随机 UUID，不能只用 Prisma 客户端的 `@default(uuid())`。复制只用于一次性回填，不意味着以后从身份 UUID 动态派生。DDL、回填和约束在一次事务内完成，不留下并发建号可写入 NULL 的间隙。

使用普通 SQL 回填及受支持数据库内置 UUID 函数，不依赖新增数据库扩展，验证 PostgreSQL 和 PGlite 的增量/空库迁移。方案修订时已用独立内存 PGlite 验证 TEXT DEFAULT `gen_random_uuid()::text` 可在 INSERT 省略 seed 时生成 UUID；正式 PostgreSQL 和完整迁移仍须实施阶段验证。OIDC、本地、默认登录中更新既有用户的代码都不得重新赋 seed。身份 UUID、oidcSub、会话版本、角色和凭据不变；旧 avatarUrl 原样保留但本功能不使用。回滚应用时保留新增列及数据库 DEFAULT，旧客户端写入省略 seed 仍应成功，不做破坏性回滚。

### 2. 写接口与权限契约

新增 `PATCH /api/users/me/avatar`，请求严格为 `{ "avatarSeed": "<UUID>" }`，不接受目标 userUuid/companyUuid、风格或任意用户字段。使用现有认证和错误封装，只接受有效的人类用户认证，按 `auth.actorUuid` 和 `auth.companyUuid` 作用域更新本人；Agent API key、失效/停用用户及未认证请求不允许写入。沿用现有认证撤销检查，不创建新权限体系。

UUID 格式和非预期字段校验失败返回 400；无效认证返回 401（Agent 明确拒绝为 403）；不存在的本人记录返回 404。成功返回现有 success envelope：`{ success: true, data: { user: { uuid, avatarSeed } } }`。服务只更新 avatarSeed；任何失败不得改动数据库。重复保存同一 seed 是幂等的，多标签页成功写入采用最后一次成功提交生效。

以客户端预览 seed 为保存值，服务端不可在保存时再随机，否则预览与结果不一致。随机按钮使用 `crypto.randomUUID()`，只改变局部草稿。仅支持同源页面的 cookie 写请求：接口检查 Origin 与可信应用 origin 一致（按部署配置处理反代），缺少 Origin 的 cookie 写请求也拒绝。仅在独立验证 Bearer 成功且实际使用该认证结果时才能免 Origin 检查；不能因 Authorization 头存在就豁免，因为现有认证函数可能在无效 Bearer 后回退到有效 cookie。若不增加认证来源识别，该端点可对所有请求强制可信 Origin。测试须包括“无效 Bearer + 有效 cookie + 非可信/缺失 Origin”拒绝；不得为该写接口开放跨源 CORS。

### 3. 读取与身份数据传播

`GET /api/session`、`GET /api/auth/me` 和相关 user service select 增加 `avatarSeed`。扩展 AuthContext 的 UserInfo 及身份 DTO：已解析的用户身份携带 `{ uuid, name, avatarSeed }`（其余已有字段保留）。读取只能在原有授权查询之后附加 seed，不新增未授权全量用户目录。

评论作者、成员/负责人、分配选择器、mention、proposal 创建者、活动与 presence 等身份数据如果只存历史名称/UUID，须在原有已授权资源读取时按 user UUID 批量查询当前 seed，再合并到响应；不能给每个头像发一个请求，也不能从旧事件 payload 固化 seed。不存在/已删除且无法解析的用户用原来的安全 fallback，不为其创建记录。

`UserAvatar` 接收 `{ userUuid, name, avatarSeed, size, className }`。无 seed 仅作为未加载/无法解析数据的 fallback，而不能成为正常已存在用户永久遗漏 seed 的理由。当前本人 seed 可由共享 AuthContext 按 UUID 覆盖旧的页面快照，设置预览通过单独的纯渲染组件/函数展示 draftSeed，不能被该覆盖机制替换。

保存成功后用返回 seed 更新共享当前用户状态；dashboard 顶部/底部及移动导航的头像读取该共享状态，不继续使用孤立快照中的旧 seed。可继续复用原有 layout 的非头像逻辑，不重构登录生命周期。刷新会话后数据以服务器为准。其他用户或其他浏览器标签页在下一次正常资源重取/页面刷新时更新，不引入额外 SSE 协议。

### 4. 本地渲染与许可

增加共享 `user-avatar.tsx`，只导入 `@dicebear/styles/personas.json`；构建单例 Style，使用固定静态选项和 seed 输出 data URI。使用有界缓存或组件 memo 避免随机预览造成无界内存增长。禁止远程头像 URL、任意 SVG 输入、按用户名字作 seed，以及复用 Agent 的机器人专用缩放。小尺寸清晰、语义颜色、明暗主题可用；姓名已在旁边时图像作装饰，独立头像具备可访问名称，生成失败时安全回退。

在设置页头像区域提供可见的 “Personas by Draftbit / DiceBear — CC BY 4.0” 署名，链接作者、风格来源与许可；保留 style 元数据中的署名，在仓库现有许可声明位置或新增专用第三方声明中记录所用来源及本应用生成/展示用途。若修改原始风格资产，声明修改；本次不修改风格定义。不让每个小头像旁边重复长署名。

### 5. 设置交互

初始状态显示 persistedSeed；随机仅更新 draftSeed。取消恢复已保存头像，离开页面丢弃未保存草稿，不发写请求。保存中禁用随机、保存及取消，避免竞态；失败保留草稿供重试，并保持正式头像不变；成功更新正式状态、清除 dirty 并反馈成功。加载中禁止操作，dirty 为 false 时禁用保存。所有控件支持键盘与中英文文案，错误/成功反馈可被辅助技术感知。

### 6. 全站扫描清单与任务边界

实施必须记录每个匹配项：具体用户头像 → 迁移；通用功能图标/纯文本 → 保留；纯 Agent → 不变。种子列表而非封闭清单：

- dashboard layout 当前用户（桌面与移动）、设置头像预览。
- unified-comments 输入与作者、mention editor/renderer 已有头像。
- assign-modal、assign-idea-modal、assign-task-modal；idea/task detail、assignee-section、task-list-view、Kanban/视图列表中的已有用户头像。
- proposal 页面与 proposal-kanban 创建者；activity、项目/组成员和 settings/users 中已有用户头像。
- presence roster/identity-block/live presence 中已有真人头像；不改变 agent-presence 中纯 Agent 组件。

扫描 `AvatarFallback`、`charAt(0)`、`getInitials`、`<User`、`avatarUrl`、`assignee`、`createdBy` 并人工分类，不能机械替换所有 User 图标。相关 API/服务新增字段由数据任务负责基础契约，展示任务负责其表面所需的其余 DTO 查询与测试。设置任务独占设置页和自助交互；展示任务独占其余展示点和共享已保存状态传播。

## Verification and Risks

- 数据测试：新建/旧记录回填、升级库上旧 Prisma Client 的 OIDC/默认登录/本地账号创建（省略 seed 仍成功）、应用回滚后旧建号、OIDC/本地登录不重置、保存准确 seed、错误与跨租户/他人字段拒绝、Agent 拒绝、400/401/403/404、无效 Bearer 回退 cookie 的 Origin 拒绝、无凭据泄漏；在隔离测试库执行迁移，禁止改动运行中的业务库。
- 组件测试：固定 seed 确定性、异常 fallback、名字变化不改变头像、缓存边界、预览/取消/失败/保存、两个本人头像同时更新、刷新后仍保持。
- 集成测试：各身份数据族批量传 seed 且授权不变；历史评论展示当前 seed；页面/标签页刷新可见新头像；加载或删除用户 fallback。
- 浏览器验收：设置连续随机、取消、成功和失败保存；移动/桌面导航与评论/负责人/成员等实际有头像的位置；明暗主题、键盘、中英文、网络无远程头像请求、署名链接与 Agent 不变。
- 执行相关 Vitest、TypeScript/lint 和构建；记录已有无关失败，不顺带修复。全站遗漏风险通过扫描清单而非仅截图防止。
- 已有 agent-avatar 规范写 Thumbs，而当前代码用 Voxel Bot，这是历史偏差；本次仅解除“用户不变”限制，不修改 Agent 风格，也不顺带修订其余历史约定。

## Rollout

先部署包含数据库 DEFAULT 的兼容性新增迁移，再部署读取/写入/UI；只新增字段，无需外部服务。发布与应用回滚窗口都保留 DEFAULT，使省略新增字段的旧应用能够创建用户。正式发布前须在 PostgreSQL/PGlite 上验证旧客户端对升级库的建号成功，不能仅验证新客户端；失败则禁止发布。Proposal 审批前不执行业务数据库迁移或功能代码实现。无新的产品决策阻塞项；实现中的字段传播遗漏属于本范围内完整性工作，不作为缩减全站覆盖的理由。
