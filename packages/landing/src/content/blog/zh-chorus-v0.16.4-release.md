---
title: "Chorus v0.16.4：Hello DeepSeek Harness 🐳"
description: "DeepSeek 的 harness 几天前才发布，Chorus 这一版就正式支持了。"
date: 2026-08-19
lang: zh
postSlug: chorus-v0.16.4-release
---

# Chorus v0.16.4：Hello DeepSeek Harness 🐳

DeepSeek 几天前发布了自己的 agent harness，DeepSeek Harness（dsh），开源、MIT。从 v0.16.4 起，Chorus 正式支持它。dsh 成了 Chorus 的第六个 agent 端，和 Claude Code、Codex、Kiro、Pi、OpenClaw 排在一起，走同一套 idea → proposal → 执行 → 验收的流程。

先说句抱歉：这一版还没赶上 dsh 的 daemon 模式。被指派任务后自动醒来干活那套，现在还用不了，只能交互式地开着 dsh 跟它对话往下推。daemon 支持会在后面的版本补上。

## 一条命令，把 dsh 变成 Chorus 的一员

dsh 用的是 Cordis 那套「什么都是插件」的机制，所以接入方式跟别的 agent 不太一样，不是拷一堆文件，而是装一个包。我们发了一个公开的 npm bundle `@chorus-aidlc/chorus-dsh`，把它加进你要用的 dsh profile：

```bash
dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w
```

这一个包里带齐了全套东西：Chorus 的 14 个 skill、内置的 persona 和 instructions、还有 MCP 配置。装完写一次凭证，启动这个 profile，让它 `check in to chorus`，它就会像任何一个 Chorus agent 一样，报出自己的身份、权限和手头的任务。

## 进来之后，它就是个普通 agent

接进来的 dsh 没有任何特殊待遇。同一套流程它一步都不少：认领 idea、跑 elaboration、提 proposal、被 reviewer 挡在门口、改完再来。你在 Chorus 这边看到的还是那套「AI 提议，人来验收」的反转对话，只是底下换成 DeepSeek 在跑。你完全可以让 Claude Code 写方案，让一个 DeepSeek agent 去啃其中几个任务，它们在同一条流水线上，过同一道验收门。

---

## 升级

```bash
npx @chorus-aidlc/chorus@0.16.4
```

发布后可在 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.4) 查看完整变更。

问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.4](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.4)
