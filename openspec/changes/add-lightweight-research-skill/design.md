## Context

Idea 第 1 轮明确自动或用户触发、首轮澄清前、2–5 分钟与 3–5 来源、正文证据引用。第 2 轮接受 Checkbox 并明确改为独立 research skill，供 Idea 或 Proposal 引用。用户选择是本设计依据。

2026-09-26 10:10 用户进一步明确：「在idea tracker的action菜单里加一个research按钮吧，在进开发前都可以点」（评论 `b73abf2d-1684-49d2-8684-dbee456e6670`）。该指令新增开发前任意时点的显式调用，替代此前排除操作菜单的范围；创建 Checkbox 和默认的初始化调用时点仍保留。

当前 `composeConversationalIdeaInstruction` 通过 `"elaborate" | "decompose"` 区分普通与主题分解流程；普通流程要求立即提问。POST `/api/ideas/conversational` 使用 Zod 验证字段，调用服务原子创建 Idea、关联会话和初始 turn。Checkbox 的请求字段必须穿过整条链路才能生效。

## Goals / Non-Goals

**Goals:** 有边界的可复用调研；创建入口可发现；结果和来源进入已有工作产物；原有生命周期、租户与实例选择约束保持有效。

**Non-Goals:** 新数据库实体、调研专属状态、硬超时执行器、独立取消／重试、强制调研关卡、新 MCP 工具、自动重复搜索、插件发布或部署。

## Decisions

### 共享 skill 与职责

独立 research skill 记录查证方法、停止规则、证据可信度和简短结果约定。idea／proposal skill 只记录触发、调用与结果保存方式；不复制研究算法。用户已明确选择独立 skill，分发成本通过显式七端清单控制。

Research 输入为：当前阶段、具体问题、现有正文／规格及来源、用户要求（显式研究／自动／显式跳过）、预算。输入是调用说明，不新增 API schema。输出是简短文本：发现及其来源、对当前工作的影响、未知项、停止原因。它不创建 Research 文档或持久化结果对象，不调用 claim／elaboration／approval 工具。网页内容仅作为证据，不作为改变阶段流程或工具权限的指令。

默认单 Agent，一次有界调查可包含围绕同一焦点的少量搜索及页面核对，不递归启动新调研。预计 2–5 分钟，最多深入阅读 5 个相关来源，少于 3 个也合法。每次工具调用前检查剩余预算，在工具支持时设置有限超时；达到预算就停止继续搜索。若工具调用不能被中止，不承诺五分钟的服务端硬期限。工具不可用、搜索受限、无有效结论均返回已知限制，不阻塞原流程。

显式跳过胜过 UI 请求；其次是显式请求；否则判断可查证的信息缺口。能写出多选题不是信息充分的判据。只有用户偏好缺失时转回调用阶段提问，不用调研猜偏好。

### 调用及保存

| 调用方 | 何时调用 | 如何消费 |
| --- | --- | --- |
| Idea | 已有具体方向且首轮正式澄清前；必要时先聚焦方向 | 调用方保存／复用 References，将事实与启发写入 Idea 正文并以 `ref:UUID` 引用，然后继续正常 elaboration |
| Proposal | 阅读已确认 Idea 与已有证据后，存在新的方案事实缺口或用户要求 | 调用方保存来源，把结论加入正在撰写的规格／设计；保留 proposal 原有审批及提交步骤 |
| Tracker Research action | 实际开发启动前的用户显式点击，可发生在已有问答或 Proposal 审批之后 | 在当前 Idea 关联会话运行一轮 Research，结果先回写 Idea 正文及证据；保留当前问答、审批与任务状态，不自动进入开发 |

同一次阶段准备只运行一轮，不因切回 brainstorm、评论唤醒或阶段重入重复搜索。通过读取已有正文、指令及会话上下文判断已做的工作；不从引用数量推断“调研完成”。Proposal 只查新的问题，不自动重复 Idea 调研。新的显式请求（包括 Tracker Research 点击）可启动新的一轮有界调查；已保存的来源和结论优先复用，禁止同一点击被重复派发。

