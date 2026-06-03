# Codex 接入 Chorus

本文档介绍如何把 [Codex CLI](https://github.com/openai/codex) 接入 Chorus 实例。Codex 有自己独立的 Chorus plugin（位于 `plugins/chorus`，通过 `.agents/plugins/marketplace.json` 发布），是和 Claude Code plugin 完全不同的一个包，支持的 skills 和功能也有差异。一键脚本会负责把它写进 Codex 的 `~/.codex/config.toml`。

> **提示：**应用内 setup 向导（**Settings → Setup Guide → 打开设置向导**）会用交互式方式引导你完成这些步骤，包括 API Key 的创建。如果你想要一份可以从头读到尾或脚本化的参考，就看本文档。

## 前置条件

- 运行中且可访问的 Chorus 实例（例如 `http://localhost:8637`，或部署后的 URL）
- 已安装 `codex` CLI（`npm i -g @openai/codex`）
- 一个 Chorus **API Key**（在 Web UI 的 **Settings → Agents → Create API Key** 创建）。Key 以 `cho_` 开头。

## 第 1 步：导出环境变量

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> 如果希望跨 shell 持久化，可以加入 `~/.bashrc` 或 `~/.zshrc`。

## 第 2 步：运行安装脚本

```bash
curl -fsSL "$CHORUS_URL/install-codex.sh" | bash
```

脚本是幂等的，重复运行是安全的。它会：

1. 检查 `codex` 是否已安装。
2. 注册 `chorus-plugins` marketplace（如果已注册则升级）。
3. 把 `[mcp_servers.chorus]` 和 `[plugins."chorus@chorus-plugins"]` 写入 `~/.codex/config.toml`（权限 `600`，原文件首次备份到 `config.toml.chorus-bak`）。
4. 用 `[features] hooks = true` 启用 Codex 生命周期 hook。Chorus hooks 随插件打包，插件安装并启用后由 Codex 自动加载。

如果没有设置 `CHORUS_URL` / `CHORUS_API_KEY`，脚本会在有 TTY 的情况下交互式地询问你。

## 第 3 步：验证连接

打开 Codex，输入：

```
check in to chorus
```

Codex 会通过 MCP 调用 `chorus_checkin()`，返回你的 agent 身份、权限和最近的活动记录。Chorus workflow skills（`$chorus`、`$develop`、`$proposal`、`$yolo` 等）也都可以直接使用。

## 非交互安装（CI / sandbox 环境）

只要两个环境变量都有值，脚本不依赖 TTY 也能正常跑完：

```bash
CHORUS_URL=https://chorus.example.com \
CHORUS_API_KEY=cho_xxx \
  bash <(curl -fsSL https://chorus.example.com/install-codex.sh)
```

## 故障排查

- **`codex not found in PATH`** —— 先装 Codex：`npm i -g @openai/codex`。
- **`check in` 返回 `401 Unauthorized`** —— API Key 错误或已失效。到 Settings → Agents 重新创建，然后重新跑安装脚本（或手改 `config.toml` 里的 `Authorization` 行）。
- **`URL must start with http:// or https://`** —— `CHORUS_URL` 缺了协议头，补上 `http://` 或 `https://`。
- **Marketplace source conflict** —— 你之前用不同 URL 注册过 `chorus-plugins`。脚本会检测到并自动重新注册，留意它打印的 `!` 警告。
- **Hook 在首次启动时没触发** —— 在 Codex 里打开 `/plugins`，确认 `chorus@chorus-plugins` 已安装并启用；再打开 `/hooks` review/trust Chorus 插件自带的 hooks。plugin cache 生成后，hook 会在后续工具调用时生效。

## 下一步

- Skill 文档（工具参考）：`plugins/chorus/skills/chorus/SKILL.md`（Chorus 实例上 `/skill/chorus/SKILL.md` 提供的是独立版本，来自 `public/skill/chorus/SKILL.md`）
- 工作流概览：在 Codex 里输入 `$chorus`
- 要接入 Claude Code，见 [CONNECT_CLAUDE_CODE.zh.md](CONNECT_CLAUDE_CODE.zh.md)
- 其他 MCP 兼容的 agent（Cursor、Continue、自研等）见 [CONNECT_OTHER_AGENTS.zh.md](CONNECT_OTHER_AGENTS.zh.md)
