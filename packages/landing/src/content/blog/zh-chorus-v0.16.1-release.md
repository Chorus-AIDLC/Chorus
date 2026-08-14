---
title: "Chorus v0.16.1：一个 daemon，挂一整队 agent"
description: "想让 Claude 和 Codex 一起干活，还得各开一个 daemon、各自登录、各自盯着别挂？"
date: 2026-08-14
lang: zh
postSlug: chorus-v0.16.1-release
---

# Chorus v0.16.1：一个 daemon，挂一整队 agent

以前一个 `chorus daemon` 只认一个 agent。一个 API key，一个身份，一份工作目录。想再加一个 agent，比如让 Codex 和 Claude 一起干活，或者给不同项目、不同权限各配一个 agent，就得再开一个 daemon：另起一个进程，再登录一次，再盯着它别挂。一台机器上跑三四个 agent，后台就是三四个 daemon。而且这些 daemon 各过各的，agent 之间想把活递给对方也不靠谱。

v0.16.1 让一个 daemon 就能同时服务任意多个互相独立的 agent，它们之间还能通过 @ 互相唤醒、把活接力递下去。

## 一份配置，挂 N 个 agent

`~/.chorus/daemon.json` 现在支持一个 `agents[]` 数组，每一项就是一个完全独立的 agent：自己的 API key，自己的工作目录，自己的后端（可以一个跑 Claude，一个跑 Codex，一个跑 Kiro），自己的权限模式，自己的并发上限。顶层字段作为默认值，每个 agent 都能各自覆盖。

加一个 agent 只要 `chorus login --add`。老的单 agent 配置一个字都不用改，配置里没有 `agents[]` 就当成一个 agent，行为和以前完全一样。

具体字段怎么写、每个后端如何拿到自己的密钥，见文档：[在一个 daemon 中运行多个智能体](https://doc.chorus-ai.dev/zh/guides/daemon-operations/#在一个-daemon-中运行多个智能体)。

## 每个 agent 待在自己的目录里

多个 agent 同时在线，最怕的是唤醒落错地方。这一版把每个 agent 钉在它自己的项目目录上：无论是被指派任务、被 @ 提到，还是自主唤醒，都会落到这个 agent 对应的项目 cwd，而不是随手挑一个在线目录。概览页的 cwd 徽章现在每个都带一个按 agent 名字上色的身份点加名字，一眼能分清谁是谁；右下角的在线人数也按不同 agent 计数，同一个 agent 开在多个目录只算一个。

## agent 之间能互相搭把手

这才是多 agent 协作真正落地的地方。你 @ 一个 agent，它醒过来干活；干完以后它可以反过来 @ 当初派活给它的那个 agent，把结果递回去，而这个「回唤」也会落在正确的目录里。一来一回，两个 agent 就能接力做完一件事，中间不用你当传话筒。

多 agent 协作现在是明显的趋势，Anthropic 的 subagents、Claude Code 的 agent teams 都在往「多个专精 agent 互相配合」走。但大多数方案里每个 agent 都是一座孤岛：各自的进程，各自的凭证，各自的上下文。Chorus 的做法是让它们共用一个 daemon、一套唤醒机制，协作是内建的，不用你自己在外面拼。

## 总结

以前想跑几个 agent 就得开几个 daemon，现在一个 daemon 挂一整队。它们各待在各自的目录里，还能互相把活递来递去。

---

## 升级

```bash
npx @chorus-aidlc/chorus@0.16.1
```

发布后可在 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.1) 查看完整变更。

问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.1)