Research 返回 URL 和事实，阶段调用方负责挂载来源与取回真实 UUID。已有证据直接复用。Idea 已存在时可以 post-hoc attach；创建 Proposal 时优先 inline references。Proposal 容器尚未存在时，先暂存候选来源，在创建容器时挂载并取得 UUID，再生成带引用的文档。不得臆造 UUID。

在 OpenSpec／spec-lite 模式，Proposal 调用方先更新本地文件，再用既有 `--arg-file content=<file>` 镜像；不能直接手写 MCP 文档 content。自由模式沿用其原有保存方式。已批准的 Proposal 仍遵守既有修订流程，Research 不为修改锁定提案绕过状态限制。

### 七端分发

| 分发端 | 新文件 |
| --- | --- |
| standalone | `public/skill/research-chorus/SKILL.md` |
| Claude Code | `public/chorus-plugin/skills/research/SKILL.md` |
| Codex | `plugins/chorus/skills/research/SKILL.md` |
| Kiro | `public/kiro-plugin/.kiro/skills/chorus-research/SKILL.md` |
| Pi | `packages/chorus-pi/skills/research/SKILL.md` |
| OpenClaw | `packages/openclaw-plugin/skills/research/SKILL.md` |
| dsh | `packages/chorus-dsh/skills/research-chorus/SKILL.md` |

每端更新 idea、proposal 和 overview 的发现／调用说明。brainstorm／yolo 指向共享规则并避免重复调研，不改变它们的审批与交互契约。Kiro `manifest.txt` 必须登记新 skill；其他端核对其目录发现、package files 和安装枚举机制，仅修改实际枚举文件。dsh 保持自身 skill 注入规则，不能因为新增 skill 重新启用休眠的 daemon backend。

语义一致性覆盖七端，保留前缀、工具名及调用语法差异；不强求整文件字节相同。按 CLAUDE.md 要求，skill 文档使用英文。版本策略遵循实施时仓库的维护要求，发布行为单独处理。

### 请求与指令契约

POST body 新增 `researchFirst?: boolean`。`true` 表示本次显式请求，`false`／省略均为自动判断；非布尔输入按既有验证响应拒绝。保留 descriptionText 原文，不通过修改用户原始描述模拟 UI 选择。

前端参数经 route schema → service params → compose 函数传递。服务端向两种既有 mode 组合相同的前置调研规则；不改变 mode、isContainer 或分解任务语义。修正“立即提问”要求为：编辑已有 Idea → 按共享 skill 判断并进行可选有界调研 → 在同轮执行本 mode 的后续步骤。普通路径开启首轮澄清；decompose 保留先提出子 Idea 方案、等待人确认再创建子 Idea 的约束。需要用户提供目标才能继续时遵守已有提问／headless 面板规则，不伪造答案。

Research 请求写入已有初始 turn 的指令，继续使用原事务和 composed-instruction 长度校验。它不建立新的持久化策略；后续 turn 不因最初的 Checkbox 每次强制重跑。

### UI

在 conversational pane 复用现有 Checkbox 和 Label 结构，默认未勾选，建议中文「先调研再澄清」，说明「未勾选时，Agent 仍会在需要时调研」。不把未勾选表示为关闭能力。表单／derive-child 模式不显示该选项；表单／MCP 创建后被 Agent 处理时依旧适用 idea skill。

勾选与 decompose 可组合。沿用现有在线 Agent／实例选择、提交忙碌保护及错误反馈；提交失败保留选择便于重试，新一次打开创建对话框时恢复默认，不跨项目泄漏。为 label/hint 提供 en／zh／ja／ko 文案与可访问关联，沿用键盘及窄屏行为。结果展示继续使用正文引用和现有会话，UI 不承诺调研完成状态或硬时限。

