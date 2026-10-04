# Codex 接入 Chorus

本文档介绍如何把 [Codex CLI](https://github.com/openai/codex) 接入 Chorus 实例。Codex 有自己独立的 Chorus plugin（位于 `plugins/chorus`，通过 `.agents/plugins/marketplace.json` 发布），是和 Claude Code plugin 完全不同的一个包，支持的 skills 和功能也有差异。`chorus agents add` 会把它写进 Codex 的 `~/.codex/config.toml`。

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

## 第 2 步：运行 chorus agents add

```bash
chorus agents add --agents codex
```

`chorus agents add` 会从环境变量（第 1 步）读取 `CHORUS_URL` / `CHORUS_API_KEY`。它是幂等的，重复运行是安全的。它会：

1. 检查 `codex` 是否已安装。
2. 注册 `chorus-plugins` marketplace（如果已注册则升级）。
3. 通过 Codex 自己的 plugin CLI 安装 Chorus 插件，把 `[plugins."chorus@chorus-plugins"]` 写入 `~/.codex/config.toml`（原文件首次备份），并启用 Codex 生命周期 hook。Chorus hooks 随插件打包，插件安装后由 Codex 自动加载。
4. 把你的 Chorus 凭证一次性写入 `~/.chorus/daemon.json`。
5. 把 `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` 写入 `~/.codex/.env`（`0600`、幂等、保留你的其它条目）。Codex 启动时会把这个 dotenv 文件加载进**自己的进程环境**，因此它的插件 hook 和模型在 shell 工具里调用 `chorus` 都能解析出你的 agent 身份，**无需手动 export**。
6. 把原生 MCP 服务块 `[mcp_servers.chorus]` 写入 `~/.codex/config.toml`，使用 `url` + `bearer_token_env_var = "CHORUS_API_KEY"`——一个**不含密钥**的引用（`config.toml` 里不存任何 API key）。Codex 连接 MCP 时会从第 5 步的 `~/.codex/.env` 解析该环境变量，生成 `Authorization: Bearer <key>` 头。
7. 凭据和 MCP 配置成功写入后，按下文处理已经运行的 **Codex App Server**。它不是 Chorus daemon；仅更新插件的 plugin-only 流程不进入此重启步骤。

如果环境里没有 `CHORUS_URL` / `CHORUS_API_KEY`，`chorus agents add` 会在有 TTY 时交互式询问。还没安装 `chorus` CLI？先用 `npm install -g @chorus-aidlc/chorus` 全局安装，再运行 `chorus agents add --agents codex`。

### 哪些无需手动 export

使用更新配置启动的 Codex 进程可从 `~/.codex/.env` 加载托管凭据，无需手动 export。但写文件**不会刷新已有 App Server 的环境**，也不能单独证明连接成功。凭据供以下层面使用：

- **插件生命周期 hook**（SessionStart 的 check-in、PostToolUse 自动化）—— Codex 把自己的进程环境（由 `~/.codex/.env` 填充）快照进每个 hook 子进程，所以 check-in 无需你在 shell 里 export 任何东西即可触发。
- **模型自己在 shell 里调用 `chorus`**（即 skill CLI）—— 从同一份进程环境解析。解析顺序优先 `CHORUS_AGENT_PROFILE` + `chorus` CLI（≥ 0.17.0，密钥从 `~/.chorus/daemon.json` 读取），CLI 缺失时回退到 `CHORUS_URL` + `CHORUS_API_KEY`。
- **原生 MCP 工具** —— `[mcp_servers.chorus]` 用 `bearer_token_env_var = "CHORUS_API_KEY"`，Codex 连接时从同一进程环境解析出该变量，生成 `Authorization: Bearer <key>`。密钥从不写进 `config.toml`（Codex 不会展开 `http_headers` 里的 `${VAR}`，所以用的是专门的 `bearer_token_env_var` 字段）。

> 重新运行 `chorus agents add` 可刷新持久化凭据。Codex 使用 `~/.codex/.env`，Chorus CLI 也在 `~/.chorus/daemon.json` 保存 agent 凭据。被 Chorus daemon 唤醒的 Codex 进程会收到三个变量；第 1 步的 export 仍适用于安装器和终端 CLI，已运行进程的环境则需要另行刷新。

### 安全重启已有 App Server

本文所有 Codex 路径遵循 `CODEX_HOME`，未设置时使用 `$HOME/.codex`。配置成功后，安装器用有超时限制的只读命令检测重启能力及后台状态。支持的版本通过 `codex app-server daemon version` 返回 JSON 状态；不要假设存在 `daemon status` 子命令。

- **交互终端**：仅对明确运行且支持重启的后台询问一次 `[y/N]`，先说明可能中断其他会话，只有明确输入 `y` 或 `yes` 才重启。子进程使用刚持久化的 `CHORUS_URL`、`CHORUS_API_KEY`、`CHORUS_AGENT_PROFILE`，覆盖父进程中的旧值；密钥不进入命令参数或诊断日志。
- **非交互、`--yes` 或 `CHORUS_DAEMON_HEADLESS=1`**：不弹重启问题、不自动重启。通用 `--yes` 不代表授权中断会话，汇总明确显示待处理事项。
- **无后台**：不自动启动。**命令不支持或状态未知**：不猜测重启、不自动升级 Codex。**配置失败或拒绝身份覆盖**：不带着不匹配凭据重启。**重启失败**：保留已写配置，按指引在安全时手动恢复。

新增步骤只报告配置和重启命令结果，**不新增凭据有效性、MCP 工具发现或模型调用验证**，既有安装检查保持不变。重启命令成功不等于 MCP 已就绪；只关掉并重开终端界面可能仍连接同一个旧后台。

稍后手动恢复时，先保存所有受影响会话的工作，在可信终端确认目标后台正在运行、`codex app-server daemon restart --help` 可用，再从实际 `.env` 读取三个托管值并执行重启。可使用[英文文档的 Node 恢复示例](CONNECT_CODEX.md#safely-restart-an-existing-app-server)：它使用 dotenv parser，不把文件作为 shell 代码执行，不打印密钥，并尊重 `CODEX_HOME`。如果后台状态或命令支持不确定，应查阅该 Codex 版本的管理说明，不用此示例启动原本不存在的服务。

## 第 3 步：可选的手动连接检查

这是用户主动操作，不是自动安装步骤，可能使用你的模型服务。完成必要的后台重启后打开 Codex，输入：

```
check in to chorus
```

Codex 会通过 MCP 调用 `chorus_checkin()`，返回你的 agent 身份、权限和最近的活动记录。Chorus workflow skills（`$chorus`、`$develop`、`$proposal`、`$yolo` 等）也都可以直接使用。

## 非交互安装（CI / sandbox 环境）

配置可以写入成功，但 App Server 重启仍待处理。无 TTY、`--yes` 和 headless 安装都不会自动重启 Codex 后台；稍后交互重跑或按上述手动恢复步骤处理。

显式传入连接信息，并用 `--yes` 跳过交互提示，无需 TTY：

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents codex \
  --url https://chorus.example.com \
  --api-key cho_xxx --yes
```

## 故障排查

- **`codex not found in PATH`** —— 先装 Codex：`npm i -g @openai/codex`。
- **`check in` 返回 `401 Unauthorized`** —— 进程可能持有旧密钥，或 API Key 错误、已失效。运行 `chorus agents add` 刷新凭据，并安全重启已有 App Server；被撤销的密钥应到 Settings → Agents 重新创建。`[mcp_servers.chorus]` 使用 `bearer_token_env_var`，`config.toml` 里没有字面 key 需要手改。
- **Codex 启动 MCP 时报 `Environment variable CHORUS_API_KEY … is not set`** —— 实际 Codex 目录的 `.env` 缺少密钥、未加载，或后台早于配置更新启动。重新运行 `chorus agents add --agents codex` 并按上述安全流程处理已有后台；只 export 密钥或重开终端界面不能刷新已有后台环境。
- **`URL must start with http:// or https://`** —— `CHORUS_URL` 缺了协议头，补上 `http://` 或 `https://`。
- **Marketplace source conflict** —— 你之前用不同 URL 注册过 `chorus-plugins`。脚本会检测到并自动重新注册，留意它打印的 `!` 警告。
- **Hook 在首次启动时没触发** —— 在 Codex 里打开 `/plugins`，确认 `chorus@chorus-plugins` 已安装并启用；再打开 `/hooks` review/trust Chorus 插件自带的 hooks。plugin cache 生成后，hook 会在后续工具调用时生效。

## 下一步

- Skill 文档（工具参考）：`plugins/chorus/skills/chorus/SKILL.md`（Chorus 实例上 `/skill/chorus/SKILL.md` 提供的是独立版本，来自 `public/skill/chorus/SKILL.md`）
- 工作流概览：在 Codex 里输入 `$chorus`
- 要接入 Claude Code，见 [CONNECT_CLAUDE_CODE.zh.md](CONNECT_CLAUDE_CODE.zh.md)
- 其他 MCP 兼容的 agent（Cursor、Continue、自研等）见 [CONNECT_OTHER_AGENTS.zh.md](CONNECT_OTHER_AGENTS.zh.md)
