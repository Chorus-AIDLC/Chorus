# 其他 AI Agent 接入 Chorus

对于 **Claude Code 和 Codex 之外** 的 agent —— 任意 MCP 兼容客户端，例如 Cursor、Continue、自研 agent 或手写集成 —— 最快的路径是把 Chorus 的 URL 和 API Key 喂给 agent 本身，用自然语言 prompt 让它自己完成安装和配置。你把指引文档地址告诉它，剩下的它搞定。

> Claude Code 见 [CONNECT_CLAUDE_CODE.zh.md](CONNECT_CLAUDE_CODE.zh.md)；Codex 见 [CONNECT_CODEX.zh.md](CONNECT_CODEX.zh.md)。这两个客户端都有官方 plugin，除了 MCP 工具本身，还能用上 hooks、skills、slash 命令等。

## 前置条件

- 运行中且可访问的 Chorus 实例（例如 `http://localhost:8637`，或部署后的 URL）
- 一个支持 MCP server 的 AI agent（HTTP streamable transport 或同等方式）
- 一个 Chorus **API Key**（在 Web UI 的 **Settings → Agents → Create API Key** 创建）。Key 以 `cho_` 开头。

## 安装 prompt

复制下面这段 prompt 发给你的 agent。记得先把 `CHORUS_URL` 和 `API_KEY` 换成你的真实值。

```text
Please install and configure the Chorus AI-DLC collaboration platform.

Chorus URL: http://localhost:8637
API Key: cho_your_api_key

Read the setup instructions from:
http://localhost:8637/skill/chorus/SKILL.md

Follow the "Setup" section to configure the MCP server,
then call chorus_checkin() to verify the connection.
```

Web UI 的 setup 向导（**Settings → Setup Guide → 打开设置向导 → 其他智能体** tab）会把这段 prompt 用你当前的 `CHORUS_URL` 和 API Key 预填好渲染出来 —— 直接复制即可，不用手改。

## Agent 会做什么

`/skill/chorus/SKILL.md` 这份 skill 文档描述了怎么把 Chorus 注册为 MCP server，具体机制因客户端而异：

- **Cursor / Continue / Zed**：在它们的 `mcpServers` 配置（JSON 或 settings UI）里加一条。
- **基于 `@modelcontextprotocol/sdk` 的自研 agent**：对 `CHORUS_URL/api/mcp` 打开 HTTP streamable transport，带上 `Authorization: Bearer <API_KEY>` header。
- **OpenAI Agents SDK / LangChain 等**：把 Chorus 作为 MCP 工具源接入，传同样的 URL + header。

所有方式最终都归到同样的两项配置：

| 字段 | 值 |
|------|----|
| MCP server URL | `{CHORUS_URL}/api/mcp` |
| Auth header | `Authorization: Bearer {API_KEY}` |

配好之后让 agent 调用 `chorus_checkin` —— 如果能返回你的 agent 身份和权限，就说明连上了。

## 验证

对 agent 说：

```text
check in to chorus
```

你应该能看到一份描述 agent、权限、最近 Chorus 活动的 JSON 响应。如果 agent 还能列出可用的 MCP 工具（例如 `chorus_pm_create_idea`、`chorus_claim_task`），那就是完全 OK 了。

## 故障排查

- **Agent 提示 "no MCP server named chorus"** —— 它没把配置写进去。让它告诉你它写到了哪个 MCP 配置文件，然后去确认一下那条记录确实在。
- **`401 Unauthorized`** —— API Key 错误或已失效。到 Settings → Agents 重新创建，再把新 Key 发给 agent。
- **`/api/mcp` 返回 `404`** —— URL 可能漏了 `/api/mcp`，或者指向了错误的 host。用 `curl -H "Authorization: Bearer $CHORUS_API_KEY" "$CHORUS_URL/api/mcp"` 测一下，应当返回 JSON 错误而不是网络错误。
- **Agent 调工具了，但没按 AI-DLC 工作流走** —— 把完整 skill 文档 `/skill/chorus/SKILL.md` 发给它；`Setup` 章节只是最小必要配置，`Idea`、`Proposal`、`Develop`、`Review` 这些章节描述了这些工具该怎么组合使用。

## 下一步

- Skill 参考：`http://localhost:8637/skill/chorus/SKILL.md`（由 Chorus 实例本身提供）
- 完整 MCP 工具参考：[MCP_TOOLS.md](MCP_TOOLS.md)
- 要接入 Claude Code，见 [CONNECT_CLAUDE_CODE.zh.md](CONNECT_CLAUDE_CODE.zh.md)
- 要接入 Codex，见 [CONNECT_CODEX.zh.md](CONNECT_CODEX.zh.md)
