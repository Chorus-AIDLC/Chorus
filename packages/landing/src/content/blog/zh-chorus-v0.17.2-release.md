---
title: "Chorus v0.17.2：Pi 入队，Agent Profile 一键切"
description: "同一台机器挂着 Claude Code、Codex、Pi 和多套身份，启动前还要手动切环境变量吗？"
date: 2026-09-04
lang: zh
postSlug: chorus-v0.17.2-release
---

# Chorus v0.17.2：Pi 入队，Agent Profile 一键切

一台机器上接的 Agent 多了，麻烦往往出现在启动那一刻。

写代码的 profile 跑 Pi，review 的 profile 跑 Codex，另一个项目还留着 Claude Code。每套 profile 都有自己的 Chorus 身份和 API key。切一次 Agent，就要确认当前 shell 里是哪套环境变量、该启动哪个命令、会不会连错身份。daemon 明明已经记住了这些 profile，回到终端手动启动时却还得再配一遍。

v0.17.2 把这条链路接上了：Pi 现在可以作为正式发布、可远程唤醒的 Chorus Agent 使用，本地则可以用一条 `chorus agents run` 在多个 Agent profile 之间切换。

## Pi 不再是「能接上就算完」

Chorus 之前已经有 Pi 端，但安装和维护还偏向开发者流程。要处理本地路径、MCP adapter、subagent 依赖和 Agent 文件，真正放到日常环境里长期使用，步骤还是散的。

现在 [Pi 的 Chorus 第一方集成](https://doc.chorus-ai.dev/zh/reference/agents/pi/)作为独立 npm 包发布：

```bash
pi install npm:pi-mcp-adapter
pi install npm:@chorus-aidlc/chorus-pi
```

也可以交给 [chorus 命令行工具](https://doc.chorus-ai.dev/zh/reference/cli/)：

```bash
chorus agents add
```

选中 Pi 后，CLI 会安装 MCP adapter 和 `@chorus-aidlc/chorus-pi`，写入 Pi 的全局 MCP 配置，并把 API key 保留为环境变量引用，不把 `cho_` key 明文写进配置文件。

包里带了 12 个 Chorus skills、3 个只读 reviewer、1 个 worker，以及 Pi 官方模式的 `subagent` 工具。reviewer 和 worker 都从包内直接发现，不再需要手工复制 Agent 文件，也不依赖额外的第三方 subagent 包。

Pi 的 TypeScript extension 会接管 session 生命周期。worker 启动前，它创建 Chorus session，并把 session UUID 和 workflow 注入任务；worker 结束后，再自动关闭 session。主 Agent、worker 和 reviewer 在 Chorus 里看到的是同一条可追踪的工作链，不需要靠 skill 提醒模型手工补 session。完整的安装、验证、工具名前缀和 extension 行为都整理在 [Pi 接入文档](https://doc.chorus-ai.dev/zh/reference/agents/pi/)里。

## Pi 也能被 daemon 叫醒

装好插件只是交互式接入。要进入 Chorus 的反转对话，还得能在任务找上门时自动醒来。

v0.17.2 把 Pi 加进了 daemon 的可唤醒后端。工作目录、服务安装和模型提供方凭据的配置方式见[管理后台服务](https://doc.chorus-ai.dev/zh/guides/daemon-operations/)：

```bash
chorus daemon --agent pi
```

Idea 或 Task 被指派、Agent 被 `@mention`、Proposal 通过后，daemon 可以启动一个 headless Pi session，把对应的 Chorus URL、API key 和 profile 注入进去。Pi 收到的不是一段孤立 prompt，而是带着身份、任务和工作流上下文的一次正式接班。

这也意味着 Pi 不再只是 Chorus 支持列表里的一个交互端。它现在和 Claude Code、Codex、Kiro 一样，可以长期挂在本地，等工作主动来找它。

## 本地切 Agent，不再切一桌子环境变量

daemon 适合无人值守，但不少工作还是从终端里主动开始。以前 `~/.chorus/daemon.json` 已经保存了多个 Agent profile，手动启动 Agent 时却不能直接复用。一个 daemon 如何承载不同身份、后端和工作目录，可以在[多智能体后台服务配置](https://doc.chorus-ai.dev/zh/guides/daemon-operations/#在一个-daemon-中运行多个智能体)里查到。

现在可以直接用 [`chorus agents run`](https://doc.chorus-ai.dev/zh/reference/cli/#启动智能体chorus-agents-run)：

```bash
chorus agents run --name pi-work
chorus agents run --name codex-review -- resume
chorus agents run --name claude-main -- --model opus
```

`--name` 选择已经配置好的 Agent profile。Chorus 会读取它的身份、连接信息和 `agentType`，找到对应的 Pi、Codex、Claude Code、Kiro、OpenCode、OpenClaw 或 dsh 命令，再把 `CHORUS_URL`、`CHORUS_API_KEY` 和 `CHORUS_AGENT_PROFILE` 只注入这次启动的子进程。

当前 shell 不会被改写，API key 不会打印出来。`--` 后面的参数原样交给目标 Agent，所以原来的 model、resume 和其他启动参数都还能照常使用。

只有一个 profile 时，连 `--name` 都可以省掉：

```bash
chorus agents run
```

有多个 profile 又没有指定名字时，CLI 会直接报错，不会猜一个身份启动。切换的动作因此很短，但身份仍然是明确的。

## 一套 profile，两种启动方式

到这一版，本地 Agent 的配置和启动终于走到了一起：

1. 用 `chorus agents add` 安装插件并登记 profile。
2. 用 `chorus agents run --name <profile>` 在当前终端启动它。
3. 用 `chorus daemon` 让同一套 profile 在远程任务到来时自动醒来。

交互启动和后台唤醒复用同一份身份配置，不需要维护两套 API key，也不用每次打开新终端重新判断该 export 什么。

这一版还收拢了 Dashboard 的 [SSE 实时事件](https://doc.chorus-ai.dev/zh/reference/realtime/)连接，并修复了重连时 active-session 标记偶尔消失的问题。Pi 或其他 Agent 醒来后，Tracker 上的运行状态更稳定；在手机上点 active-session 标记，也能直接进入单个会话或从多个会话中选择。[在线智能体总览](https://doc.chorus-ai.dev/zh/guides/online-agents-overview/)集中说明了连接、工作目录、会话和中断恢复之间的关系。

以前的问题是 Agent 都配好了，真正要用时还得重新接线。v0.17.2 之后，Pi 可以正式留在队伍里等任务，本地切换 Agent profile 也只剩一条命令。

---

## 升级

```bash
npm install -g @chorus-aidlc/chorus@0.17.2
chorus agents add
```

启动已配置的 Agent：

```bash
chorus agents run --name <profile>
```

完整变更见 [GitHub Release v0.17.2](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.2)。问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。
