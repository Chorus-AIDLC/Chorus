# Claude Code 接入 Chorus

本文档介绍如何把 [Claude Code](https://claude.com/claude-code) 接入 Chorus 实例，让 Claude 能调用 Chorus 的 MCP 工具（idea、proposal、task、verify 等）。

> **提示：**应用内 setup 向导（**Settings → Setup Guide → 打开设置向导**）会用交互式方式引导你完成这些步骤，包括 API Key 的创建。如果你想要一份可以从头读到尾或脚本化的参考，就看本文档。

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

## 第 2 步：安装 Chorus Plugin

推荐用官方 Chorus plugin —— 除了底层 MCP 连接，它还打包了 hooks、skills、session 自动管理。

**从 plugin marketplace 安装**（推荐）：

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

**从本地目录加载**（开发用）：

```bash
claude --plugin-dir public/chorus-plugin
```

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
