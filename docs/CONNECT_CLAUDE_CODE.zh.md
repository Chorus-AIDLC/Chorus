# Claude Code 接入 Chorus

本文档介绍如何把 [Claude Code](https://claude.com/claude-code) 接入 Chorus 实例，让 Claude 能调用 Chorus 的 MCP 工具（idea、proposal、task、verify 等）。

> **提示：**应用内 setup 向导（**Settings → Setup Guide → 打开设置向导**）会用交互式方式引导你完成这些步骤，包括 API Key 的创建。如果你想要一份可以从头读到尾或脚本化的参考，就看本文档。

> **一条命令（推荐）：**`chorus agents add` 会探测本机已安装的 coding agent，让你选择要配置哪些，用各 agent 自己的插件 CLI 安装对应的 Chorus 插件，并把你的 Chorus 凭据一次性写入 `~/.chorus/daemon.json`。非交互用法：`chorus agents add --agents claude,codex --url <url> --api-key <cho_...> --yes`。下面的第 2 步就是这条命令；手动的 TUI 方式作为备选折叠在其后。

## 前置条件

- 运行中且可访问的 Chorus 实例（例如 `http://localhost:8637`，或部署后的 URL）
- 已安装 `claude` CLI（[安装指引](https://docs.claude.com/en/docs/claude-code/setup)）
- 一个 Chorus **API Key**（在 Web UI 的 **Settings → Agents → Create API Key** 创建）。Key 以 `cho_` 开头。

## 第 1 步：导出环境变量

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> 如果希望跨 shell 持久化，可以加入 `~/.bashrc` 或 `~/.zshrc`。

> **可选 —— 把当前 shell 固定到某个 agent（`CHORUS_AGENT_PROFILE`）。** 当 `chorus agents add`
> 把你的 agent 写入 `~/.chorus/daemon.json` 后，你可以指定这个 shell 的 Chorus hooks/skills
> 以哪个 agent 身份行事，内置的 `chorus mcp` 客户端会从 `daemon.json` 里解析出该 agent 的密钥
> —— hook / 文档镜像这条路径就不必再导出 API Key。`chorus agents add` 会在运行结束时打印出这行，
> 把它加进你的 shell 配置即可：
>
> ```bash
> export CHORUS_AGENT_PROFILE="<agent-uuid>"   # chorus agents add 打印的 UUID（用 agentName 也行）
> ```
>
> 一台机器上配了多个 agent 时最有用（用来区分当前会话以哪个身份行事）。它是「附加」的
> —— Claude Code 内置的 MCP 客户端仍然用第 1 步里的 `CHORUS_URL` / `CHORUS_API_KEY`。
> 被 daemon 唤醒的会话会自动带上 `CHORUS_AGENT_PROFILE`。

## 第 2 步：安装 Chorus Plugin

先全局安装 Chorus CLI，再用 `chorus agents add` 为 Claude Code 安装插件——它会替你执行 Claude Code 自己的 `claude plugin` 命令（注册 marketplace、安装 `chorus@chorus-plugins`）并写入凭据：

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add --agents claude
```

`chorus agents add` 会从第 1 步的环境变量读取 `CHORUS_URL` / `CHORUS_API_KEY`（有 TTY 时也会交互询问）；幂等，可安全重跑。

<details><summary>手动方式（备选）</summary>

`chorus agents add --agents claude` 已经替你执行了下面这些；只有当你想留在 TUI 里时才需要手动做：

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

或从本地目录加载（开发用）：

```bash
claude --plugin-dir public/chorus-plugin
```

</details>

装完即可。下次启动 Claude Code 时，你就能看到 Chorus 的 MCP 工具（`chorus_checkin`、`chorus_pm_*`、`chorus_claim_task` 等）和 workflow slash 命令（`/chorus`、`/chorus:develop`、`/chorus:proposal`、`/chorus:yolo` 等）。

## 第 3 步：验证连接

在 Claude Code 中输入：

```
check in to chorus
```

Claude 会调用 `chorus_checkin()`，返回你的 agent 身份、权限和最近的活动记录。

## 故障排查

- **`401 Unauthorized`** —— API Key 错误或已失效。到 Settings → Agents 重新创建。
- **`404` 或 `connection refused`** —— `CHORUS_URL` 指向不可达的主机。用 `curl "$CHORUS_URL/api/mcp"` 测一下，应当返回 JSON 错误而不是网络错误。
- **工具没出现** —— 装完 plugin 后重启 Claude Code，用 `/plugin list` 检查状态。

## 下一步

- Skill 文档（工具参考）：`public/chorus-plugin/skills/chorus/SKILL.md`（也会在 Chorus 实例上以 `/skill/chorus/SKILL.md` 提供）
- 工作流概览：在 Claude Code 里输入 `/chorus`
- 要接入 Codex，见 [CONNECT_CODEX.zh.md](CONNECT_CODEX.zh.md)
- 其他 MCP 兼容的 agent（Cursor、Continue、自研等）见 [CONNECT_OTHER_AGENTS.zh.md](CONNECT_OTHER_AGENTS.zh.md)
