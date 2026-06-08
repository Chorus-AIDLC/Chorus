---
title: "Chorus v0.9.4: OpenClaw 出了 SDK，Codex 改了 hook，顺带修了一堆问题"
description: "OpenClaw 2026.4.27 上正式 Plugin SDK，Codex 也换了 hook 加载机制。Chorus 的两个三方插件按新规矩重写了一遍，顺带把主仓库这一个月的毛刺也磨平。"
date: 2026-06-08
lang: zh
postSlug: chorus-v0.9.4-release
---

# Chorus v0.9.4: OpenClaw 出了 SDK，Codex 改了 hook，顺带修了一堆问题

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.9.4 发布了。距离 v0.9.0 过去刚好一个月，中间 0.9.1、0.9.2、0.9.3 上线时博客都没动笔，索性把这一个月做的事一口气写清楚。

这个月最要紧的活不在主仓库，在两个三方客户端的插件上。OpenClaw 在 2026.4.27 之后正式发布了 Plugin SDK，Codex 那边的 hook 加载机制也换了样。Chorus 给这两边都有插件，跟不上就直接坏掉。所以 0.9.2 和 0.9.3 里大头是把这两个插件按新规矩重新做一遍。

主仓库这边趁这个月把 0.9.x 跑出来的几个磕一下的地方也磨平了：澄清流程的循环、任务的验收标准、提案的读取代价、报告写完之后的可见性。

---

## OpenClaw 出了 Plugin SDK，Chorus 插件按 SDK 重写