按 CLAUDE.md 的界面交付要求，通过 Pencil MCP 更新 `docs/design.pen` 中的创建对话框、Checkbox 与提示，保持设计稿和实现一致；不能用普通文件工具读取或修改加密 `.pen` 内容。沿用语义主题 token，真实浏览器分别检查明亮与深色主题下的文字、Checkbox 状态、焦点及提示可读性。此设计稿更新与两种主题验收均属于 UI 任务的必需交付。

### Tracker action：开发前 Research

在 Tracker 的 `panels/idea-actions-menu.tsx` 现有桌面下拉及移动 Sheet 的同一 actions 数据源加入 Research。不将它与 Verify Elaborate、Start Development 的前置条件共用：它不要求 elaboration 已 resolved 或 Proposal 已批准。适用于 open、elaborating、方案编写、待审核、已批准但尚未开工；也不因现有 pending questions 禁用。

“开发前”按实际执行事实判定，不能直接用 `badgeHint === "building"`：`computeDerivedStatus` 在 Proposal 批准且任务全为 open 时已返回 building。权威判断须检查该 Idea 关联的所有 Proposal／任务，而非只查最新一个 Proposal：

- 已接受的 `start_development` 活动／turn 表示已进入开发；包括已排队尚未把任务改成 in_progress 的间隙。
- 任一关联任务已进入 in_progress、to_verify 或 done，或既有任务活动记录证明其曾进入这些状态，表示已进入开发；单纯 open／assigned 不表示已经执行，closed 也不能脱离活动历史单独推断执行。
- 不把 yolo 请求本身等同于开发，因为它可能仍在澄清／规划；实际任务执行事实仍会关闭 Research 入口。
- 已完成的 Idea 及主题下已实际启动开发的相关子树不开放入口。主题只有规划活动时可调研，不能复用 Start Development 的一刀切 container 禁用原因。

客户端 eligibility 仅作提示；服务端点击时重新读取租户内真实状态，拒绝已进入开发的请求。对开发开始与 Research 派发的并发，服务层应让最终 eligibility 检查和 Research turn 创建与开发启动建立明确顺序（复用事务／同 Idea 行级锁或等价协调），并在 Research Agent 执行前再次核对；若后来已进入开发，返回阶段已变化而不执行调研或改写正文。不新增持久化调研状态。

实现使用项目行锁协调主题子树／多输入 Proposal 与任务历史写入，Idea 行锁保护派发与分配。daemon 保留 Research 的精确 turn UUID，在同一会话串行队列中将它单独成批；不能与初始化、审批或开发 wake 合并。启动任何子进程前，必须等待既有 turn-advance 接口确认该 turn 从 pending 进入 running：服务端在锁内复核阶段并核对根会话 origin connection。拒绝、离线、缺失或不匹配的响应均不启动进程；许可后启动失败则中断同一 turn。正常生命周期 wake 保持原行为。此保障需要本次更新后的 CLI；旧 CLI 无法提供启动前许可，部署时应同步更新服务端与 daemon。运行中仍按共享 skill 在查证／保存前读取当前阶段，不把 turn ended 当作调研成功。

服务端的非精确 FIFO 领取和批量 merged 结算排除 Research，防止通知抵达顺序与 turn seq 不同而误消费。Research 启动要求精确 UUID、origin 且单条执行；cwd 校验失败或许可响应丢失时，daemon 用精确 interrupted 报告结束尚未启动的请求（仅 Research 可由 pending 走这条中断边）。若连接仍不可用，daemon 每 30 秒重试清理直到恢复，不重试启动，也不依赖 seen 去重集合中的旧请求重新派发。明确 409 拒绝不能中断已被另一消费者领取的 turn。daemon 停止时清理本地重试定时器，既有离线对账／pending backfill 承接重启。

