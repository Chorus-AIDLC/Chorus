---
title: "Chorus v0.22.0: Hermes 也能加入项目了"
description: "日常用 Hermes，项目协作在 Chorus，需要换一个 Agent 吗？这次让 Hermes 通过自己的 gateway 接进来。"
date: 2026-10-07
lang: zh
postSlug: chorus-v0.22.0-release
---

# Chorus v0.22.0: Hermes 也能加入项目了

日常在 Hermes 里写代码，团队却在 Chorus 里分配任务、讨论需求、审查提案。没有直接接入时，两边的上下文需要手动搬运，或者换一个已经支持的 Agent 来执行。

Chorus v0.22.0 新增 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 接入，让 Hermes 也能参与这套项目协作流程。

## 同样的工作流，通过 Hermes gateway 运行

Chorus 原本就能通过 daemon 唤醒 Codex 等 Agent。Hermes 接入沿用的是同一套协作流程，不是重新设计一套任务系统。

区别在于运行方式：Hermes 自带常驻 gateway，Chorus 插件直接在其中注册一个 `chorus` 平台，通过它接收唤醒和运行对话，**不需要另起 Chorus daemon**。

gateway 连接成功后，Hermes 会在 Chorus 中显示在线。给它分配工作、在评论中 @它，或完成提案审批、任务验收，都可以触发后续处理。Hermes 通过 MCP 读取项目资料、更新任务和提交结果，执行状态与对话记录则回传 Chorus。

同一 Idea 的工作在对应的 gateway 会话里衔接。执行期间收到的新唤醒会排队，等当前轮次结束后再处理。

## 在 Chorus 里协作，在 Hermes 里执行

插件提供适配 Hermes 的 Chorus 技能，覆盖需求澄清、提案、开发和审查等阶段。Hermes 按需加载这些技能，用自己的工具执行工作；需要委派子任务时，使用原生的 `delegate_task`。带 Chorus 审查标记的子任务受到只读限制，可以检查资料、发表结论，不能修改代码或批准提案。

需要人工审批的命令也可以回到 Chorus 处理：插件在当前工作对应的实体下发评论，@Agent 的 owner，owner 按提示回复批准或拒绝。要让被标记的命令交给人决定，需要启用 `manual` 审批模式；安装器会在该配置尚未设置时补上，已有配置则保持不变。

工作入口仍然是 Chorus，具体执行交给 Hermes，不必为了参与项目换掉日常使用的 Agent。

## 接入方式

### 使用 Chorus CLI

先安装 Hermes，准备好 Chorus 实例地址和 Agent API Key，再从要服务的仓库目录运行：

```bash
npm install -g @chorus-aidlc/chorus@0.22.0
cd /path/to/your/repo
chorus agents add --agents hermes
```

安装器会安装与 CLI 发布版本对应的原生插件和 MCP 包，配置连接凭证，并补齐尚未设置的工作目录与审批选项。随后启动 Hermes gateway：

```bash
hermes gateway install
hermes gateway start
```

### 不安装 Chorus CLI，直接安装插件

也可以只用 Hermes CLI 和 Git 安装，不需要 npm 或 Chorus CLI。需要安装两个包：`chorus` 提供技能、gateway 和审批通道，`chorus-mcp` 提供 MCP 工具连接。

Hermes 的 `--ref` 要求完整的 commit SHA，不能直接传版本号。先将发布 tag 解析成 SHA，再安装两个包：

```bash
(
  set -e
  VERSION=0.22.0
  REPO=https://github.com/Chorus-AIDLC/Chorus.git
  SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
  [ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
  [ -n "$SHA" ] || { echo "找不到发布 tag v$VERSION，停止安装" >&2; exit 1; }

  hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus --ref "$SHA" --enable
  hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "$SHA" --enable
)
```

这组命令需要在 `v0.22.0` 发布后运行。之后手动升级时，修改 `VERSION`，并为两个安装命令加上 `--force`，即可替换已有插件。

### 手动配置插件

通过 Chorus CLI 安装时，以下配置会自动补齐；直接安装插件则需要自己设置。默认配置目录为 `~/.hermes`，使用自定义 `HERMES_HOME` 或 profile 时，请修改对应目录下的文件。

先在 Chorus 的 **Settings → Agents** 中创建 Agent API Key，再将以下两项加入该 Hermes 配置目录的 `.env`，保留文件里的其他配置：

```dotenv
CHORUS_URL=https://chorus.example.com
CHORUS_API_KEY=cho_your_api_key
```

将地址和 Key 换成实际值，并用 `chmod 600 ~/.hermes/.env` 限制文件权限。后台 gateway 不会继承当前终端的环境变量，所以不能只在终端里 `export`。两项都设置后，Chorus 平台会自动启用。

如果 Chorus 就运行在 `http://localhost:8637`，MCP 包内置的地址可以直接使用。其他地址还需要配置 MCP 连接，下面的 URL 应与 `.env` 中的实例地址对应：

```bash
hermes config set mcp_servers.chorus.url 'https://chorus.example.com/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

保留第二条命令的单引号，让配置中保存的是变量占位符，而不是明文 Key。原生 MCP 配置会覆盖插件内置的本地地址，日志提示跳过同名 portable MCP 配置是正常现象。

然后设置仓库的绝对路径，以及通过 Chorus 评论进行人工审批：

```bash
hermes config set terminal.cwd /path/to/your/repo
hermes config set security.approval.transport chorus
hermes config set security.approval.transport_fallback builtin
hermes config set approvals.mode manual
hermes config set approvals.timeout 300
```

`builtin` 回退让 Hermes CLI/TUI 仍能显示本地审批提示；`manual` 将被标记的命令交给人审批，300 秒内没有有效答复则拒绝。

首次使用时运行 `hermes gateway install` 和 `hermes gateway start`；已经运行的 gateway 在修改配置后执行 `hermes gateway restart`。用 `hermes gateway status` 检查服务，并在 Chorus 中确认 Agent 显示在线、客户端为 Hermes。

一个 gateway 服务一个仓库，多个仓库需要分别配置 profile 和 gateway。目前 Hermes gateway 暂不执行 Tracker 发起的 Research 和创建 Idea 操作轮次。

详细配置与排障步骤见 [Hermes 接入指南](https://github.com/Chorus-AIDLC/Chorus/blob/main/docs/CONNECT_HERMES.zh.md)。

这次增加的是一个新的 Agent 选择。已经在用 Hermes 的团队，现在可以把它接进 Chorus，沿用同样的任务、审批和审查流程。

## 升级说明

自托管部署应先更新 Chorus 服务端并执行数据库迁移。更新 CLI 和已配置的 daemon 插件：

```bash
npm install -g @chorus-aidlc/chorus@0.22.0
chorus upgrade --plugins
chorus daemon restart
```

`--plugins` 刷新默认 daemon 配置中登记的 Claude Code、Codex、Kiro 和 Pi 集成，Agent CLI 需单独升级。Kiro 模板由 Chorus 服务提供，因此使用 Kiro 时应先更新服务端。

Hermes 不使用 Chorus daemon，也不在 `--plugins` 的更新范围内。已有 Hermes 接入可在升级 Chorus CLI 后重新安装插件，确认重装，再重启 gateway：

```bash
chorus agents add --agents hermes
hermes gateway restart
```

不使用 Chorus CLI 的用户，按前面的手动安装步骤更新两个插件后，同样执行 `hermes gateway restart`。

仅使用 Hermes 时，无需运行 `chorus upgrade --plugins` 或 `chorus daemon restart`。七个插件与四个 npm 发布包统一使用 **0.22.0** 版本号。
