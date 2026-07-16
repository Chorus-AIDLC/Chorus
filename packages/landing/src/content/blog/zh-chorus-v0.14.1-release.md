---
title: "Chorus v0.14.1: 接入 Amazon Kiro CLI"
description: "你的团队换到了 Kiro，协作平台却只认得 Claude Code 和 Codex。这一版把它补上了。"
date: 2026-07-16
lang: zh
postSlug: chorus-v0.14.1-release
---

# Chorus v0.14.1: 接入 Amazon Kiro CLI

v0.14.1 把 [Chorus](https://github.com/Chorus-AIDLC/Chorus) 的接入方式扩到第四种：Amazon Kiro。此前它只支持 Claude Code、Codex 和 OpenClaw，AI-DLC 那套从想法到提案再到执行的流程，到不了 Kiro 用户的终端里。Kiro 既能作为插件在本地交互使用，也能作为 daemon 后端在收到远程派发时以无头方式驱动。本次适配针对 Kiro CLI v2；v3 改动了信任模型、hooks 与 agent 格式，且尚存无头执行的缺口，将作为单独一版处理。

## 插件：一条命令完成安装

Kiro 与前几种不同。它不使用打包好的插件，而是读取 `~/.kiro/` 下松散的 `agents / skills / steering / settings` 文件。因此 Chorus 这次交付的是一套模板，由安装脚本合并进你的 Kiro 配置目录：

```bash
export CHORUS_URL="https://your-chorus-instance"
export CHORUS_API_KEY="cho_..."
curl -fsSL "$CHORUS_URL/install-kiro.sh" | bash
```

脚本是幂等的，可以重复执行。安装完成后，Kiro 会新增：

- Chorus 远程 MCP server；
- 八个 `chorus-*` 工作流技能（`/chorus-idea`、`/chorus-proposal`、`/chorus-develop`、`/chorus-yolo` 等）；
- 一个 `chorus` 主 agent，预载这些技能与 Chorus 的背景说明，能派生只读的 reviewer 子 agent，并自动管理会话生命周期；
- 三个只读的 reviewer 子 agent。

默认安装到全局 `~/.kiro/`，一次安装在任何目录下都生效；也可以加 `--workspace` 安装到项目本地的 `<cwd>/.kiro/`，用于按项目隔离配置。API Key 通过环境变量 `${env:CHORUS_API_KEY}` 在运行时插值，不写入磁盘。

装完后在 Kiro 里输入 `/chorus-idea`，或用 `kiro-cli --agent chorus` 启动带完整会话钩子的主 agent，让它执行一次 check in，即可确认连接成功。

## daemon 后端：远程派发，本地无头执行

插件解决的是你坐在 Kiro 前主动开发的场景。另一半是 Chorus 的 daemon 模型：把一台机器变成常驻的 agent 运行时，在收到远程派发的任务时，于本地唤醒一个 agent 完成它。

这一版为 daemon 加入了 `--agent kiro` 后端，唤醒、恢复、打断、抓取对话记录整套都已打通。也就是说，你在 Chorus 网页端把一条想法派发给某台装有 Kiro 的机器，它会在本地以无头方式启动 Kiro 接手，你在网页上就能看它执行、随时打断。至此，daemon 支持 Claude Code、Codex、Kiro 三种后端。

## daemon 的其它改进

除 Kiro 外，daemon 本身也修复了几处问题：

- **唤醒前先指定工作目录**：以前唤醒一个挂在 daemon 上的 agent，会默认落到第一个 daemon，未必是你期望的那台机器、那个目录。现在唤醒时会先弹出工作目录选择框，把 assignee pin 到带 cwd 的具体实例；该 pin 为硬性绑定，`@mention` 也会继承想法上已有的 pin。
- **切换工作目录或 agent 不再另起对话**：以前给一条想法更换工作目录或更换 agent，残留对话会分叉出去，导致打断按钮无法触达。现在会把原对话重新指过去，在任何线程里都能发起打断。
- **子想法唤醒锚定到子对话**：以前唤醒子想法会点亮父对话，批准备注也会丢失。现在唤醒锚定到子想法自身的对话，备注随消息一起送达。
- **`chorus daemon install` 保住凭证**：systemd 的 `--user` 服务运行在干净环境里，会把 `CHORUS_URL` / `CHORUS_API_KEY` 剥掉，导致开机自启的 daemon 无法连接。现在安装时会将凭证持久化进 `daemon.json` 并做校验，同时提供一个交互式的多 cwd 配置向导。

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

v0.14.1 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.1) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？欢迎前往 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.14.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.1)