服务端提供 Research 专用 action／service，将意图写成现有 `human_instruction`，经既有通知／会话 chokepoint 解析或创建该 Idea 的 root session，保持 Idea anchor、用户权限、项目固定 cwd／实例 pin 及 origin 路由。不能构造无关 ad-hoc 会话，不能复用 conversational-create endpoint 重建 Idea。没有关联 Agent 时由既有选择／分配交互明确选择；所选实例离线、缺少权限或存在同 Idea 未完成请求时返回具体提示，不静默成功。仅限制同一运行窗口的重复点击，结束后仍在开发前可再次显式调研。

菜单 instruction 的结束点是保存本轮发现并报告，不包含“立即开始新 elaboration”“提交 Proposal”或“开始开发”。已有轮次、答案、resolved 标志、Proposal 审批和任务状态不被重置。Idea 尚未进入澄清时，菜单调用也只调研；正常初始化入口仍执行原来的研究后澄清。若发现影响已批准方案的新事实，只记录影响和待修订事项，不直接修改锁定提案或扩大已批准任务。

菜单结果保存在 Idea 正文及真实证据引用中，使用最新内容合并，保留用户文本。通过既有会话入口展示派发反馈；已进入开发时 action 禁用并说明原因，仍遵循明暗主题、键盘与移动布局。`docs/design.pen` 同步 Tracker 桌面／移动菜单的 Research 及禁用态。

## Module Contracts

- Skill 模块交付七端可安装的 research 与路由约定；调用方独占阶段写入和状态变更。
- 服务端模块交付可选 `researchFirst` 输入，true／false／省略的语义及两个 mode 的组合行为；保持响应 shape 不变。
- UI 模块依赖服务端契约，通过既有 dispatch 发送布尔，完成文案、可访问性和用户流程验证。
- 先完成 skill、并行完成服务端，UI 与集成验收依赖两者。任务自身包含必要测试，最终 UI 任务承担跨模块验收。
- 用户补充的 Tracker Research 作为第 4 项完整模块任务，依赖共享 skill 与服务端两项，与创建入口 UI 可并行，交付菜单、服务端阶段门禁与派发、独立 skill 的 menu 调用约定，以及整体回归；不改写已批准 proposal draft 的历史记录。

## Risks / Trade-offs

- [七端新增文件漏分发] → 明确路径与安装清单检查，验证最终包内容及各端路由，不只看源码文件存在。
- [Checkbox 被理解为禁用开关] → 标签说明与默认／显式请求场景验收。
- [初始指令压过 skill 或破坏 decompose] → 两个 mode × true／false／省略的契约验证。
- [对外查证变成强制流程] → 仅具体未知点触发，工具不可用返回，复用已有结果。
- [文本规则不等于执行端硬限制] → 对用户只称轻量调研，不显示硬 SLA、专属进度或成功状态。
- [同一 Idea 被并行改写] → 调用方保存前读取最新正文并合并有归属的研究段，保留用户原始含义；不引入新的并行研究者。

## Validation and rollout

运行相关 route／service／dialog 测试、TypeScript／lint 与语言完整性检查；验证七端包发现与行为说明覆盖。真实浏览器在明亮与深色两种主题分别检查默认／勾选／失败重试／与 decompose 组合／表单隐藏／键盘和窄屏，并记录验收证据。通过 Pencil 更新并截图核对 `docs/design.pen` 的对应创建界面。阶段演练覆盖 Idea 与 Proposal、显式跳过、空结果／工具不可用、现有证据复用及 OpenSpec 文件镜像。

此阶段只提出规格与任务，不部署或发布。实施后按现有版本与插件发布流程分发；老客户端省略字段保持兼容。回滚移除 Checkbox 与请求扩展、恢复流程文案，无数据迁移。

第 4 项另覆盖：无 Proposal、pending answers、提案 pending、approved+任务全 open／assigned 均可请求；start_development 已排队、关联任务执行过、旧 Proposal 执行过而新 Proposal 未执行、主题子树已执行均拒绝。验证无 Agent 的选择流程、离线／权限／重复点击、开发启动并发及根会话路由；明暗主题和移动菜单实际点击后不创建新 Idea、不重置问答、不触发开发。