[OpenClaw](https://github.com/OpenClaw-AI/OpenClaw) 在 2026.4.27 版本里第一次正式提供 Plugin SDK。在那之前，要给 OpenClaw 写插件得自己动手糊：拦工具调用得手包一层 wrapper，从外部触发 agent 行为得用 HTTP hook 在外面架个桥，SSE 事件来了得手动拉一遍 reviewer。能跑，但每件事都是绕着 OpenClaw 走，不是顺着它走。

旧版的 Chorus OpenClaw 插件就是这么来的。能用，但维护成本高，每次 OpenClaw 自己升级一点点都可能踩到。

v0.9.2 借这次正式 SDK 的机会把它整个重写：

**MCP 注册改成原生。** 直接调 SDK 提供的 `mutateConfigFile`，让 OpenClaw 自己负责把 Chorus 的 MCP server 加到 config 里。不再手包工具，不再自己写 wrapper。

**入口改成 `definePluginEntry`。** 启动时机声明成 `activation.onStartup`，OpenClaw 启动时主动加载这个插件，不再依赖外面的脚本去激活。

**SSE → agent 唤醒走 `runEmbeddedAgent`。** 之前用 enqueueSystemEvent + heartbeat 模拟唤醒，时机不稳，偶尔事件丢了 reviewer 就跑不起来。新 SDK 直接给了一个 embedded agent 入口，传 prompt 进去就行。

**Reviewer 从 Claude-Code agent 定义改成 OpenClaw skill。** 旧版 reviewer 是 Claude Code 的 agent 定义，硬塞给 OpenClaw 用，水土不服。新版改成 OpenClaw 自己的 skill 形态，跟其它 OpenClaw skill 同构。

**npm 发布路径同时带 `src` 和编译后的 `dist`。** linked install（开发时直接挂源码）走 jiti 加载 TS，npm install（最终用户）直接用 dist 里的 JS。两条路径都能跑。

加了 66 个新单测覆盖关键路径。OpenClaw 包的版本号是独立序列，这次到 0.5.3。

---

## Codex 插件 hook 加载机制修了

Codex 这边问题没那么戏剧，但坑得人也很疼。

v0.9.0 之前，Chorus 的 Codex 插件安装时是把一份 hook 文件**拷到用户目录**的。这套有几个老问题：

第一，下次升级 Chorus 插件，老的 hook 拷贝还在用户目录里，新版的 hook 也注册一份，于是同一个事件会跑两次。Activity 写两条、checkin 跑两次的现象都出现过。

第二，老 hook 里指向的某些功能可能在新版里已经下线，但拷贝还在自顾自跑，行为对不上文档。

第三，用户根本不知道这份 hook 在 `~/.codex/` 里，要清也不知道清哪个。

v0.9.3 把这个改了：

**Hook 改成插件包内自带。** Codex 启动时直接读插件包里的 hook 文件，不再依赖用户目录里的拷贝。这意味着下次插件升级，hook 跟着升级，没有滞留版本。

**安装器主动清老的拷贝。** install 脚本检测到用户目录里有 Chorus 历史 hook 项时，会问用户要不要删。明确告诉你这些是哪儿来的、留着会怎样。

**docs 和 skill 跟着更新。** Codex 插件的 skill 文档刷一遍，把过期的 hook 说明和命令对齐到当前形态。

这件事看起来是修 bug，但它顺手把 Codex 插件的运维模型也往可持续的方向掰了：插件升级=拿新版即可，不需要用户再手工清家底。

---

## 主仓库这边：澄清不是一锤子，是个循环

主仓库这一个月最大的改动是澄清流程。

Chorus 的 Idea 澄清阶段一直跑的是结构化多选题：调 `start_elaboration` 出一轮问题，agent 调 `answer_elaboration` 答完，调 `validate_elaboration` 落定。论文里这套很好看，写成"问→答→定"三步走。

实际跑起来不是这样。agent 答完一轮，下一步怎么走通常要看刚才答的内容。有时候答案很顺可以直接定，有时候答案里冒出新的不确定要再来一轮，有时候人类 reviewer 看了之后觉得有个角没问到要补一轮。原本的接口逼着这三种情况走不同路径，每条都有点别扭。

`validate_elaboration` 之前是按 round 工作的，每一轮都能被 validate 成 `validated` 或 `needs_followup`。乍看灵活，实际上 round 状态和 Idea 整体的"澄清完了吗"是两回事。一个 Idea 可能有三轮，前两轮没问题，第三轮还在跑，这时候 Idea 整体显然没澄清完，但前两轮已经被标 `validated`。两套真值同时存在，谁说了算？

`answer_elaboration` 上有个 `roundUuid` 参数一直是必填的。但任意时刻一个 Idea 上活跃的 round 顶多一个，agent 还要先去查它再传回来，这一查一传纯属仪式。

最让人头疼的是"澄清完了之后还想再补一个问题"。一条 Idea 已经 resolved 进了 proposal 阶段，reviewer 看 proposal 时发现某个边界没聊清楚，想加一轮。原来的模型里没这个口子，要么把 Idea 退回 `elaborating` 状态（这又会卡死正在跑的 proposal），要么彻底跳过澄清。

v0.9.4 把这套重做了一遍，按它实际的样子：

第一，**`start_elaboration` 是唯一的"出问题"入口**。第一轮、追问、resolved 之后再补问，全走这一个工具。补问的轮带上 `isAppended=true` 标记，UI 上挂个 "Follow-up" 角标；Idea 状态保留为 resolved，所以正在跑的 proposal 不会被卡。

第二，**`answer_elaboration` 的 `roundUuid` 改成可选**。一个 Idea 同时只能有一个 `pending_answers` 的轮，工具自己去找就行了。

第三，**`validate_elaboration` 改成 Idea 级**。它做的是一件事：把这条 Idea 的 `elaborationStatus` 标成 `resolved`。前置条件是这条 Idea 至少有一轮、且每一轮都已经 `answered`。它不再去碰任何 round 的状态。round 的活动状态只剩 `pending_answers → answered` 两态，原来的 `validated` / `needs_followup` 留作历史数据，不再写入。

第四，**循环写进 skill 里**。idea / yolo skill 里把这个循环写明白：答完一轮看情况，要追问就再调一次 `start_elaboration`，循环到 agent 自己（YOLO 模式）或者人类 reviewer（普通模式）觉得真聊清楚了，再 validate。不再硬塞一个"一轮就完事"的隐式假设。

跑下来手感差很多。

---

## 任务必须有验收标准

Chorus 的任务一直支持 `acceptanceCriteriaItems`，是验证机制的核心。但旧的实现里 AC 是可选的，建任务时不传，就是一个没有验收清单的任务。

听上去无所谓，实际上很糟糕。一个没有 AC 的任务跑到 verify 阶段，agent reviewer 没东西可对，只能回到"看起来做对了吗"，跟没有验证差不多。最容易这样裸奔的就是 agent 自己批量建任务，prompt 里写得不够细就漏了。

v0.9.3 把 AC 设成强制约束。`chorus_pm_add_task_draft`、`chorus_create_tasks` 在创建时拒绝空 AC，`create_tasks` 是全有或全无，一条 AC 缺失整批就被拒。校验逻辑抽到 `src/lib/acceptance-criteria.ts`，proposal 服务和 MCP 工具共用同一个真值。

更新接口走部分语义：传了 AC 必须非空（直接替换），没传就保留原值。这样状态切换、改依赖这些不涉及 AC 的更新照常走，不用每次都把 AC 重发一遍。

v0.9.4 顺手把 UI 也对齐了。Task Draft 用的是结构化行编辑器（一行一条，每条带必选开关），但真实 Task 的编辑表单一直是一个老 markdown 文本框。两个面板看着像同一个字段，编辑体验完全不同。把结构化编辑器抽成共享组件，两个面板从此长得一样，编辑保存回退到同一个 `replaceAcceptanceCriteria` 服务。前端只在条目集合真的变了的时候才触发替换，所以改个标题、改个状态，已经验证过的勾选状态不会被洗掉。

---

## 取提案不用每次抓整份

之前 `chorus_get_proposal` 是个胖工具：传 proposalUuid，返回 proposal 元数据 + 全部 document drafts 的 markdown 内容 + 全部 task drafts 的字段。一份正经 proposal 三份文档加十来个任务，content 上一万 token 都打不住。

实际工作流里，agent 大多数时间只想看个目录："这份 proposal 里有几份文档、几个任务、各自的标题是什么。"真要细看再钻进去看具体某份。但旧接口逼着它每次都吞下整份。

v0.9.2 加了 `section` 参数：`basic`（默认）只返回元数据 + 文档/任务的轻量索引（uuid、type、title、内容长度等），`documents` 返回全部文档内容，`tasks` 返回全部任务字段，`full` 是原来的全量行为。

实现上是在不动的 `getProposal()` 上面套了一层投影 `getProposalSection()`，REST 路由和前端没改，老的全量调用方继续工作。skill 里把 reviewer 调成 `section:full`（review 时就是要全量看），develop / task-reviewer 调成 `section:documents`（按需取文档），其他场景拿默认 basic。

这个改动看起来不起眼，但一份 proposal 跨多次工具调用展开下来，拉下来的 token 总量从几万降到几千。

---

## 写完的报告，得让人看见

v0.9.0 加了 Idea 完成后的总结报告。但当时只是把报告写进了数据库，没接通知系统。报告写完，得有人主动打开 Idea 详情页才能看到。这种"按需可见"对一份正式总结来说不够。

v0.9.1 把报告接进通知流。`chorus_create_report` 写入成功后会发 SSE 事件、记一条以 Idea 为目标的 Activity，对 Idea 创建者、负责人、人类 owner 都触发铃铛通知。点通知直达 dashboard 的 Idea 面板。`document.service` 里这些副作用都标成 best-effort，事件发不出去不会回滚 document 写入。

同时打了一个去重补丁。/yolo 流程里有两条独立路径都会触发"该写报告了"的提示：PostToolUse hook 提醒一份，skill 自身的 Phase 5b 收尾步骤再来一份。两边各跑各的，结果有时候同一条 proposal 上写了两份报告。`chorus_create_report` 加了 `force` 参数（默认 `false`）：默认情况下，对已有报告的 proposal 直接报 MCP error，写不进去；要重写就显式 `force=true`。

---

## 顺带几件事

**新建 API Key 之后，不再是个死路。** 之前在 Settings 创建 agent key，成功页只有一个 "Done" 按钮和裸 key 文本，下一步要做什么，要装哪个客户端，怎么填，没人告诉。而 onboarding 里早就有一份覆盖 5 个客户端的完整安装指南。0.9.4 把这份指南抽成 `AgentInstallGuide` 共享组件，Settings 创建页和 onboarding 都消费同一份。新 key 直接嵌在示例配置里，复制粘贴就能用。

**输入法不再吞字。** CJK / 日 / 韩输入法用户按 Enter 选词的时候，原本会触发表单提交、对话框关闭、搜索跳转，正在选的词就丢了。v0.9.1 加了一个 `isImeComposing(e)` helper（看 `nativeEvent.isComposing` + Safari 上的 `keyCode === 229` fallback），全项目 7 个 Enter 处理点都改走这个 helper。CLAUDE.md 里加了一条规则，以后写 Enter 处理一律先过这个判断。

**Modal 里的 @-mention 终于点得动了。** 提案评论是 Sheet（Radix Dialog）打开的，里面的编辑器 @-mention 弹层挂在 `document.body` 上，被外层 dialog 的 `pointer-events:none` 屏蔽了：键盘能选，但点不动，一点就把 dialog 关掉。v0.9.2 把弹层挂到编辑器自己的 wrapper 下，仍然 `position:fixed` 不被裁，`pointer-events` 走对了。

**插件版本对齐。** 0.9.1 / 0.9.2 / 0.9.3 / 0.9.4 上 Claude Code 和 Codex 插件全部 lockstep 跟主版本号，4 个 skill surface（Claude Code 插件、Codex 插件、OpenClaw 插件、独立 `/skill/` 包）的文档都跟着这一批改动一起更新。Standalone `/skill/` 包在 0.9.3 补全了 yolo / proposal-reviewer / task-reviewer / brainstorm / quick-dev 这几个之前没注册的 skill，对齐成完整一套。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

Codex 插件按 release 文档重新装一次。装的时候安装器会问要不要清理历史 hook 拷贝，按 Codex 那一节的说法选就行。

OpenClaw 插件：

```bash
npm i -g @chorus-aidlc/openclaw-plugin@latest
```

注意几个 break：

- `chorus_pm_validate_elaboration` 现在只接受 `ideaUuid`。原来的 `roundUuid` 参数已经移除，脚本里直接传过它的需要去掉。
- 任务创建必须带 AC。`chorus_pm_add_task_draft` / `chorus_create_tasks` 之前能接受空 AC 的调用现在会失败。

v0.9.4 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.4) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.9.4](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.4)
