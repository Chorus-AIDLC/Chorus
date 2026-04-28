# Chorus Plugin for Codex CLI

Codex 版 Chorus 插件的设计说明与安装指南。Claude Code 版在 `public/chorus-plugin/`；本文只讲 Codex 版（`plugins/chorus/`）。

---

## 1. 一句话结论

- **安装方式**:`curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh | bash` → 启动 `codex`(marketplace policy `INSTALLED_BY_DEFAULT`,首次启动自动装)。若未自动,`/plugins` 一键 Install 回退。
- **插件内容**(`plugins/chorus/`): 7 个 skills + 2 个 reviewer sub-agents + 2 个 hooks(`SessionStart` + 2× `PostToolUse`)。
- **MCP server**: **不**在插件 `plugin.json` 里声明,由 installer 单独写到 `~/.codex/config.toml` 的 `[mcp_servers.chorus]`。
- **Marketplace 源**: `https://github.com/Chorus-AIDLC/Chorus`(Codex 读 `.agents/plugins/marketplace.json`)。

---

## 2. 仓库内文件布局

```
Chorus/                                         (repo root)
├── .agents/plugins/marketplace.json            ← Codex marketplace 清单,指向 ./plugins/chorus
├── plugins/
│   └── chorus/                                 ← 插件本体(真代码,非 symlink)
│       ├── .codex-plugin/plugin.json           ← 元数据(name, version, skills/ 路径, hooks 路径)
│       ├── hooks.json                          ← SessionStart + 2× PostToolUse
│       ├── hooks/
│       │   ├── chorus-mcp-call.sh              ← MCP-over-HTTP 小工具(无依赖,纯 curl+jq)
│       │   ├── hook-output.sh                  ← 生成 hook JSON 输出的 helper
│       │   ├── on-session-start.sh             ← 自动 checkin 并注入 additionalContext
│       │   ├── on-post-submit-proposal.sh      ← 引导 spawn chorus-proposal-reviewer
│       │   └── on-post-submit-for-verify.sh    ← 引导 spawn chorus-task-reviewer
│       ├── skills/
│       │   ├── chorus/SKILL.md                 ← 总览 + common tools + setup + 路由
│       │   ├── idea/SKILL.md                   ← PM: claim idea, elaboration
│       │   ├── proposal/SKILL.md               ← PM: PRD + task DAG
│       │   ├── develop/SKILL.md                ← Dev: claim task, report work
│       │   ├── review/SKILL.md                 ← Admin: 审批/验收
│       │   ├── quick-dev/SKILL.md              ← 跳过 idea/proposal 直接开任务
│       │   ├── yolo/SKILL.md                   ← 全自动管线(需 admin+pm+dev 三角色)
│       │   ├── chorus-proposal-reviewer/       ← mount as skill into default agent
│       │   │   ├── SKILL.md                    ← reviewer 指令正文 + 输出格式 + VERDICT 字面量
│       │   │   └── agents/openai.yaml          ← TUI /plugins 面板元数据(不注册 agent_type)
│       │   └── chorus-task-reviewer/           ← mount as skill into default agent
│       │       ├── SKILL.md
│       │       └── agents/openai.yaml
│       └── README.md
│
└── public/
    ├── install-codex.sh                        ← 一键安装脚本(bash 3.2 兼容)
    └── test-install-codex.sh                   ← 安装脚本的回归测试
```

**为什么 `plugins/chorus/` 就是真代码**: Codex marketplace 的 `source.path` 是相对仓库根的路径;过去曾经是 `plugins/chorus/ → packages/chorus-codex-plugin/` 的 symlink,搬平之后删了 symlink,结构更直白。`packages/` 留给其他 sub-package(`chorus-cdk`、`landing`、`openclaw-plugin` 等)。

---

## 3. 安装方式(最终版)

### 3.1 一键脚本(推荐)

```bash
curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh | bash
```

脚本会:

