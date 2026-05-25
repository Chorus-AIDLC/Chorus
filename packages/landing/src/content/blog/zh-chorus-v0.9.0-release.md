---
title: "Chorus v0.9.0: 让你的想法有始有终"
description: "想法刚冒头就被逼着做技术决策，干完一件事又散场散得干干净净。这版把两头都补一补。"
date: 2026-05-25
lang: zh
postSlug: chorus-v0.9.0-release
---

# Chorus v0.9.0: 让你的想法有始有终

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.9.0 发布了。这版补了想法的两头：开头帮你把想法想透，结尾给落地的想法留一份总结。

---

## 帮你想得更清楚

有的时候脑袋里的想法还很模糊，自己都没完全想清楚要做什么。这种时候，如果澄清阶段上来就问技术决策问题，比如"时间格式选 ISO 8601 还是相对时间？""页面位置放设置页还是用户头像下拉？"，就很容易把"还没想明白要不要做这件事"这一层掩盖过去，顺着技术决策一路走下去，做出来的东西未必是最初想要的。

Chorus 的想法澄清阶段一直走的是结构化多选题，每一轮都是 2 到 5 个选项的多选题。这个形式在收敛阶段确实好用，选项都摆在台面上，能审、能比对、批准之后能直接拼进提案的上下文。但它假设了一件事：你心里大致已经有谱了，剩下的只是在几条已知路径里挑一条。想法还没成型的时候上这一步，往往就掩盖了真问题。

这个事 [@obra](https://github.com/obra) 的 [superpowers](https://github.com/obra/superpowers) 早就摸索出来了。superpowers 是一套给 Claude Code 用的 skill 集，里面最受欢迎的之一就是头脑风暴：先用开放式对话把模糊的想法聊出形状，再进入下一步。这个思路放在 Chorus 的想法澄清阶段也直接管用，先发散，再收敛。

v0.9.0 借这个思路加了一个可选的 `brainstorm` skill，专门接在需求细化前面。

它分两步。

第一步是发散。智能体用开放式问题陪用户聊天，没有选项，没有格式约束，就是聊天。"这个时间主要给谁看？""他们什么时候会去看？""你在意精确到秒还是分？"聊到用户对自己想要什么有个大致轮廓为止。

第二步是收敛。skill 把这段对话提炼成一轮需求细化，把刚才聊出来的几个决策点整理成 2 到 5 个选项的多选题，调 `start_elaboration` ＋ `answer_elaboration` 写进去，然后控制权交回想法 skill。

用户跟智能体细化想法的时候，智能体会先判断这个想法是不是还在没成型的阶段，是的话就提议做一轮头脑风暴；如果想法已经有明确方向，就直接进入技术选型这类更详细的落地问题。多余的步骤一步都不加。

---

## 干完了，然后呢

想法的开头补上了，另一头还有另一种掉链子。

Chorus 上记录了大量的决策记录和执行记录，智能体很快就能把这些数据综合起来，掌握一个项目的大致进度和细节。但对人来说一直少一个东西：每个想法落地之后的总结。打开 Chorus 界面，面对一大堆项目和想法，人没办法快速获取概括性的信息——这件事到底做完了吗？做的过程里留了什么没做完？最后定下来的关键决策是什么？

这种总结其实大家都在写，只是写在别处。写在 PR 描述里、写在 wiki 里、写在 Slack 频道里、写在月报里。问题是这些地方都不在 Chorus 上，下次有人在 Chorus 看这条想法，看不到。

### 每个落地的想法，都该留一段总结

v0.9.0 给每个想法加了一个总结报告。包含三段固定内容：这件事做了什么（Summary）、过程中定下了哪些关键决策（Decisions）、还有什么留待后续（Follow-ups）。

什么时候写？智能体会在三个时机判断要不要写：

- 跑 `/yolo` 端到端流程的时候，这条想法所有任务都验证完，智能体会主动写一份报告作为收尾。
- 跑 `/develop` 一步步推进任务的时候，智能体在做完最后一个任务之后会被提示去写。
- 任何时候只要一条提案下所有任务都做完了、且还没有报告，下一次任务验证之后系统会提醒智能体补一份。

人在哪里看？打开想法详情页的概览标签，时间线下面多了一块"报告"列表，把这条想法下所有提案的报告按时间倒序聚合在一起。点击一行侧拉就能看到全文。

![想法落地后的总结报告](/images/idea-report.png)

---

## 顺带几件事

**MCP 工具收一波。** 80 个砍到 77。被砍的三个都是同形重复：`chorus_pm_create_tasks` 早就标了已弃用，跟 `chorus_create_tasks` 一模一样；`chorus_add_task_dependency` 和 `chorus_remove_task_dependency` 早就被 `chorus_update_task` 的 `addDependsOn` ／ `removeDependsOn` 覆盖掉了。工具种类越多，模型选错的概率越大，砍冗余对选择准确率是直接收益。这是多轮收敛计划的第一刀，后面还有。

**会话生命周期收成两态。** 以前 `AgentSession` 有三个状态：active、inactive、closed。inactive 是 1 小时没心跳之后自动掉进去的中间态。这次回头看，发现这个中间态没人在乎，界面上判断"这个会话还新鲜吗"完全可以查询时算。所以这版直接把状态机砍成 `{active, closed}`，"新鲜度"变成 `lastActiveAt` 上的查询条件，默认 1 小时窗口。

副作用顺手做了一件事：每个会话调用过的 MCP 工具，成功之后都会刷一次 `lastActiveAt`。也就是说智能体平时正常调工具就在续约了，不再需要专门打心跳。`chorus_session_heartbeat` 留着，给特殊情况主动续约用。`chorus_create_session` 上没人用过的 `expiresAt` 参数顺手也删了。

**Reviewer 的轮数上限调高了。** `proposal-reviewer` 从 40 调到 100，`task-reviewer` 从 50 调到 100。之前 reviewer 经常跑到一半就把轮数用光，没下结论，得手动重启给更大的预算。这次直接在 frontmatter 里给够，单次审完不用再续。Codex 那边没有等价的 frontmatter，这个改动只覆盖 Claude Code 插件。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

Codex 插件按 release 文档重新装一次。

注意：`chorus_pm_create_tasks` ／ `chorus_add_task_dependency` ／ `chorus_remove_task_dependency` 这一刀是直接 break，没留过渡期。如果你的脚本里直接调过这三个名字，需要换成上面提到的等价工具。

v0.9.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.9.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.0)
