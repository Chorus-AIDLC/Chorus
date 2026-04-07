---
title: "模型变笨了，你的工作流不该跟着变笨"
description: "Anthropic 悄悄削减了 Claude Code 的 thinking 深度，又封杀了 OpenClaw 的订阅接入。模型变笨了，平台也收紧了。但真正的问题不是模型变笨，而是你的工作流对模型变化的韧性为零。"
date: 2026-04-07
lang: zh
postSlug: model-got-dumber-workflow-shouldnt
---

# 模型变笨了，你的工作流不该跟着变笨

> Anthropic 悄悄削减了 Claude Code 的 thinking 深度，又封杀了 OpenClaw 的订阅接入。模型变笨了，平台也收紧了。社区炸了锅，集体要求恢复原样。但几乎没人问一个更根本的问题：凭什么提供商动了一个参数，你整个工作流就垮了？

---

## 一、6852 个 Session 文件说了什么

2026 年 4 月 2 日，Claude Code 的 GitHub issue tracker 上出现了一个重磅帖子：[#42796 "[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"](https://github.com/anthropics/claude-code/issues/42796)。截至发稿，1043 个 reaction，95 条评论。

这不是一篇吐槽帖。发帖的团队长期用 Claude Code 做系统编程（C、MLIR、GPU 驱动），日常同时跑五到十个并发 session。他们把一月底到四月初积累的 6852 份 session 日志拉出来，做了一次完整的定量分析。

结论很明确：Anthropic 从二月下旬开始削减模型的 thinking 深度，三月初又把 thinking 的内容遮掉了——用户再也看不到模型在"想什么"。遮蔽比例从 3 月 5 日的 1.5% 一路升到 3 月 12 日的 100%。

退化不是体感，是数据。

### 关键指标

| 指标 | 退化前 ("Good") | 退化后 ("Degraded") | 变化 |
|------|-----------------|---------------------|------|
| Read:Edit 比 | 6.6 | 2.0 | -70% |
| Thinking 深度（中位数） | ~2,200 chars | ~600 chars | -73% |
| 全文件覆写占比 | 4.9% | 10.0% | +104% |
| 用户挫败指标 | 5.8% | 9.8% | +68% |
| 偷懒检测 hook 触发 | 0 次/天 | ~10 次/天 | 从无到有 |

Read:Edit 比从 6.6 掉到 2.0——以前改一个文件之前会先读七个相关文件做功课，现在读两个就动手了。这个团队还写了一个专门拦截"不读就改"行为的脚本，3 月 8 日之前一次都没触发过，之后 17 天触发了 173 次。

### 时间线吻合

3 月 8 日，thinking 遮蔽比例达到 58.4%。同一天，用户开始集中报告质量下降。原文写道：

> "The quality regression was independently reported on March 8 — the exact date redacted thinking blocks crossed 50%."

两组数据放在一起算相关性，7146 个样本，Pearson 系数 0.971。这不是巧合。

---

## 二、空中楼阁

issue 下面的讨论集中在三个方向：让 Anthropic 恢复 thinking 深度，出一个 "max thinking" 付费档，在 API 响应里暴露 thinking token 用量。都合理，但本质上都在要同一件事——让模型重新变聪明。

没人问一个更根本的问题：凭什么一个模型参数变了，我整个工作流就垮了？

如果你的开发流程全部活在模型的上下文窗口里，那就是空中楼阁——看着能住，脚下没有地基。模型 think 得深，代码质量好；模型 think 得浅，代码质量差。你对这个变量没有任何控制权。Anthropic 可以明天就改，而且根据这个 issue，他们已经改了——用户不知情的情况下。

这就是 Harness Engineering 要解决的问题。Harness 本义是驭马的装备——缰绳、鞍具、嚼子——用来驾驭一匹强壮但不听话的马。放到 AI 的语境里，模型就是那匹马，跑得快但没有方向感，harness 就是骑手套在它身上的一切外围系统。软件工程里 "test harness" 的说法更早，指的是给被测代码搭一个受控的运行环境。Mitchell Hashimoto 在 2026 年 2 月[提出 harness engineering](https://mitchellh.com/writing/my-ai-adoption-journey) 的时候，取的就是这两层意思：约束它，引导它，给它反馈。

Claude Code 的 thinking 变浅之后，模型不再先研究后修改（Read:Edit 比暴跌），不再自我纠错（偷懒行为从零到每天 10 次），不再维持长 session 的连贯推理（全文件覆写翻倍）。每一个退化症状，都是因为把本该外置的能力寄托在了模型内部推理上。

---

## 三、外置推理长什么样

拿"不读就改"这个退化来说。一月份 Claude Code 改代码之前会先读目标文件，搜一下哪里调用了它，看看头文件和测试，然后才动手做精确修改。这整个研究过程靠的是模型的 thinking token。thinking 被砍了，研究过程就跟着消失了。但如果你有结构化的任务，每条写清楚了验收标准，再配一个独立的 review agent 拿着代码逐条对照验证，那研究这个步骤就不再是"模型愿不愿意做"的问题了——系统要求它做，做不到就过不了验证。

规划也是一样的道理。issue 里说模型不再提前规划多步操作了，上来就干。但如果规划本身就发生在一个独立的阶段——需求先通过 Q&A 澄清，任务拆成依赖图，每个节点写好验收标准——那规划根本就不需要 thinking token。模型开始写第一行代码之前，规划早就做完了。

验证也一样。模型不再自己检查自己的工作了？那就别指望它自查。让一个独立的 reviewer agent 在任务完成后逐条对照验收标准。在 Chorus 里，task-reviewer 是严格只读的——它可以跑测试、查代码，但不能改哪怕一个文件，它的职责只有一个：找问题，不修问题。不符合验收标准的直接打回给 dev agent 重做。写代码的和验证代码的不是同一个 agent，权限也完全不同，这不是浪费，这是交叉验证。

---

## 四、雪上加霜：平台准入

模型能力退化已经够头疼了，但事情还没完。

2026 年 4 月 4 日，就在 #42796 发出两天后，Anthropic 的 Claude Code 负责人 Boris Cherny [宣布](https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban)：Claude 订阅不再覆盖 OpenClaw 等第三方工具的用量。OpenClaw 是当时最流行的开源 AI agent 平台，大量开发者用 $20/月的 Pro 或 $200/月的 Max 订阅跑 24/7 自动化工作流。一夜之间，这条路被堵死了，要么切换到按 token 计费的 API（同等用量可能贵十倍），要么走人。OpenClaw 的创始人 Peter Steinberger 说他[试图和 Anthropic 沟通](https://timesofindia.indiatimes.com/technology/tech-news/openclaw-creator-who-sam-altman-hired-for-millions-reacts-to-anthropic-banning-his-ai-agent-says-tried-to-talk-sense-into-anthropic-but-/articleshow/130016220.cms)，最后只争取到推迟了一周。

这不是孤例。早在一月份，Anthropic 就已经悄悄屏蔽了 Claude Pro/Max 的 OAuth token 在第三方工具中的使用（[openclaw/openclaw#559](https://github.com/openclaw/openclaw/issues/559)）。二月正式写入条款，四月一刀切。模式很清楚：平台先默许，等生态长起来了再收紧。有人拿这件事和 Twitter 封杀第三方客户端、Apple 收紧 App Store 规则做类比，逻辑是一样的。

所以你面对的不只是"模型变笨"，还有"平台随时可以改规则"。如果你的编排层绑死在提供商的 OAuth 和订阅体系上，那模型能力和平台准入这两头都捏在别人手里。另一条路是把编排放在本地，通过 plugin 和 skill 的方式接入模型，工作流定义、任务结构、验证逻辑都不过提供商的服务器。模型是可以换的执行者，不是离了它就转不了的大脑。

---

## 五、Chorus 的实践：不信任任何单个 Agent

我们做 [Chorus](https://github.com/Chorus-AIDLC/Chorus) 就是基于这个假设：不信任任何单个 agent 的端到端能力。

整个 AI-DLC（AI-Driven Development Lifecycle）工作流的设计思路就是把规划从模型脑子里搬出来，变成流水线上的结构化阶段。一个想法先经过 elaboration，在问答中把需求澄清；然后 PM Agent 生成 Proposal，里面包含产品文档、技术设计和任务依赖图，每个任务都写好了可度量的验收标准；独立的 Reviewer Agent 在方案提交和任务完成后分别做对抗性审查。写代码的 Dev Agent 只是这条流水线上的一个环节，前后左右都有人在检查它的工作。

thinking token 被砍的时候会发生什么？规划层不退化，因为规划在 Chorus 的 Proposal 阶段就已经完成了，不在模型脑子里。这里有一个关键区别：没有 harness 的时候，"先规划再动手"是模型 thinking 过程中可能出现也可能不出现的行为——thinking token 充足时它倾向于做，token 被砍了它就跳过，你对此毫无控制。但在 Chorus 的流水线里，规划是一个结构化的必经阶段：Idea 不经过 elaboration 就无法进入 Proposal，Proposal 不通过 reviewer 验证就无法拆成可执行的 Task。这不是模型"选择"做不做的事，而是流水线的拓扑结构决定了它必须做。同理，全局的任务编排——哪些 task 有依赖关系、执行顺序是什么、哪些可以并行——这些都固化在 Task DAG 里，不靠任何一个 agent 在 session 中途临时想起来。

执行层也一样。task-reviewer 会抓住"不读就改"的行为，而每个 task 本身足够小，不需要模型长时间保持高质量的连贯推理就能完成。换句话说，harness 把原本依赖模型"灵光一现"的规划和全局协调，变成了系统层面的硬约束。模型变笨了，但流水线没有变笨，因为流水线的智能不来自任何单个模型的 thinking depth，而来自阶段之间的结构性强制。

---

## 六、别再掩耳盗铃

6852 个 session 文件把数据摆到了桌面上，OpenClaw 被封杀把风险摆到了桌面上。还在讨论"怎么让 Anthropic 恢复 thinking depth"的人，是在对着铃铛捂耳朵——真正的问题从来不是模型变笨了，而是你的工作流对模型变化的韧性为零。

模型会变聪明，也会变笨，会涨价，也会降价，会开放，也会收紧。唯一确定的是它会变。你的 harness 应该让你对这些变化免疫，而不是祈祷它们不发生。

在不确定性上建确定性，这才是工程。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus)

**引发讨论的 issue**: [anthropics/claude-code#42796](https://github.com/anthropics/claude-code/issues/42796) — *"[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"*, by stellaraccident, 2026-04-02