1. 确认 `codex` 在 PATH
2. `codex plugin marketplace add https://github.com/Chorus-AIDLC/Chorus`(幂等)
3. 交互式询问 `CHORUS_URL` 和 `CHORUS_API_KEY`(或读环境变量)
4. 往 `~/.codex/config.toml` 写 `[mcp_servers.chorus]` + `[mcp_servers.chorus.http_headers]`(含 Authorization Bearer),`chmod 600`
5. 往 `~/.codex/hooks.json` 写 Chorus hooks(指向 cache 里的绝对路径),并启用 `[features] codex_hooks = true`

脚本完全幂等,重跑会原地替换 API key、MCP URL、hook 路径,不产生重复 TOML 段。

### 3.2 非交互(CI / 自动化)

```bash
CHORUS_URL=https://chorus.example.com/api/mcp \
CHORUS_API_KEY=cho_xxx \
  bash <(curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh)
```

### 3.3 完成插件安装

脚本跑完后最后一步**必须在 Codex TUI 里手动做**(Codex 0.125 不提供 CLI 方式 install 单个插件):

```
codex
> /plugins
→ 选 "chorus-plugins" → "chorus" → Install
```

Install 后,重启 session 就能看到 skills(`$chorus:chorus`、`$chorus:develop` …)和 `chorus_*` MCP tools。

### 3.4 验证

| 检查 | 命令 | 期望 |
|---|---|---|
| MCP 注册 | `codex mcp list` | 出现 `chorus` 行,Auth = `Bearer token`,enabled |
| MCP 联通 | Codex TUI `/mcp` | `chorus` 显示 connected(绿色) |
| 插件装好 | Codex TUI `/plugins` | `chorus` 状态 Installed |
| Hook 启用 | `grep codex_hooks ~/.codex/config.toml` | `codex_hooks = true` |
| Skill 可用 | 输入 `$chorus:chorus` | 弹出 skill 卡片 |

### 3.5 变更 / 卸载

- **换 API key 或 URL**: 重跑 `install-codex.sh`(全自动覆盖)。
- **卸载**: Codex TUI `/plugins` → Uninstall;然后手动从 `~/.codex/config.toml` 删除 `[mcp_servers.chorus]` 块和 `[marketplaces.chorus-plugins]` 块;从 `~/.codex/hooks.json` 删除 chorus 相关节(或直接删文件)。

---

## 4. Marketplace 与分发

### 4.1 `.agents/plugins/marketplace.json`

```json
{
  "name": "chorus-plugins",
  "interface": { "displayName": "Chorus AI-DLC" },
  "plugins": [
    {
      "name": "chorus",
      "source": { "source": "local", "path": "./plugins/chorus" },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

**字段含义**(以 Codex 0.125 实际读取为准):

- `source.source`: `"local"` 用 `path`,`"git"` 用 `repo`/`ref`;我们用 local。Codex 从 marketplace `source` 拉 repo 时,用的也是同一份 `marketplace.json`,所以本地验证 == 线上分发。
- `policy.installation`: `AVAILABLE`(需用户确认)、`INSTALLED_BY_DEFAULT`(首次启动自动装)、`NOT_AVAILABLE`(藏起来)。我们用 `INSTALLED_BY_DEFAULT` —— Codex 首次 TUI 启动即自动安装,无 CLI `plugin install` 的遗憾在用户侧最小化。若自动未触发(旧 Codex),回退为 `/plugins` 一键 Install。
- `policy.authentication`: `ON_INSTALL`(安装时要凭据)、`ON_USE`(每次用 MCP 时)。我们用 `ON_INSTALL`(插件本身自带 auth 提示);真正的 bearer 由 `install-codex.sh` 写 config.toml。

### 4.2 Marketplace source

```
https://github.com/Chorus-AIDLC/Chorus
```

Installer 默认往这里 `codex plugin marketplace add`。覆盖:

```bash
CHORUS_MARKETPLACE_SOURCE=git+https://github.com/myfork/Chorus@branch \
  bash <(curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh)
