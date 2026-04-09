---
title: "Chorus v0.6.0 来了！给你的 Agent 团队派个监工"
description: "v0.6.0 引入独立 Review Agent、实时 Presence 感知和 IdeaTracker 全景视图。当 5 个 Agent 同时工作时，人类终于不再是瞎的。"
date: 2026-04-09
lang: zh
postSlug: chorus-v0.6.0-release
---

# Chorus v0.6.0 来了！给你的 Agent 团队派个监工

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.0 今天发布了！

> 这个版本解决三个问题：谁来审 Agent 的工作？Agent 在忙什么？从想法到交付的全貌长什么样？

---

## 一、Review Agent: 让英雄去查英雄，让好汉去查好汉

"AI 提议，人类验证"听起来很美，直到你同时跑五个 Dev Agent。

五个 Agent 并行输出，一个人类 reviewer 根本看不过来。更要命的是 Agent 提交上来的方案里经常藏着不合理的技术设计——接口定义和上下游对不上、依赖关系画反了、验收标准写得模棱两可——这些问题不逐行看根本抓不出来。人类的精力全耗在这上面了。

所以 v0.6.0 引入了对抗机制。两个独立的 Review Agent——**proposal-reviewer** 和 **task-reviewer**——作为 Claude Code 的 plugin agent 运行，Proposal 提交和 Task 完成时自动介入。它们的职责就是帮人类挡在前面：挑不合理的技术设计，检查验收标准有没有满足，确保 Agent 在有限轮次内自己把问题修好。等内容递到人类手上，已经过了一轮对抗性审查，人类只需要做最终判断，不用从零开始逐行 review。

![Review Agents in Claude Code](/images/review-agents.png)

### 不是简单的 pass/fail

早期原型用二元判定，效果很差——太松放水，太严反复打回。v0.6.0 改成三层：approve（直接通过）、revise（打回并附具体 finding）、escalate（上报人类决策）。

revise 是关键。Reviewer 不只说"不行"，还得说"哪里不行、怎么改"。每个 finding 分 `must_fix`、`should_fix`、`nit` 三级，Dev Agent 只处理 `must_fix`，不会陷入无限修改循环。

### 收敛保障

没有轮次限制的 review 循环是灾难——reviewer 和 dev 来回踢皮球直到 token 烧完。v0.6.0 给了硬约束：每个 task 最多 3 轮 review-revise，3 轮没过自动 escalate 给人类。后续轮次 reviewer 只看上一轮 `must_fix` 是否解决，不引入新问题。循环一定会停下来，不会没完没了。

### 不想用？关了就是

Review Agent 通过 userConfig 开关控制，可以只开 task-reviewer 不开 proposal-reviewer，也可以全关。快速原型项目跳过 review 直接走人类验证，完全没问题。

---

## 二、上帝视角：你的 Agent 在摸鱼吗？

五个 Agent 同时干活，你打开 Chorus 看到的是什么？之前的答案是：一堆突然刷新的页面。任何一个 Agent 提交进度，所有人的页面整体重载，你正在看的 Proposal 详情页——没了，重新加载。

这个体验太糟了。v0.6.0 从底层重做了实时系统。

### 精确刷新，不是全页重载

Agent 更新了 Task #42 的状态？只有 Task #42 那张卡片重新渲染，你正在看的 Proposal 详情页纹丝不动。事件精确路由到单个实体，不再无脑全页刷新。配套加了 toast 通知弹窗——Agent 完成任务、提交 review、创建 Proposal，右上角弹一条消息，不用盯着看板也知道发生了什么。

### Presence Indicator

整个版本里最直观的东西。Agent 正在处理一个 Task 或 Proposal 时，对应的卡片会亮起实时高亮边框——实线是在干活（写代码、提交 review），虚线是在围观（读代码、分析上下文）。谁在改、谁在看，一眼就分清。

![看板 Presence 效果](/images/kanban-presence.gif)

Proposal 详情页也一样。Agent 正在构建 Proposal——添加文档草稿、拆分任务、编辑依赖图——你能实时看到它在哪个资源上工作：

![Proposal Presence 效果](/images/proposal-presence.gif)

### Kanban 动画

看板卡片跨列移动现在有平滑的过渡动画（Framer Motion layoutId），多个 Agent 同时推进任务时能跟踪每张卡片的移动轨迹。

---

## 三、一个需求的一生

之前的项目概览页就是几个数字几个图表，看完就走。问题是：一个需求从提出到交付，中间经过 elaboration、proposal、task 拆解、执行、验证这么多阶段，分散在四五个不同的页面里。你想知道"这个需求推进到哪了"，得自己在脑子里拼。

v0.6.0 把项目概览换成了 IdeaTracker——围绕每个 Idea，把从提出到交付的整条链路压进一个面板。

点开任意一个 Idea，右侧展开详情面板。Overview 展示完整的生命周期时间轴——创建、Elaboration 问答、Proposal 审批、Task 执行进度，这个需求走到哪一步，一眼就知道：

![IdeaTracker Overview — 生命周期时间轴](/images/idea-tracker-overview.png)

切到 Proposal 标签页，左右分栏。左边直接渲染 PRD 文档内容，右边显示关联的 Proposal、Documents 和 Task 状态。不用跳到 Proposals 页面再找回来：

![IdeaTracker Proposal — 文档与方案并排查看](/images/idea-tracker-document.png)

Task 标签页同样分栏。左边是单个 Task 的详情——描述、依赖、验收标准；右边是这个 Idea 下所有 Task 的列表和状态，可以直接跳 Kanban：

![IdeaTracker Tasks — 任务详情与进度追踪](/images/idea-tracker-task.png)

![IdeaTracker 完整演示](/images/idea-tracker.gif)

### Deep Links — 人和 Agent 共享的坐标系

每个 Idea 详情面板都有独立的 URL，比如 `projects/{uuid}/ideas?idea={uuid}&tab=execution`。把链接丢给同事，他打开就直接看到执行视图，不用自己找。

但更关键的是这套 URL 结构对 Agent 同样有效。你在 comment 里 @一个 Dev Agent 附上 deep link，它瞬间定位到你正在看的 Idea、当前卡在哪个 Task、验收标准是什么，不需要你用自然语言描述一遍上下文。反过来也一样——Agent 工作汇报里引用的 Task、Proposal、Document 都带 deep link，人类点开直接跳到详情面板做 review。

五个 Agent 和三个人类同时在一个项目里工作，deep link 是把所有人——不管碳基还是硅基——拉到同一个上下文的最短路径。

---

## 其他改动

Idea 现在有从创建到所有关联 Task 完成的全局生命周期计算。之前 Idea 的状态是孤立的，你得自己去数关联的 Task 做完了几个。现在 IdeaTracker 自动聚合 elaboration、proposal、task 各阶段的进度，给出从 Idea 到交付的全局完成度。

MCP session 的空闲超时也去掉了。之前 30 分钟不活跃就断开，对 always-on 的 Agent 很不友好，现在只在客户端主动关闭时断开。

完整变更记录见 [CHANGELOG](https://github.com/Chorus-AIDLC/Chorus/blob/main/CHANGELOG.md)。

---

## 升级与试用

v0.6.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.0)。Docker 用户拉取最新镜像即可升级，首次使用参考 README 的 Quick Start 部分。

如果你在用 Claude Code，安装 [Chorus Plugin](https://github.com/Chorus-AIDLC/Chorus/tree/main/public/chorus-plugin) 即可启用 Review Agent 和 Session 自动化——不需要改任何现有工作流。

有问题或反馈？欢迎在 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 提出，或直接在 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions) 参与讨论。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.0)
