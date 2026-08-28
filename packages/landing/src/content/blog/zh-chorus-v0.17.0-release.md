---
title: "Chorus v0.17.0：接入 Agent，先跑这一条命令"
description: "每个 Agent 都有自己的插件和配置，为什么还得一套套记？"
date: 2026-08-28
lang: zh
postSlug: chorus-v0.17.0-release
---

# Chorus v0.17.0：接入 Agent，先跑这一条命令

机器上原本只有 Claude Code，现在想把 Codex 也接进 Chorus。插件从哪里装，API key 写进 `.env` 还是 MCP 配置，交互会话和 daemon 唤醒时用的是不是同一个身份，都得重新查一遍。再换成 Kiro 或 dsh，又是另一套办法。

v0.17.0 主要就在解决这件事。[新版 `chorus` CLI](https://doc.chorus-ai.dev/zh/reference/cli/) 接手了 Agent 的安装和连接配置，入口只有一个：

```bash
chorus agents add
```

## 跟着 CLI 配一次

先全局安装新版 CLI：

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
```

运行 `chorus agents add` 后，CLI 会找出本机已有的 Claude Code、Codex、Kiro、OpenCode、OpenClaw、Pi 和 dsh。它们的维护方式和远程运行能力并不完全相同，区别可以在[智能体平台对比](https://doc.chorus-ai.dev/zh/reference/agents/)里查。选中要接入的 Agent，再逐个填入对应的 [Chorus API key](https://doc.chorus-ai.dev/zh/guides/manage-agents/)。

接下来的事情按 Agent 分开处理。Claude Code 走自己的插件市场，Codex 走自己的 plugin 命令，Kiro 写入 `.kiro/` 模板，dsh 安装 npm plugin。能自动安装的由 CLI 完成；Pi 这类还没有可靠自动安装通道的，会显示手工步骤。

Claude Code、Codex 和 Kiro 所需的身份或 MCP 配置也会一并写好，其他 Agent 的剩余步骤按终端提示完成。[Claude Code](https://doc.chorus-ai.dev/zh/reference/agents/claude-code/) 使用用户级 `~/.claude/settings.json`，[Codex](https://doc.chorus-ai.dev/zh/reference/agents/codex/) 把凭据放进 `~/.codex/.env`，再在 `config.toml` 里写一个不含密钥的 MCP 引用。写入成功后，交互式启动 Claude Code 或 Codex 不用再提前 export 那几个 `CHORUS_*` 变量。

这条命令可以安全重跑。插件已经存在时会跳过，部分缺失配置会补上；换 API key 时也还是从这里进。它不会替已安装的插件做通用版本升级。

## daemon 也在这一步选

Claude Code、Codex 和 Kiro 可以在配置时接入本地 daemon。远程唤醒默认关闭，需要逐个 Agent 打开。

如果要让 daemon 随用户会话启动，Linux 会安装 systemd 用户服务，macOS 会安装 LaunchAgent。只想保留一个身份给 CLI 调用，不希望 Chorus 主动唤醒它，也可以不开这个选项。工作目录、前台测试和服务管理命令见[后台服务运维](https://doc.chorus-ai.dev/zh/guides/daemon-operations/)。

## 配完之后，CLI 还能直接调 MCP

这一版还加了原生 MCP 客户端。以前脚本里要套 `curl`、`jq` 或插件自己的包装脚本，现在可以直接调用：

```bash
chorus mcp call chorus_get_task '{"taskUuid":"..."}'
```

`chorus mcp list` 可以看当前身份有哪些工具，`chorus mcp whoami` 返回 Agent UUID。机器上配了多个 Agent 时，用 `--agent <name-or-uuid>` 指定身份。各类工具和权限要求可以继续查 [MCP 工具目录](https://doc.chorus-ai.dev/zh/reference/mcp-tools/)。

本机保存了哪些身份，也不用再打开 `daemon.json` 查：

```bash
chorus agents
```

列表会显示 Agent 的名称、UUID 和后端，并标出关闭了远程唤醒的身份；`--json` 可以查看完整的 `daemonWake` 字段。API key 不会出现在输出里。`chorus agents remove <name-or-uuid>` 可以移除 `daemon.json` 里的身份记录；插件和 Agent 自己的凭据文件仍按命令提示手工清理。

## 还有几项修复

`chorus_checkin` 现在只返回最近活跃的最多 10 个项目和各自的活跃 Idea 数量；完整逐条 Idea 列表和任务 tracker 仍通过 `chorus_get_my_assignments` 按需读取。Codex 插件也换掉了过时的子 Agent 调用方式；嵌套主题则改成从最深层开始汇总状态。

这版之后，接入一个 Agent 不必先判断该找哪份安装脚本。先运行 `chorus agents add`，CLI 能处理的会直接处理，剩下的会直接给出手工操作步骤。

---

## 升级

升级 Chorus：

```bash
npx @chorus-aidlc/chorus@0.17.0
```

安装新版 CLI 并配置 Agent：

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add
```

完整变更见 [GitHub Release v0.17.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.0)。问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。