```

---

## 5. MCP 配置(为何不在插件里声明)

### 5.1 现状

`plugins/chorus/.codex-plugin/plugin.json` **刻意不带** `mcpServers` 字段。MCP server 由 `install-codex.sh` 写到用户的 `~/.codex/config.toml`:

```toml
[mcp_servers.chorus]
url = "https://chorus.example.com/api/mcp"

[mcp_servers.chorus.http_headers]
Authorization = "Bearer cho_…"
```

### 5.2 为什么不在插件里声明

Codex 0.125 的 plugin `mcpServers` 字段有两道限制,导致无法从插件直接交付可用的 MCP 配置:

1. **不支持 `${VAR}` 展开** — config.toml 里的 `url` / `args` / `http_headers` 值都是字面量,不从环境变量 / `~/.secrets` 插值。若把 `url = "${CHORUS_URL}"` 写进插件,会原样打到服务器。
2. **HTTP MCP 不能用 `bearer_token`** — Codex 只接受 `bearer_token_env_var = "FOO"`(读环境变量),或手写 `http_headers.Authorization = "Bearer xxx"`(字面量)。插件里两种都不能让用户"一次安装就用",前者要求用户 export 变量(macOS GUI 启动 Codex 时 shell env 读不到),后者要求把明文 token 写死在插件里。

结论:**把 MCP 配置和插件分开**,用一行 installer 弥合,是现阶段最干净的方案。

### 5.3 Installer 的 TOML 写入(关键细节)

- **同一 `[mcp_servers.chorus]` 段去重**: 重跑时用 awk 把老的 `^\[mcp_servers\.chorus(\..*)?\]` 段整块删掉再追加新的。
- **`[features] codex_hooks = true`**: hook 需要这个 flag 才生效,installer 只在缺失时追加。
- **权限**: `chmod 600` — token 是敏感信息。

---

## 6. Hooks

### 6.1 最终 hook 清单(2 个事件 3 条 hook)

| 事件 | Matcher | 脚本 | 作用 |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear` | `on-session-start.sh` | 调 `chorus_checkin`,把结果作为 `additionalContext` 注入 |
| `PostToolUse` | `.*chorus_pm_submit_proposal` | `on-post-submit-proposal.sh` | 引导主 agent `spawn_agent(agent_type="default", items=[{type:"skill", path:"chorus:chorus-proposal-reviewer"}, …])` |
| `PostToolUse` | `.*chorus_submit_for_verify` | `on-post-submit-for-verify.sh` | 引导主 agent `spawn_agent(agent_type="default", items=[{type:"skill", path:"chorus:chorus-task-reviewer"}, …])` |

Claude 版里有 `UserPromptSubmit` hook(每次提交 prompt 注入状态提醒),Codex 版**已移除** —— Codex TUI 会把 `additionalContext` echo 到 status 区(`hook context: …` 前缀),每次发言都刷一屏很吵,边际收益不如 SessionStart 一次性注入。决策记录见 §10。

### 6.2 Hook JSON 输出协议

hook 往 stdout 打印一个 JSON,Codex 解析:

```json
{
  "systemMessage": "Chorus connected at …",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Chorus Plugin — Active\n\n## Checkin\n\n{…}\n…"
  }
}
```

- `systemMessage` → **给用户看** — TUI 用 `warning:` 前缀渲染到 status line(`warning:` 是 Codex 硬编码的 prefix,不代表这是警告)。
- `additionalContext` → **给 agent 看** — 注入为 hidden system prompt。同时 TUI 也会原样 echo(`hook context:` 前缀),属于 TUI 的观测性 echo,和 agent 拿到的是同一内容。

`hooks/hook-output.sh` 封装了 jq/fallback 两条路径生成这个 JSON。

