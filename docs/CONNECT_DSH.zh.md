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

用 `chorus agents add` 写入 Chorus 凭证：

```bash
chorus agents add --agents dsh --dsh-profile <name>
```

`chorus agents add` 会校验你的 key，并把 `CHORUS_URL` + `CHORUS_API_KEY` 写入
`~/.chorus/daemon.json`（权限 0600），如有需要还会把 `@chorus-aidlc/chorus-dsh`
bundle 加入该 profile。它会从上面的 shell 环境读取这些值，缺失的值在有 TTY 时
交互式询问。还没安装 `chorus` CLI？先用 `npm install -g @chorus-aidlc/chorus@0.17.0` 全局安装，再运行 `chorus agents add --agents dsh --dsh-profile <name>`。

对于 `dsh` agent，`chorus agents add` 还会把 `CHORUS_URL`、`CHORUS_API_KEY` 和
`CHORUS_AGENT_PROFILE`（该 agent 的 UUID）写入 `$DSH_HOME/.env`（默认 `~/.dsh/.env`，
权限 0600，保留无关行）。这是 dsh 自己的凭证通道：dsh 会从工具子进程里剥离凭证形态的
变量，所以文档镜像 wrapper 无法从 shell 读到 URL/key——`chorus` CLI 不在 `PATH` 时
（例如用 `npx` 而非全局安装运行 `chorus agents add`），wrapper 会从 `$DSH_HOME/.env`
读取 `CHORUS_URL` / `CHORUS_API_KEY`。`CHORUS_AGENT_PROFILE` 不是密钥、不会被剥离：
dsh 会把 `$DSH_HOME/.env` 加载进会话，profile 直接出现在环境变量里。它指明这个 profile
以哪个 agent 身份行事——在配置了多个 agent 的机器上，wrapper 会据此确定地以该 agent
身份行事（委托 `chorus mcp call --agent <profile>`，从 `~/.chorus/daemon.json` 解析出
key）。因为已经持久化在这里，dsh **不需要**你再手动 `export CHORUS_AGENT_PROFILE`（其他
没有 `.env` 通道的 agent 仍会从 `chorus agents add` 得到这条 export 提示）。

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
- Chorus 不会在 `$DSH_HOME` 下写入 package、skill、preset 或 instruction 文件。唯一的例外是凭证/身份：`chorus agents add` 会写入 `$DSH_HOME/.env`（`CHORUS_URL` + `CHORUS_API_KEY` + `CHORUS_AGENT_PROFILE`，权限 0600，保留无关行）——这是 dsh 认可的通道，`chorus` CLI 不可用时由文档镜像 wrapper 读取。

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
