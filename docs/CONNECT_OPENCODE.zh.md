# 连接 OpenCode 到 Chorus

本指南介绍如何通过社区维护的 [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus) 插件把 [OpenCode CLI](https://opencode.ai) 接入正在运行的 Chorus 实例。该插件通过 OpenCode 原生的插件机制注入 Chorus MCP 工具、reviewer hook，以及整套 Chorus skill 文档。

> **提示：** 应用内的 Setup Wizard（**设置 → Setup Guide → 打开 setup guide**）会以交互方式引导你完成同样的步骤，包含 API Key 创建。如果你更喜欢一篇可通读的参考文档或需要自动化，请使用本文。

## 前置条件

- Chorus 实例正在运行且可访问（例如 `http://localhost:8637` 或一个部署好的 URL）
- 已安装 `opencode` CLI（参考 [opencode.ai/docs](https://opencode.ai/docs/)）
- 一把 Chorus **API Key**（在 Web UI 的 **设置 → Agents → 创建 API Key** 里生成）。Key 以 `cho_` 开头。

## 第 1 步：设置环境变量

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> 建议把这两行加到 `~/.bashrc` 或 `~/.zshrc`，以便 OpenCode 启动时能读到。`opencode-chorus` 插件在初始化时会读取 `process.env.CHORUS_URL`（或 `CHORUS_BASE_URL`）和 `process.env.CHORUS_API_KEY`。
>
> **URL 格式说明：** `CHORUS_URL` 填 Chorus 实例的**根 URL**（例如 `https://chorus.example.com`），**不要带 `/api/mcp` 后缀**。插件内部会自动拼接 MCP 路径。

## 第 2 步：启用 Chorus 插件

运行一键安装脚本：

```bash
curl -fsSL "$CHORUS_URL/install-opencode.sh" | bash
```

脚本幂等，可安全重复执行。它会：

1. 检查 `opencode` 是否已安装（未安装则警告但仍会写配置）。
2. 幂等地把 `"opencode-chorus"` 加入 `~/.config/opencode/opencode.json` 的 `plugin` 数组，已有的 plugin 条目会保留。
3. 首次修改前备份原配置到 `opencode.json.chorus-bak`，并将文件权限设为 `600`。

**脚本不做的事：**

- **不会**写 `~/.bashrc` / `~/.zshrc`。你需要自己在启动 `opencode` 前 export 好 `CHORUS_URL` 和 `CHORUS_API_KEY`。
- **不会**下载 `opencode-chorus` 包。OpenCode 在你修改 `opencode.json` 后首次启动时，通过 Bun 从 npm 拉取该包（缓存路径是 `~/.cache/opencode/packages/opencode-chorus@latest/`）。

### 手动替代方案

如果你更愿意手工编辑配置，把下面内容加进 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chorus"]
}
```

注意：如果已经有 `plugin` 数组，把 `"opencode-chorus"` merge 进去，而不是替换整个数组。

## 第 3 步：验证连接

启动 OpenCode：

```bash
opencode
```

首次启动时 Bun 会从 npm 拉取 `opencode-chorus`（首次会多几秒钟）。然后告诉 agent：

```
check in to chorus
```

插件会通过 MCP client 调用 `chorus_checkin()`，agent 会报告你的身份、权限和最近的活动。Chorus 工作流 skills（`chorus`、`chorus-develop`、`chorus-proposal`、`chorus-review`、`chorus-yolo` 等）会自动注册到 OpenCode。

## 故障排除

- **插件未加载。** 清空包缓存后重启 OpenCode：
  ```bash
  rm -rf ~/.cache/opencode/packages/opencode-chorus@latest
  ```
  OpenCode 会在下次启动时从 npm 重新拉取最新版本。

- **环境变量未生效。** 确认启动 OpenCode 的 shell 里已经 export `CHORUS_URL` 和 `CHORUS_API_KEY`。在 shell 中 `env | grep CHORUS_` 验证一下。如有需要，先 `source ~/.zshrc` 再启动。

- **`check in` 无响应。** 核对 `CHORUS_API_KEY` 是否有错字或末尾多余的空格。如果插件仍加载失败，尝试升级 OpenCode（`opencode upgrade`）。`opencode-chorus` 依赖较新版本的 `@opencode-ai/plugin` SDK。

- **`401 Unauthorized`。** API Key 错误或已撤销。去 设置 → Agents 重新生成，更新 shell rc 里的 `CHORUS_API_KEY`，然后重启 OpenCode。

- **想回滚？** 安装脚本把你的原配置保存到了 `~/.config/opencode/opencode.json.chorus-bak`。恢复命令：
  ```bash
  mv ~/.config/opencode/opencode.json.chorus-bak ~/.config/opencode/opencode.json
  ```

## 高级：用配置文件代替 env

如果你不想动 shell rc，`opencode-chorus` 也支持从 `~/.config/opencode/chorus.json` 读配置：

```json
{
  "chorusUrl": "https://chorus.example.com",
  "apiKey": "cho_your_api_key"
}
```

两者同时存在时，env 优先。配置文件方式适合共享开发容器，或想把密钥从 `~/.zshrc` 里挪走的场景。记得 `chmod 600 ~/.config/opencode/chorus.json`，因为里面有你的 API Key。

## 下一步

- 工作流概览：在 OpenCode 中告诉 agent `load the chorus skill`
- 项目级安装：把同样的 `plugin` 数组写进项目根目录的 `./opencode.json`，OpenCode 会在全局配置之上叠加项目配置。
- 接入 Claude Code，请看 [CONNECT_CLAUDE_CODE.zh.md](CONNECT_CLAUDE_CODE.zh.md)
- 接入 Codex，请看 [CONNECT_CODEX.zh.md](CONNECT_CODEX.zh.md)
- 任何其他支持 MCP 的 agent（Cursor、Continue、自定义 agent 等），请看 [CONNECT_OTHER_AGENTS.zh.md](CONNECT_OTHER_AGENTS.zh.md)