### 6.3 `~/.codex/hooks.json` 生成(by installer)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.codex/plugins/cache/chorus-plugins/chorus/0.7.5/hooks/on-session-start.sh",
            "timeout": 20,
            "statusMessage": "Chorus: checkin"
          }
        ]
      }
    ],
    "PostToolUse": [
      { "matcher": ".*chorus_pm_submit_proposal", "hooks": [ { "type": "command", "command": "/…/hooks/on-post-submit-proposal.sh", "timeout": 10 } ] },
      { "matcher": ".*chorus_submit_for_verify", "hooks": [ { "type": "command", "command": "/…/hooks/on-post-submit-for-verify.sh", "timeout": 10 } ] }
    ]
  }
}
```

- **绝对路径**: Codex 0.125 不支持 hooks.json 里写 `${CODEX_PLUGIN_DIR}` 或相对路径展开;installer 把 plugin cache 下真实版本的绝对路径 inlined 进去。
- **plugin cache 路径**: `$CODEX_HOME/plugins/cache/chorus-plugins/chorus/<semver>/`,semver 由 installer 从已安装版本里自动挑最新的。
- **保护用户已有 hooks.json**: 如果发现现有文件里没有 `chorus-plugins/chorus` 路径引用,installer 不会覆盖,只 warn。

### 6.4 Hook 读不到 shell env?

Codex 0.125 **会把 shell 环境传给 hook 子进程**(通过 `-lc` 启动)—— 所以 `CHORUS_URL` / `CHORUS_API_KEY` 需要用户在 shell env 里 export(或写 rc 文件)才能被 hook 读到。Installer 已经在"Done" 步骤把这件事提示给用户。

---

## 7. Skills

7 个 skills(namespaced,在 TUI 输入 `$chorus:<name>`):

| 触发词 | 角色 | 用途 |
|---|---|---|
| `$chorus:chorus` | 所有 | 平台总览 + checkin + 公共工具清单 + setup + 路由到其他 skills |
| `$chorus:idea` | PM | 认领 Idea,做 elaboration 轮次 |
| `$chorus:proposal` | PM | 写 PRD + task DAG,提交 review |
| `$chorus:develop` | Dev | 领任务,写代码,`chorus_report_work`,`chorus_submit_for_verify` |
| `$chorus:review` | Admin | 审批 proposal,验收 task |
| `$chorus:quick-dev` | Admin | 跳过 Idea/Proposal,直接创建任务 → 执行 → 验收 |
| `$chorus:yolo` | Admin+PM+Dev(三合一) | 从一句话 prompt 自动跑完 AI-DLC 全流程 |

Skill 来源: 基于 `public/chorus-plugin/skills/*/SKILL.md` 移植,替换 Claude Code 特有概念:

- `/skill-name` → `$chorus:skill-name`
- `Task` 工具(Claude Code spawn agent)→ `spawn_agent` 工具(Codex)
- Hooks 描述从"自动触发"改为"advisory context,由主 agent 显式 `spawn_agent` 触发"

---

## 8. Reviewer Sub-Agents

两个只读 sub-agent,实际上**就是两个特殊的 skill** —— 在其 skill 目录下放 `agents/openai.yaml` 后,Codex 把 skill name 注册为一个可用的 `agent_type`。由 `PostToolUse` hook 注入的 additionalContext 建议主 agent 用 `spawn_agent(agent_type="...")` 启动。

### Codex 的 subagent 注册机制(重要)

Codex 0.125 的 `spawn_agent` 工具 **只接受三个内置 `agent_type`**: `default`、`explorer`、`worker`。传自定义值(比如 `chorus-proposal-reviewer`)会直接报 `unknown agent_type`。

**这意味着**: 我们的 "reviewer" 不是一个真正的自定义 agent 类型, 而是一个**通过 skill 挂载的角色**。工作流:

1. `plugins/chorus/skills/chorus-proposal-reviewer/` 里放完整的 reviewer 指令(SKILL.md 的正文就是 prompt)
2. 同目录下的 `agents/openai.yaml` **只负责 TUI `/plugins` 面板里的显示元数据** (`display_name`、`short_description`、`default_prompt`), 并不会把 skill "注册" 成一个 agent_type
3. spawn 时这样调用, 把 skill 当内容喂给 default agent:

   ```
   spawn_agent(
     agent_type="default",
     items=[
       { type: "skill", name: "Chorus Proposal Reviewer", path: "chorus:chorus-proposal-reviewer" },
       { type: "text",  text: "Review proposal <uuid>. Post VERDICT comment." }
     ]
   )
   ```

`items` 数组的第一个条目把 skill 文件作为结构化 context 注入新 agent 的对话; 第二个条目是实际任务指令。Codex `spawn_agent` 工具描述里列了 `Input item type: text, image, local_image, skill, or mention` —— `skill` 就是这用法。

**路径语法**: `chorus:chorus-proposal-reviewer`(小写 namespace)或 `Chorus:chorus-proposal-reviewer`(Pascal, 与 plugin displayName 对齐)。如果一种不通就换另一种 —— 从 TUI `/plugins` 面板看 skill 显示为什么前缀为准。

**为什么曾经以为 `agents/*.toml` 或 `agents/openai.yaml` 会注册 agent_type**: 那是从 Codex system skills 的目录结构(`skill-creator/agents/openai.yaml` 等)反推出的错误假设。实际上 `agents/openai.yaml` 只是 UI 元数据, 和 agent_type 注册无关。sparkly 2026-04-28 由用户实测纠正。

### 两个 reviewer

| Agent | 触发时机 | 写作模式 | 三种结论 |
|---|---|---|---|
| `chorus-proposal-reviewer` | `chorus_pm_submit_proposal` 后 | 只读(只能读 + 评论) | PASS / PASS WITH NOTES / FAIL |
| `chorus-task-reviewer` | `chorus_submit_for_verify` 后 | 只读 | 同上 |

结论发为 `chorus_add_comment` 写到 proposal/task 上。reviewer 的意见是**咨询性**的,不阻断 Admin 的审批动作。

### 线程槽位纪律(重要)

Codex 限制**每条根线程最多 6 个并发 subagent 线程**(`agent thread limit reached (max 6)`)。关键坑: `completed` 状态**不会**释放槽位, 只有 `close_agent(id)` 会。

`$yolo` 这种长链路会连续 spawn 多个 reviewer / worker, 每次 `wait_agent` 返回后必须立即 `close_agent`, 否则第 7 次 spawn 必爆。这条纪律写进 hook 提示和 `$yolo` skill 正文里。

### VERDICT 字面量(重要)

reviewer 输出末尾必须是这三个字符串之一, 不能换同义词("APPROVE"、"OK"不行):

- `VERDICT: PASS`
- `VERDICT: PASS WITH NOTES`
- `VERDICT: FAIL`

SKILL.md 里写明了这一要求, 但 LLM 有时候会"创造"新 verdict。hook 注入的 additionalContext 也用同样字面量, 降低漂移概率。主 agent 读 VERDICT 时用正则 `^VERDICT: (PASS|PASS WITH NOTES|FAIL)$` 严格匹配, 其他值按 FAIL 处理(保守)。

---

## 9. 已知限制(明确不做)

### 9.1 没有 `.chorus/` 本地状态目录

Claude 版依赖 `.chorus/sessions/*.json` 追踪多 agent 协作时的 session lifecycle。Codex 版**不落盘任何文件**:

- Codex 不提供 `SubagentStart` / `SubagentStop` / `TeammateIdle` 事件,无法可靠地在 subagent 启动/结束时做 session checkin/checkout。
- 无法自动维护 session 元数据。

代价: 主 agent 用 `spawn_agent` spawn worker 时,**可选**手动 `chorus_create_session` + 把 `sessionUuid` 传进 worker 初始 prompt,worker 结束后主 agent `chorus_close_session`。不做也能工作 —— 只是丢失 per-worker 观测性。

### 9.2 MCP tool 是 session-start snapshot

`codex resume --last` 不会重新发现新注册的 MCP server。第一次装完 Chorus 后必须起**新 session**(不要 `--resume`)才能看到 `chorus_*` 工具。

### 9.3 插件 Install 必须走 TUI

Codex 0.125 的 `codex plugin` 子命令只有 `marketplace add/upgrade/remove`,**没有** `plugin install <name>`。脚本把 marketplace `policy.installation` 设为 `INSTALLED_BY_DEFAULT`,让 Codex 首次启动时自动装入。若未自动触发(不同 Codex 版本实现略异),Installer 的 epilogue 指引用户进 `/plugins` 一键 Install 作为 fallback。

---

## 10. 设计决策日志

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-04-27 | `plugin.json` 里不放 `mcpServers` | config.toml 不展开 `${VAR}`,bearer token 也不从 env 读取 |
| 2026-04-27 | 砍掉 `.mcp.json` 方案 | 同上 |
| 2026-04-27 | 不放 stdio proxy,选 HTTP MCP + installer 写 config.toml | 用户 UX 上最少动作 |
| 2026-04-27 | Installer 纯 bash + awk,不依赖 python/node | macOS 自带 bash 3.2 都要跑得通 |
| 2026-04-27 | Installer 支持 `curl \| bash` | `exec < /dev/tty` 重新接回交互输入 |
| 2026-04-28 | 砍掉 `UserPromptSubmit` hook | TUI echo 太吵,边际收益不值 |
| 2026-04-28 | `plugins/chorus/` 存真代码,不再 symlink 到 `packages/` | 直观,与 marketplace.json 的 `./plugins/chorus` 路径一致 |
| 2026-04-28 | 修 `chorus-mcp-call.sh` 的 `${2:-{}}` parse bug | bash parser 把字面量 `{}` 在 `${:-…}` 里多吃一个 `}`,JSON 多括号服务器报 `-32700 Parse error` |
| 2026-04-28 | `CHORUS_URL` 语义统一为"完整 MCP endpoint" | installer/hook 之前不一致,双拼成 `…/api/mcp/api/mcp` |
| 2026-04-28 | Reviewer 从 `.toml` 改为 skill 目录 + `agents/openai.yaml` | Codex 根本不读 `agents/*.toml`,首次 spawn 报 `unknown agent_type`。真正的注册机制是 skill 目录下放 `agents/openai.yaml` |
| 2026-04-28 | **更正**: `agents/openai.yaml` **不会**注册 agent_type | 实测 `spawn_agent(agent_type="chorus-proposal-reviewer")` 仍报 unknown。Codex 只有 default/explorer/worker 三种内置 role。正确做法:`agent_type="default"` + `items=[{type:"skill",path:"chorus:chorus-proposal-reviewer"}]` |
| 2026-04-28 | 所有 `spawn_agent` 后强制 `close_agent` | `completed` 不释放槽位,长链路必撞 max 6 |
| 2026-04-28 | VERDICT 字面量三选一硬性写进 SKILL + hook | LLM 常自创"APPROVE"导致 grep 失败 |

---

## 11. 回归测试

```bash
bash public/test-install-codex.sh
```

4 维 17 项断言:

1. **静态扫描** — 拒绝 bash 4+ 专属语法(`${VAR,,}`、`declare -A`、`mapfile`、`&>`、`|&`、`;;&`)
2. **`bash -n` 解析** — 用 target bash 做语法检查,默认优先 `$BASH32` → `/tmp/bash32-build/bash-3.2/bash` → `/bin/bash`(macOS 3.2.57) → PATH 上的 `bash`
3. **端到端 dry run** — fake `codex` stub + 隔离 `CODEX_HOME`,校验生成的 `[mcp_servers.chorus]` + `http_headers` + literal URL + literal Bearer + mode 600
4. **幂等重跑** — 轮换 key,校验唯一 mcp block / 唯一 http_headers block / 旧 key 被清除

---

## 12. 历史文档

本文的演进过程(15 个章节的研究日志,从"为什么 `.mcp.json` 走不通"一路推到最终方案)归档在:

```
docs/_archive/codex-plugin-plan.history.md
```

如需考古请看那里;日常维护只读本文。
