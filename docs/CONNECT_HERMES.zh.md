# 将 Hermes Agent 接入 Chorus

本文介绍如何将 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（Nous Research）接入 Chorus。集成代码在本仓库的 `packages/chorus-hermes/`，通过 `hermes plugins install` 直接从 GitHub 安装，并固定到某个发布 commit；不发布到 npm 或 PyPI。

Hermes 自带常驻的消息 gateway，因此 Chorus 和对待 OpenClaw 一样，**通过插件在线调度**它：插件注册的 `chorus` gateway 平台与 Chorus 保持连接，让 agent 显示为在线，并对每次唤醒（分配、@提及、提案审批结果、任务验收）运行一轮 gateway 对话。Hermes 不使用 `chorus daemon`。

> 完整参考（兼容性说明、只读审查守卫、模块说明）见 [`packages/chorus-hermes/README.md`](../packages/chorus-hermes/README.md)。

## 安装内容：两个目录

| 目录 | 类型 | 提供 |
|---|---|---|
| `packages/chorus-hermes/chorus` | Hermes 原生插件 | checkin 上下文与提醒、`chorus:<name>` 技能、只读审查守卫、`chorus` gateway 平台、`chorus` 审批 transport |
| `packages/chorus-hermes/chorus-mcp` | 可移植 Agent Plugins v1 包 | `chorus` MCP 服务器（`mcp__chorus__*` 工具） |

Hermes 只能通过可移植包声明 MCP 服务器，而 hooks、技能、平台和审批 transport 只有原生插件能注册，所以两个目录都要装。

## 前置条件

