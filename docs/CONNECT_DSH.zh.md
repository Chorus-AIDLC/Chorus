# 将 dsh 接入 Chorus

本文介绍如何通过公开 npm bundle `@chorus-aidlc/chorus-dsh` 将 DeepSeek
Harness（`dsh`）接入 Chorus。Chorus 不再提供托管的 dsh 安装脚本，也不会把
插件文件或凭证复制到 `$DSH_HOME`。

## 前置条件

- 一个可以访问的 Chorus 实例，例如 `http://localhost:8637`
- 可以直接运行的 DeepSeek Harness `0.1.0-rc.7`
- `PATH` 中可以找到 pnpm（dsh 的 plugin 命令会调用 pnpm 管理包）
- 在 **Settings -> Agents** 中创建的 Chorus agent API Key

## 交互式 profile

在启动 dsh 的 shell 中导出连接信息：

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

把 bundle 加入要使用的 profile（必须带 `-w`——dsh 的 profile 是一个 pnpm
workspace 根，不加 `-w` pnpm 会拒绝添加依赖）：

```bash
dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w
```

该 profile 的包状态由 dsh 管理。dsh 的 base/profile 安装会满足 bundle 声明的
四个 peer 插件：

- `@deepseek-ai/dsh-mcp-client`
- `@deepseek-ai/dsh-skill-filesystem`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-persona`

把凭证写到 dsh 工具能读到的地方：

```bash
CHORUS_URL="$CHORUS_URL" CHORUS_API_KEY="$CHORUS_API_KEY" \
  bash <(curl -fsSL "$CHORUS_URL/dsh-credentials.sh")
```

这会把 `CHORUS_URL` + `CHORUS_API_KEY` 写入 `$DSH_HOME/.env`（权限 0600），并保留
其他条目。dsh 会刻意把"凭据形状"的环境变量从工具子进程里擦掉，所以 OpenSpec
文档镜像 wrapper 无法从你的 shell 继承 key——它从 `$DSH_HOME/.env`（dsh 自己的
凭据兜底位）读取。该脚本只写凭证（不复制任何插件文件），未导出的值会交互式询问。

启动同一个 profile：

```bash
dsh --profile <name>
```

然后让它执行 `check in to chorus`。它应调用 `chorus_checkin`，并返回身份、
权限和当前任务。

## Bundle 内容

npm 包包含 Chorus lifecycle、inline persona 和 instructions、MCP 配置，以及
以下 14 个 skills：

`chorus`、`idea-chorus`、`proposal-chorus`、`develop-chorus`、`yolo-chorus`、
`review-chorus`、`quick-dev-chorus`、`brainstorm-chorus`、
`openspec-aware-chorus`、`orchestrate-chorus`、`docs-chorus`、
`proposal-reviewer-chorus`、`task-reviewer-chorus` 和
`code-reviewer-chorus`。

## Chorus daemon

**本版本暂不提供** dsh backend 的无人值守 daemon wake。dsh daemon backend 已暂时
下线，先发布插件；当前请按上文以交互方式使用 dsh。daemon 支持会在后续版本回归。

## 文件归属

- `dsh plugin` 创建的 profile 包状态归 dsh 管理。
- Chorus 不会在 `$DSH_HOME` 下写入 package、skill、preset、instruction 或凭证文件。

## 故障排查

- **找不到 `dsh` 或 `pnpm`**：安装两个前置工具并重新打开 shell。
- **找不到包**：检查 registry 访问和包名，再重新执行 `dsh plugin --profile <name> add`。
- **peer 解析失败**：把 profile 更新到兼容 rc.7 的 dsh 包。
- **认证失败**：在启动环境中导出可访问的 `CHORUS_URL` 和正确的 `cho_` key。
- **profile 更新后无法 check in**：重启该 dsh profile，使最终 composition 重新加载。

## 相关指南

- [接入 Codex](CONNECT_CODEX.zh.md)
- [接入 Kiro CLI](CONNECT_KIRO.md)
- [接入其他 MCP agent](CONNECT_OTHER_AGENTS.zh.md)
