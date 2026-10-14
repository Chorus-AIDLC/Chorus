# 将 TRAE CLI 接入 Chorus

本文介绍如何将 [TRAE CLI](https://www.trae.ai/)（`traecli`）接入正在运行的 Chorus 实例。TRAE CLI 是 Codex 的分支，因此 Chorus 直接复用 **Codex 插件包**（`plugins/chorus`，通过 `.agents/plugins/marketplace.json` 发布），daemon 唤醒也复用 Codex App Server 传输方式。无需单独安装 TRAE 专用插件。

> **提示：** 应用内的 **Settings → Setup Guide → Open setup guide** 向导里有 **TRAE CLI** 标签页，命令与本文一致。如果你更想要一份可以从头读到尾或用于自动化的参考，请使用本文。

## 前置条件

- 一个正在运行且可访问的 Chorus 实例（例如 `http://localhost:8637` 或已部署的 URL）。
- 已安装 `traecli` 且位于 `PATH` 中。**最低测试版本：traecli 0.209.1**，更早的版本未经验证。可用 `traecli --version` 查看。
- TRAE CLI 已登录（`traecli login`，或首次启动 `traecli` 时完成登录）。Chorus 不负责 TRAE 的登录认证。
- 一个 Chorus **API Key**（在 Web UI 的 **Settings → Agents → Create API Key** 中创建），以 `cho_` 开头。

## 第 1 步：导出环境变量

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

无需持久化，第 2 步会把它们写入 `$TRAE_HOME/.env`。

## 第 2 步：运行 chorus agents add

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents trae
```

`chorus agents add` 从环境中读取 `CHORUS_URL` / `CHORUS_API_KEY`，是幂等的，可放心重复执行。所有 TRAE 路径都遵循 `TRAE_HOME`，未设置时回落到 `~/.trae`。它会：

1. 检查 `traecli` 是否已安装。
2. 通过 TRAE 自带的插件 CLI 注册 `chorus-plugins` marketplace（`traecli plugin marketplace add …`）。已注册时重复执行不会产生变化；再次运行时会升级 marketplace（`traecli plugin marketplace upgrade chorus-plugins`）。
3. 用 `traecli plugin install chorus@chorus-plugins --yes` 安装 **Codex 插件包**。插件会被复制到 `$TRAE_HOME/plugins/cache/chorus-plugins/chorus/<version>/`，并在 `$TRAE_HOME/traecli.toml` 中写入 `[marketplaces.chorus-plugins]` 和 `[plugins."chorus@chorus-plugins"] enabled = true`。修改前会先备份原 `traecli.toml`。
4. 将 Chorus 凭证一次性写入 `~/.chorus/daemon.json`（agent 类型为 `trae`）。
5. 将 `CHORUS_URL`、`CHORUS_API_KEY`、`CHORUS_AGENT_PROFILE` 写入 `$TRAE_HOME/.env`（权限 `0600`，保留其他条目）。traecli 启动时会把该文件加载进自身进程环境，所以插件 hooks、模型通过 shell 工具执行的 `chorus` 命令和原生 MCP 都能拿到身份，**无需手动 export**。
6. 在 `$TRAE_HOME/traecli.toml` 中写入**不含密钥**的 `[mcp_servers.chorus]` 配置块：

   ```toml
   [mcp_servers.chorus]
   url = "http://localhost:8637/api/mcp"
   bearer_token_env_var = "CHORUS_API_KEY"
   ```

   traecli 会把该环境变量（来自 `$TRAE_HOME/.env`）转换为 `Authorization: Bearer <key>` 请求头。密钥不会写入 `traecli.toml`。
7. 如果已有 TRAE App Server daemon 在运行，交互式运行时会先征求确认，再执行 `traecli app-server daemon restart`，让它加载新的环境。非交互运行、`--yes` 和 `CHORUS_DAEMON_HEADLESS=1` 都不会重启它。没有 daemon 在运行时，安装器也不会主动启动。与 Codex 不同，没有 daemon 运行时 `traecli app-server daemon version` 会以非零码退出，因此安装器会把重启标记为延后（"daemon state could not be determined"）。

非交互安装（CI、沙箱环境）：

```bash
chorus agents add --agents trae \
  --url https://chorus.example.com \
  --api-key cho_xxx --yes
```

### `.env` 优先于 shell 环境

与 Codex 一样，`$TRAE_HOME/.env` 中的值会**覆盖** shell 或父进程中导出的同名变量。这带来两点影响：

- 要切换身份，请重新运行 `chorus agents add --agents trae`（在 TTY 下修改已有 profile 前会先询问），或直接编辑 `$TRAE_HOME/.env`。单纯 export 另一个 `CHORUS_API_KEY` 不会生效。
- **Daemon：** 如果有多个 Chorus agent 使用 TRAE 后端，请为**每个 agent 配置独立的 `TRAE_HOME`**。否则共享的 `.env` 会覆盖 daemon 为每个 agent 导出的凭证，所有唤醒都会以同一个 agent 身份运行。详见 [DAEMON.md](DAEMON.md#per-backend-key-delivery-important)。

## 第 3 步：信任 Chorus hooks

插件自带 Chorus 生命周期 hooks：SessionStart 自动签到，以及在 `chorus_pm_submit_proposal`、`chorus_submit_for_verify`、`chorus_admin_verify_task` 之后提醒运行 reviewer 的 PostToolUse hooks。**traecli 只会运行已被信任的插件 hooks。** 打开 `traecli`，在 hook 信任审核中接受 `chorus@chorus-plugins` 的 hooks。信任之前这些 hooks 不会运行，既不会自动签到，也不会有 reviewer 提醒。插件更新改动了 hook 定义后需要再信任一次。（`--dangerously-bypass-hook-trust` 可在单次调用中跳过审核，不推荐使用。）

TRAE 与 Codex 运行同一套 hook 脚本。插件安装在 `$TRAE_HOME/plugins/` 下时，脚本会识别出 TRAE，并改用 TRAE 的措辞（"TRAE port" 标识，用 `Agent` 工具而不是 Codex 的 `spawn_agent` 启动子 agent）。skill 路由指向已安装插件自带的 skills（`$PLUGIN_ROOT/skills/<name>/SKILL.md`），PostToolUse hooks 也兼容 TRAE 以字符串编码的 `tool_response`。可设置 `CHORUS_HOOK_RUNTIME=trae` 或 `codex` 强制指定运行时。

## 第 4 步：可选的连接检查

这一步需要手动执行，会消耗模型额度。打开 `traecli` 并输入：

```
check in to chorus
```

TRAE 会通过 MCP 调用 `chorus_checkin()`，返回你的 agent 身份、权限和最近动态。Chorus 工作流 skills（`$chorus`、`$develop`、`$proposal`、`$yolo` 等）与 Codex 来自同一个插件。有一点不同：skills 中用 Codex 的 `spawn_agent` 工具描述子 agent，而 TRAE 的子 agent 工具是 **`Agent`**（另有 `Skill` 和 `SendMessage`）。

查看 MCP 服务器列表：`traecli mcp list`。

## Daemon 用法

让 Chorus 在任务分配、@提及和细化问题回答时自动唤醒 TRAE：

```bash
chorus daemon --agent trae
```

也可以在 `~/.chorus/daemon.json` 中写入 `{ "agent": "trae" }` 设为默认，或在 `agents[]` 的某一项中使用 `"agentType": "trae"`。每次唤醒都会启动一个独立的 `traecli app-server --listen stdio://` 进程，协议、线程恢复和权限模式映射都与 Codex 后端一致（见 [DAEMON.md](DAEMON.md#trae-cli-daemon)）。线程 ID 与 Codex 分开存放在 `~/.chorus/trae-sessions.json`。如需指定二进制文件，设置 `CHORUS_TRAE_PATH=/path/to/traecli`。

在前台启动并注入该 agent 的 Chorus 连接：`chorus agents run --name <agent> --type trae`。

## 故障排查

- **`traecli not found`**：安装 TRAE CLI 并确保 `traecli` 在 `PATH` 中，或设置 `CHORUS_TRAE_PATH`。
- **没有 Chorus 工具 / `401 Unauthorized`**：`$TRAE_HOME/.env` 缺少密钥、密钥已被吊销，或旧的 App Server daemon 仍在使用过期的环境。重新运行 `chorus agents add --agents trae` 并允许它重启 daemon（或在保存工作后自行运行 `traecli app-server daemon restart`）。
- **hooks 从不触发**：先信任 Chorus hooks（第 3 步），并确认 `$TRAE_HOME/traecli.toml` 中已启用 `chorus@chorus-plugins`。
- **daemon 唤醒时身份不对**：多个 TRAE agent 共用了一个 `TRAE_HOME`，请为每个 agent 配置独立目录（见上文）。
- **marketplace upgrade 提示 "is not configured as a Git marketplace"**：使用本地路径源（`CHORUS_MARKETPLACE_SOURCE_TRAE`）时这是正常现象。安装器会将其视为无操作，并重新安装插件。

## 更多

- Codex 接入指南（共用插件包）：[CONNECT_CODEX.zh.md](CONNECT_CODEX.zh.md)
- Daemon 参考：[DAEMON.md](DAEMON.md)
- 其他兼容 MCP 的 agent：[CONNECT_OTHER_AGENTS.zh.md](CONNECT_OTHER_AGENTS.zh.md)
