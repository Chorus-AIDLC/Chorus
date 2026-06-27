---
title: "Chorus v0.12.0: 远程唤醒 Claude Code，指哪打哪"
description: "一个 daemon 守着一个目录，可你的代码散在三个仓库、两台机器里。任务派过来，它在哪儿跑你说了不算。"
date: 2026-06-27
lang: zh
postSlug: chorus-v0.12.0-release
---

# Chorus v0.12.0: 远程唤醒 Claude Code，指哪打哪

v0.11.0 给了你 daemon。一条命令，你的机器就成了一个常驻的 Agent 运行时，服务端把活派过来，本地自己接住开始干。

但真用起来，很快会撞上一个问题：daemon 守的是一个目录，你的活却不在一个目录里。

你手上不止一个仓库，前端一个、后端一个，可能还有个 infra。你在前端目录里起了 daemon，一个后端的任务派过来，它就在前端目录里起了个 Claude，改错了地方。那每个仓库各起一个 daemon 呢？更乱。这几个 daemon 用的是同一个 Agent 身份，服务端看过去全是「在线」，任务派下来谁先抢到算谁的，你没办法说「这个任务，去后端那个目录」。再加一台工作站，笔记本和工作站上都挂着 daemon，就更分不清了。

Agent 是上线了，可你瞄不准它。[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.12.0 把每一个 `(agent, 主机, 目录)` 做成一个能单独看见、单独点名的实例：一个 daemon 可以同时守好几个目录，你在想法上钉一次，底下的提案和任务都跟着走。任务派给谁、在哪台机器哪个目录跑，这次你指哪它打哪。

---

## 一个 daemon 守多个目录

以前一个 daemon 只能守一个目录，现在起的时候把要守的几个都列上：

```bash
chorus daemon --cwd ~/work/frontend --cwd ~/work/backend --cwd ~/work/infra
```

不想写在命令行里，放进 `CHORUS_DAEMON_CWDS` 环境变量或者 `~/.chorus/daemon.json` 也行。每个目录是一条独立的连接，任务派到哪个目录，就在那个目录里起 Claude，几条线互不干扰。

目录之间是隔开的，这点很重要。一场对话在哪个目录起的，`--resume` 接着跑就只认那个目录；换个目录来接会被直接拒掉，不会偷偷找别的地方接上。不然就出最糟的那种事：你以为它在 A 仓库改代码，结果它在 B 仓库动了手。

## 把任务派到指定目录

目录一多，光知道「这个 Agent 在线」就不够了，你得看清它具体在哪几个目录在线，好把任务派到对的那个。

侧边栏那个在线 Agent 的小标，点开是一张能收起的卡片，展开能看到它每个在线目录占一行。列表里只显示在线的实例，离线的、还有 0.11.0 那种没带目录信息的老连接，都不显示；一个 Agent 要是没有任何实例在线，它自己也不出现。你看到的，都是此刻真能接活的。

@-mention、派任务、临时发条消息，用的是同一个选择器。这个 Agent 只有一个实例在线就自动选中，有两个以上就弹出来让你挑。选了哪个目录，任务就在哪个目录里跑。

派完不用干等。打开对话窗口，远程那个 Claude 怎么接活、跑到哪一步，实时都看得到。

![把想法派给远程 Agent 的某个目录，再打开对话窗口看它处理](/images/agent-daemon-wake.gif)

## 在想法上钉一次，下游自动继承

能选中具体实例之后，新问题来了：每派一个任务都得重选一次目录吗？一条想法底下七八个任务，挨个钉一遍太麻烦。

所以这一版让「想法」来当这个钉子的根。你在想法上钉一次实例，底下的提案、任务、各种唤醒，只要还是同一个 Agent，都顺着想法上钉的那个走，不用再一个个重钉。`(agent, 主机, 目录)` 现在是个可以直接指派的对象，和用户、Agent 并列，是第三种被指派的类型。

钉还分软硬。派任务是软钉：钉的实例如果离线了，就从这个 Agent 还在线的实例里挑一个顶上，任务不至于卡住。@-mention 是硬钉：实例不在线就只发一条通知，不唤醒。你点名要的就是它，它不在就等它回来，不会随便换一个。

认领用的 REST 接口和 `chorus_pm_assign_task` 也加了个可选的 `instanceUuid`，要精确指定就带上；不带就是普通指派，到唤醒的时候再去继承想法上钉的实例。

## 钉了哪个，就只叫醒哪个

光是服务端把实例算对还不够。v0.11.0 里，任务派发和 @ 这类唤醒是朝 Agent 名下所有连接广播一个 SSE 事件，这就和「钉到具体实例」冲突了：你明明钉了后端那个目录，广播一发，前端那个目录的实例也收到，谁先 `--resume` 上算谁的，钉了等于白钉。

这一版把带钉的唤醒改成了定向投递。服务端只朝算出来的那个在线连接发一个 `deliver_turn`，由它那台机器那个目录把这个 turn 接走；其他连接收到广播，发现不是给自己的，直接忽略。带钉的 `mentioned`、`task_assigned`，还有「完成细化」触发的写提案唤醒，都走这条定向通道。实例离线就只通知、不唤醒，和前面硬钉的规则对上了。

还有一个不起眼但很要命的情况。一场对话在某个目录起的，跑着跑着那个目录的 daemon 掉线了，以前这场对话就死了，再也接不下去。现在只要这个 Agent 在别的目录还有实例在线，就能把这场对话挪过去接着跑，`sessionId` 不变，还是原来那场，只是换了个落脚的地方。

---

回到开头那个问题。同一个 Agent，两台机器三个仓库，活该往哪儿派？现在一个 daemon 就能把这几个目录全守上，你在想法上钉一次，底下的提案和任务自动落到对的目录，唤醒也精确叫醒被钉的那个，不再是谁抢到算谁的。Agent 不只是上线了，你还能瞄准它。

## 顺带修了几件事

- **评论区的 Agent @-mention 改成了带在线状态的徽章**：名字加一个在线绿点，点开是身份卡片（钉了实例的还显示目录和主机），owner 在 Agent 在线时还能一键跳进 daemon 聊天。
- **评论改成游标式的无限滚动**：首屏只加载最新一页，往下滚自动续更早的；实时新评论按 uuid 去重合并，不再整列表重刷，滚动位置和已加载的旧评论都不会被冲掉。
- **`chorus daemon` 现在能优雅退出**：之前 server 的信号处理函数抢在 daemon 的优雅停机前面，导致 daemon 没断干净就被强杀、留下假的在线状态；现在这些处理函数只在 server 启动时注册。
- **修了一批移动端和选择器的毛病**：实例选择器选不中第二个目录、派任务和想法的弹窗在矮屏手机上溢出、@-mention 的目录选择器在软键盘弹起时够不着底部按钮。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

起一个 daemon，把要守的几个目录列上：

```bash
chorus daemon --cwd ~/work/frontend --cwd ~/work/backend
```

daemon 目前只支持 Claude Code 作为本地的 Agent 后端，Codex 等其他 CLI 还在开发中。

这一版带四个 DDL 迁移（给 daemon 连接加目录列、新增 `AgentInstance` 表及外键、去掉任务上那两个临时的钉列），没有数据迁移，跑一次 `prisma migrate` 即可。

v0.12.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.12.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.12.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.12.0)