- 一个可访问的 Chorus 实例，例如 `http://localhost:8637` 或已部署的 URL
- 已安装 Hermes Agent，且 `PATH` 中有 `hermes`（[安装指南](https://hermes-agent.nousresearch.com/docs/getting-started/installation)）；已在 Hermes commit `2b52acc2d` 上验证
- `PATH` 中有 `git`（用于解析发布 tag）
- 一个 Chorus agent API Key（**Settings → Agents → Create API Key**，以 `cho_` 开头）

## 第 1 步：安装插件

### 最快方式：`chorus agents add`

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
npm install -g @chorus-aidlc/chorus
chorus agents add --agents hermes
```

`chorus agents add --agents hermes` 会：

- 用 `git ls-remote` 把发布 tag `v<CLI 版本>` 解析成 40 位 commit SHA，再以 `--ref <sha> --enable` 安装两个目录；tag 解析不到时直接失败，不安装任何东西；
- 两个插件都已安装时，会询问是否按当前版本重新安装（`[y/N]`；带 `--yes` 或无 TTY 时自动重装）；`chorus upgrade --plugins` 也会重新安装；
- Chorus **不在** `localhost:8637` 时，向 `$HERMES_HOME/config.yaml` 写入原生 `mcp_servers.chorus` 条目（见第 3 步）；
- 打印后续配置清单（第 2–5 步）。不会写入你的 key。

### 手动安装

Hermes 的 `--ref` **只接受完整的 40 位 commit SHA**，tag 名和短 SHA 都会被拒绝，所以要先解析 tag。Chorus 的 tag 是轻量 tag，因此要保留非 peeled 的回退查询：

```bash
VERSION=0.21.1
REPO=https://github.com/Chorus-AIDLC/Chorus.git
SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
[ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
[ -n "$SHA" ] || { echo "error: tag v$VERSION not found" >&2; exit 1; }

hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus     --ref "$SHA" --enable
hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "$SHA" --enable
hermes plugins list --plain --no-bundled   # 两者都应为：enabled  git pinned@<sha8>
```

## 第 2 步：为 gateway 提供凭证

插件只从环境变量读取 `CHORUS_URL` 和 `CHORUS_API_KEY`。以 systemd/launchd 服务运行的 gateway 不会继承你的 shell 环境，所以要写进 `~/.hermes/.env`：

```bash
CHORUS_URL=https://chorus.example.com
CHORUS_API_KEY=cho_your_api_key
```

不需要单独启用平台：两个变量都设置后，`chorus` 平台会自动启用。

可选开关（默认都开启）：

| 变量 | 作用 |
|---|---|
| `CHORUS_ENABLE_OPENSPEC=false` | 关闭 OpenSpec 检测（旧写法 `CHORUS_OPENSPEC_MODE=off` 等效） |
| `CHORUS_ENABLE_CODE_REVIEWER=false` | Idea 的最后一个任务验收后，不再提醒运行 code reviewer |

## 第 3 步：MCP URL（仅远程 Chorus 需要）

可移植的 `chorus-mcp` 包无法在 URL 中展开 `${CHORUS_URL}`，因此内置的是固定的回环地址 `http://localhost:8637/api/mcp`，本地 Chorus 直接可用。其他部署需要添加一个原生条目：Hermes 会展开其中的变量，且它会覆盖同名的可移植服务器（`chorus agents add` 会自动完成这一步）：

```bash
hermes config set mcp_servers.chorus.url '${CHORUS_URL}/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

保留单引号，这样配置里存的只是占位符。之后 Hermes 会打印 `Portable MCP server 'chorus' conflicts with native config; skipping`，这是正常现象。

## 第 4 步：一个 gateway 对应一个仓库

```bash
hermes config set terminal.cwd /path/to/your/repo
```

每次唤醒都在 `terminal.cwd` 中运行，插件会把它的真实路径上报给 Chorus。未设置或为占位值（`.`、`auto`、`cwd`）时，平台拒绝连接。要服务多个仓库，就为每个仓库各用一个 Hermes profile 运行一个 gateway。

## 第 5 步：通过 Chorus 评论审批

```bash
hermes config set security.approval.transport chorus
hermes config set security.approval.transport_fallback builtin   # 保证 CLI/TUI 仍能弹出提示
hermes config set approvals.timeout 300                          # 超时未回复 = 拒绝
hermes config set approvals.mode manual
```

**为什么要 `approvals.mode: manual`：** 默认的 `smart` 模式下，Hermes 会先询问它的 guardian 模型；guardian 批准的命令会直接运行，不经过 transport。在无人值守的 gateway 上，这意味着你根本不会被问到。`manual` 模式会把每条被标记的命令都交给你。

被唤醒的轮次需要审批时，agent 会在它正在处理的 Chorus 实体上发评论，@你，并附上 6 位 token。在同一实体上回复 `approve once <token>`、`approve session <token>`、`approve always <token>`（后两种仅在提供时可用）或 `deny <token>`。只有 agent owner 的回复有效；超时即拒绝；审批回复不会启动新的轮次。

## 第 6 步：启动 gateway 并验证

```bash
hermes gateway install   # 安装为 systemd / launchd 服务
hermes gateway start
hermes gateway status    # 或在前台运行：hermes gateway run
```

| 检查项 | 预期 |
|---|---|
| Chorus agent 列表 / 在线状态 | agent 显示在线，客户端为 **Hermes** |
| `hermes chat -q "call chorus_checkin"` | 通过 `mcp__chorus__chorus_checkin` 返回 agent 身份 |
| 会话第一轮 | 注入 `## Checkin` / `## Spec Mode` / `## Quick Reference` 区块 |
| 给 agent 分配一个 Idea | gateway 运行一轮，并在该 Idea 的对话中上报 |

## 技能与审查者

- 技能注册为 `chorus:<name>`，用 `skill_view` 加载：`skill_view("chorus:develop")`、`skill_view("chorus:yolo")` 等（`chorus`、`idea`、`brainstorm`、`research`、`proposal`、`develop`、`review`、`quick-dev`、`yolo`、`orchestrate`、`openspec-aware`、`spec-lite`、`chorus-cli`、`docs`，以及三个审查技能）。
- 审查者以 `delegate_task` 子任务运行：`context` 以 `[chorus-reviewer:proposal|task|code]` 开头，并让子任务调用 `skill_view("chorus:chorus-<kind>-reviewer")`。插件会把带标记的子任务设为只读：只能读 Chorus、用 `chorus_add_comment` 发 VERDICT，以及读取/搜索文件。

## 已知限制

- Hermes gateway 暂不执行研究（research）与创建 Idea（idea-creation）这类**操作轮次**，与 OpenClaw 相同。
- **无法确定对应关系的审批回复按"放行"处理（fail open）。** 如果插件无法把回复对应到确切的评论和待处理轮次（例如约一秒内出现两条 @提及，或旧版 Chorus 的 pending turn 没有 `createdAt`），它会把这次唤醒当作普通 @提及运行，而不是作为审批答复。请重新回复，或等待超时自动拒绝。
- `chorus_checkin` 会把最多 5 条最近的通知标为已读。gateway 会从服务端的 pending turn 恢复唤醒，但你的收件箱里这些通知可能会提前显示为已读。
- 一个 gateway 只服务一个仓库；Hermes 没有 `chorus daemon` 后端。

## 故障排查

| 现象 | 处理 |
|---|---|
| agent 一直离线 | 检查 `hermes gateway status`，并在 gateway 日志中查找 `[Chorus] gateway platform not started`。常见原因：gateway 环境中没有凭证（用 `~/.hermes/.env`）、未设置 `terminal.cwd`、URL 或 key 错误。 |
| 日志出现 `connection conflict … host=… cwd=…` | 同一主机和 cwd 上已有另一个在线客户端在服务这个 agent。停掉重复的那个，然后执行 `hermes gateway restart`。 |
| 审批超时 / 被拒绝 | 以 agent owner 身份，在 `approvals.timeout` 内、在同一实体上回复完全一致的 token。 |
| 危险命令未经询问就执行了 | 设置 `approvals.mode manual`。 |
| 没有 `mcp__chorus__*` 工具 | `chorus-mcp` 未启用、`CHORUS_API_KEY` 未设置，或远程 Chorus 缺少原生 `mcp_servers.chorus` 条目（第 3 步）。 |
| `--ref` 被拒绝 | 必须是完整的 40 位 commit SHA；先解析 tag（第 1 步）。 |

## 相关指南

- [接入 Claude Code](CONNECT_CLAUDE_CODE.zh.md)
- [接入 Codex](CONNECT_CODEX.zh.md)
- [接入 dsh](CONNECT_DSH.zh.md)
- [接入其他 MCP agent](CONNECT_OTHER_AGENTS.zh.md)
