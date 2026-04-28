# Chorus Plugin for Codex CLI — 移植计划

> 本文记录把 `public/chorus-plugin/`(Claude Code 版)移植到 OpenAI Codex CLI 的研究结论与分步计划。
> 源插件版本:`chorus@0.7.5`(AGPL-3.0)。
> 目标平台:Codex CLI(截至 2026-04 的公开 docs)。

---

## 1. 背景

Chorus 是一个面向 AI Agent 协作的 PM 平台,提供 PM / Developer / Admin 三类 Agent 角色和完整的 AI-DLC 生命周期(Idea → Proposal → Execute → Verify → Done)。

现有 Claude Code 插件 `public/chorus-plugin/` 由 4 层组成:

- **MCP Server** — 远端 HTTP MCP(`${CHORUS_URL}/api/mcp`,Bearer 认证),提供 40+ 个 `chorus_*` 工具
- **Hooks(14 个 shell 脚本)** — 挂在 Claude Code 的 10 类生命周期事件上,负责 session 自动创建/心跳/关闭、上下文注入、评审流程触发
- **Skills(7 个)** — `chorus`、`idea`、`proposal`、`develop`、`review`、`quick-dev`、`yolo` 斜杠命令与流程说明
- **Sub-agents(2 个)** — `proposal-reviewer`、`task-reviewer`,独立评审工作流

---

## 2. Codex CLI 插件与 Hook 能力摸底

来源:`https://developers.openai.com/codex/plugins`、`/codex/plugins/build`、`/codex/hooks`、`/codex/config-advanced`。

### 2.1 插件结构

- 入口清单必需:`.codex-plugin/plugin.json`
- 清单可声明 `skills`、`mcpServers`、`apps` 三类组件(相对插件根的路径)
- 分发(marketplace)查找顺序:
  1. 官方 curated marketplace(Plugin Directory)
  2. `$REPO_ROOT/.agents/plugins/marketplace.json`
  3. `$REPO_ROOT/.claude-plugin/marketplace.json`(兼容)
  4. `~/.agents/plugins/marketplace.json`
- 安装路径:`~/.codex/plugins/cache/<MARKETPLACE>/<PLUGIN>/<VERSION>/`,本地插件 `<VERSION>` = `local`
- 启停状态持久化在 `~/.codex/config.toml`

### 2.2 Hook 机制(experimental)

- 开关:`[features] codex_hooks = true`
- 加载层(合并,非覆盖):
  - `~/.codex/hooks.json` 或 `~/.codex/config.toml` 内 `[hooks]`
  - `<repo>/.codex/hooks.json` 或 `<repo>/.codex/config.toml`
  - 企业级 `requirements.toml`
- 关键限制(截至 Codex 0.125.0):**plugin manifest 声明 `hooks` 字段已在 scaffold/docs 出现,但 runtime 尚未实装加载**(见 openai/codex#16430、#17331,二进制中 `.codex-plugin/plugin.json` 的 `hooks` 字段仍是字面值 `[TODO: ./hooks.json]`)。当前唯一被 runtime 执行的 hook 源仍是 `~/.codex/hooks.json` / `<repo>/.codex/hooks.json` / 企业级 `managed_config.toml`。移植版同时按未来兼容格式放 `hooks.json`,并提供 `install-hooks.sh` 作为过渡。

### 2.3 Codex 当前支持的 6 个 hook 事件

| 事件 | 作用域 | matcher 语义 |
|---|---|---|
| `SessionStart` | session | `source`(`startup` / `resume` / `clear`) |
| `UserPromptSubmit` | turn | 忽略 matcher |
| `PreToolUse` | turn | `tool_name`(`Bash`、`apply_patch`/`Edit`/`Write`、`mcp__server__tool`) |
| `PermissionRequest` | turn | 同 `tool_name` |
| `PostToolUse` | turn | 同 `tool_name` |
| `Stop` | turn | 忽略 matcher |

**不支持**:`SessionEnd`、`SubagentStart`、`SubagentStop`、`TeammateIdle`、`TaskCompleted`、`Notification`、`PreCompact`。

### 2.4 Hook stdin 事件 JSON

通用字段:`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`。turn 级事件加 `turn_id`。事件特有字段见 Codex 官方 hooks 页。

### 2.5 Hook stdout 输出协议

Codex **已采用 Claude Code 的 `hookSpecificOutput` 形状**,主要字段:

- `systemMessage`:用户可见通知
- `hookSpecificOutput.additionalContext`:注入到模型上下文(developer message)
- `hookSpecificOutput.hookEventName`:事件名
- `hookSpecificOutput.permissionDecision`(PreToolUse 专用,目前仅 `"deny"` 生效)
- `decision: "block"` + `reason`:PostToolUse 替换工具结果并继续;Stop 生成续写 prompt
- `continue: false` + `stopReason`:中止 hook 链
- `suppressOutput`:文档里存在但**尚未实装**

Codex 独有:`PermissionRequest` 可 allow/deny 审批弹窗本身,Chorus 未用到,移植时可新增"自动批准 chorus_* MCP 工具"策略简化 UX。

---

## 3. 组件级可移植性分析

### 3.1 MCP Server — ✅ 零成本移植

Chorus 的 `.mcp.json` 定义:

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "${CHORUS_URL}/api/mcp",
      "headers": { "Authorization": "Bearer ${CHORUS_API_KEY}" }
    }
  }
}
```

Codex MCP 客户端支持 http transport,只需改写成 Codex 的 `[mcp_servers.chorus]` 段即可。所有 `chorus_*` 工具(checkin、create_proposal、claim_task、submit_for_verify、add_comment、search …)在 Codex 中直接可用。**这是整个插件最大价值所在,且无需改造。**

### 3.2 Skills — ✅ 几乎 100% 可移植

7 个 skill(`chorus` / `idea` / `proposal` / `develop` / `review` / `quick-dev` / `yolo`)都是标准 `SKILL.md` + YAML frontmatter + MCP 工具调用示例,与 Codex skill 格式一致。

**需要调整的地方(约 5% 文字量)**:
- frontmatter 中 Claude 特有字段(如 `metadata.mcp_server`)保留无害但 Codex 不消费
- `develop` / `yolo` 里涉及 "sub-agent 自动注入 sessionUuid" 的段落需改写 —— Codex 无 SubagentStart hook,应改为"主 agent 显式把 sessionUuid 写进子 agent 的 prompt"
- `quick-dev` / `yolo` 里提到 Claude Code `Task` 工具的,改为 Codex 的 `spawn_agent`

### 3.3 Sub-agents(`proposal-reviewer` / `task-reviewer`)— ✅ 可移植,语义稍弱

- **Prompt 主体可直接搬**:READ-ONLY 评审规程、BLOCKER/NOTE 分类、`VERDICT: PASS/FAIL` 结尾约定,与平台无关
- **Claude 字段映射**:
  - `maxTurns` → Codex agent 侧的轮次上限机制(如有)或在 prompt 里软约束
  - `disallowedTools: [Edit, Write, Bash, ...]` → 靠 Codex profile / sandbox 权限策略
  - `criticalSystemReminder_EXPERIMENTAL` → 放进 system prompt 开头
- **调用方式**:主 agent 由 skill 指令触发 `spawn_agent(agent_type=...)`,而不是 Claude 的 `Task` 工具

### 3.4 Hooks — ⚠️ 这是差距最大的一层

| Chorus hook | 脚本 | Codex 可行性 | 移植方案 |
|---|---|---|---|
| `SessionStart` | `on-session-start.sh` | ✅ 直接移植 | 事件名、`source`、`additionalContext` 输出一致,`chorus_checkin` 调用照搬 |
| `UserPromptSubmit` | `on-user-prompt.sh` | ✅ 直接移植 | 本就没用 matcher,直接能跑 |
| `PreToolUse: EnterPlanMode` | `on-pre-enter-plan.sh` | ❌ 事件不存在 | 降级:`UserPromptSubmit` 里关键词检测;或由 skill 显式触发 |
| `PreToolUse: ExitPlanMode` | `on-pre-exit-plan.sh` | ❌ 事件不存在 | 同上 |
| `PreToolUse: Task` | `on-pre-spawn-agent.sh` | ⚠️ 语义不同 | Codex 子 agent 非 `Task` 工具。若 `spawn_agent` 被纳入工具事件流,可 matcher 之;否则放弃 |
| `PostToolUse: chorus_pm_submit_proposal` | `on-post-submit-proposal.sh` | ✅ 直接移植 | matcher 改成 `mcp__chorus__chorus_pm_submit_proposal` |
| `PostToolUse: chorus_submit_for_verify` | `on-post-submit-for-verify.sh` | ✅ 直接移植 | 同上 |
| `SubagentStart` | `on-subagent-start.sh` | ❌ 事件不存在 | 失去自动 session 创建/复用能力,改手动由主 agent 负责 |
| `SubagentStop` | `on-subagent-stop.sh` | ❌ 事件不存在 | 失去自动 checkout + close session,改由 sub-agent 在任务末尾显式调用 |
| `TeammateIdle` | `on-teammate-idle.sh` | ❌ 事件不存在 | 降级:延长 session TTL,或由主 agent 定期 heartbeat |
| `TaskCompleted` | `on-task-completed.sh` | ❌ 事件不存在 | 降级:sub-agent 完成时显式 checkout |
| `SessionEnd` | `on-session-end.sh` | ❌ 事件不存在 | 降级:`SessionStart` 做 lazy cleanup |

**核心损失**:多 agent 并行时 "hook 保证正确性" 的那套自动化机制,在 Codex 上退化为 "靠 prompt 约束"。

---

## 4. 功能矩阵(Chorus 原有 vs Codex 移植后)

| 功能 | 能否保留 | 实现方式 |
|---|---|---|
| Idea / Proposal / Task / Document CRUD 全套 MCP 工具 | ✅ | MCP server 原样接入 |
| 7 个斜杠命令 `/chorus` `/idea` `/proposal` `/develop` `/review` `/quick-dev` `/yolo` | ✅ | Codex skill |
| 会话启动自动 checkin + 注入 agent 身份/待办上下文 | ✅ | `SessionStart` hook |
| 提交 proposal 后自动提醒 spawn proposal-reviewer | ✅ | `PostToolUse` + MCP tool matcher |
| 提交 task 验证后自动提醒 spawn task-reviewer | ✅ | 同上 |
| `proposal-reviewer` / `task-reviewer` 两个评审 sub-agent | ✅ | Codex subagent + skill 内 `spawn_agent` 指令 |
| 每次用户输入注入简短工作流提醒 | ✅ | `UserPromptSubmit` hook |
| Plan 模式下的 proposal 引导 | ⚠️ 降级 | 移到 skill 内容里,或 `UserPromptSubmit` 关键词匹配 |
| Sub-agent 自动创建 Chorus session + 注入 sessionUuid | ❌ | 主 agent 在 `spawn_agent` 前手动 `chorus_create_session`,把 UUID 写进子 agent prompt |
| Sub-agent 退出自动 close session + auto-verify | ❌ | 子 agent 在 skill 结尾显式 `chorus_session_checkout_task` / `chorus_submit_for_verify` |
| TeammateIdle 心跳续命 | ❌ | session TTL 调长,或主 agent 周期性 heartbeat |
| TaskCompleted 自动 checkout | ❌ | 显式调用 |
| SessionEnd 清理 `.chorus/` | ❌ | `SessionStart` lazy cleanup |

**整体覆盖率评估**:手动工作流 100%,自动化深度 ~60%(hooks 缺失主要影响多 agent 并行场景的无感体验)。

---

## 5. 打包形态

由于 Codex plugin manifest 目前**不能**打包 hooks,移植产物分成两件:

### 5.1 插件目录(可通过 marketplace 分发)

```
chorus-codex-plugin/
├── .codex-plugin/
│   └── plugin.json              # 清单(name, version, skills, mcpServers, interface)
├── mcp/
│   └── chorus.json              # MCP server 声明(http transport)
├── skills/
│   ├── chorus/SKILL.md
│   ├── idea/SKILL.md
│   ├── proposal/SKILL.md
│   ├── develop/SKILL.md
│   ├── review/SKILL.md
│   ├── quick-dev/SKILL.md
│   └── yolo/SKILL.md
└── agents/
    ├── proposal-reviewer.md
    └── task-reviewer.md
```

### 5.2 Hooks 安装器(独立)

```
chorus-codex-plugin/
├── hooks/
│   ├── on-session-start.sh
│   ├── on-user-prompt.sh
│   ├── on-post-submit-proposal.sh
│   ├── on-post-submit-for-verify.sh
│   └── chorus-api.sh            # MCP-over-HTTP helper(直接复用原插件的)
└── install-hooks.sh             # 把 hooks 写入 ~/.codex/hooks.json 或 <repo>/.codex/hooks.json
```

`install-hooks.sh` 负责:
- 把 `hooks/*.sh` 拷贝到 `~/.codex/plugins/chorus/bin/`
- 在 `~/.codex/hooks.json` 里 merge 对应的 matcher 条目
- 在 `~/.codex/config.toml` 里打开 `[features] codex_hooks = true`

### 5.3 Marketplace 条目

`<repo>/.agents/plugins/marketplace.json`:

```json
{
  "name": "chorus-aidlc",
  "interface": { "displayName": "Chorus AI-DLC" },
  "plugins": [
    {
      "source": { "path": "./chorus-codex-plugin" },
      "interface": { "displayName": "Chorus" },
      "policy": { "installation": "manual", "authentication": "apiKey" },
      "category": "project-management"
    }
  ]
}
```

---

## 6. 移植路线图

### 阶段 1 — 骨架可用(预计 1–2 小时)

**目标**:覆盖 ~80% 的 Chorus 手动工作流,不依赖任何 hook。

- [ ] 创建 `chorus-codex-plugin/` 目录 + `.codex-plugin/plugin.json`
- [ ] 把 Chorus MCP 声明改写到插件清单(或本地 `~/.codex/config.toml`)
- [ ] 复制 7 个 skill,改写 frontmatter,标注 Codex 上不可用的 hook 相关段落
- [ ] 复制 2 个 sub-agent,改写字段映射(`maxTurns` / `disallowedTools` / 系统提示)
- [ ] 写 `README.md` 说明 API key、角色需求、限制

**验收**:`codex resume` 后能用 `/chorus` 命令完成一次 idea → proposal → task → verify 全流程(手动)。

### 阶段 2 — Hook 半自动化(预计 2–3 小时)

**目标**:会话级上下文自动注入 + 评审闭环自动提醒。

- [ ] 移植 `on-session-start.sh`(直接复用 `chorus-api.sh`,把 stdout 协议改成 Codex 形状 —— 实测几乎一致)
- [ ] 移植 `on-user-prompt.sh`(去掉 Claude 特有字段引用)
- [ ] 移植 `on-post-submit-proposal.sh` / `on-post-submit-for-verify.sh`,matcher 改为 `mcp__chorus__chorus_pm_submit_proposal` 等
- [ ] 写 `install-hooks.sh` 一键安装器,幂等 merge 到 `~/.codex/hooks.json`
- [ ] 在 `SessionStart` hook 里加 lazy cleanup(替代 `SessionEnd`)

**验收**:
- 新开会话时自动出现 "Chorus connected" systemMessage
- 模型上下文里已注入 checkin 结果
- 调 `chorus_pm_submit_proposal` 后自动收到"请 spawn proposal-reviewer"提示

### 阶段 3 — 深度自动化(阻塞在 Codex)

**依赖 Codex 新增以下能力才能做**:

- `SubagentStart` / `SubagentStop` 事件 → 恢复 session 自动 create/close/reuse
- `SessionEnd` 事件 → 清理 `.chorus/` 目录
- `TaskCompleted` 事件 → 自动 checkout
- plugin manifest 支持打包 hooks → 用户一键安装而不再跑 `install-hooks.sh`

在此之前,阶段 2 是可达的最佳状态。

---

## 7. 风险与开放问题

- **PreToolUse 非强制边界**:Codex 文档明确说 `PreToolUse` 只是 guardrail,`unified_exec` 等路径不一定拦得到。如果未来 Chorus hook 要做"禁止某些工具",在 Codex 上可能不可靠
- **MCP tool name 规范**:hook matcher 里 MCP 工具名格式 `mcp__<server>__<tool>` 需以 Codex 当前实际命名为准,建议先用 `codex mcp list` + 跑一次 `PostToolUse` echo 脚本验证
- **Stop 事件的利用**:Chorus 没用,但 Codex 支持 —— 可以考虑新增一个 "turn 结束时自动 heartbeat session" 的 hook,替代 `TeammateIdle`
- **许可**:Chorus 是 AGPL-3.0,移植版需沿用相同协议,并在插件 `license` 字段显式声明

---

## 8. 参考资料

- 源插件:`public/chorus-plugin/`(Chorus 0.7.5)
- 现有 Claude 版设计文档:`docs/chorus-plugin.md`
- Codex 插件构建:`https://developers.openai.com/codex/plugins/build`
- Codex hook 参考:`https://developers.openai.com/codex/hooks`
- Codex 高级配置:`https://developers.openai.com/codex/config-advanced`
- Codex CLI 原生化讨论:`https://github.com/openai/codex/discussions/1174`

---

## 9. Subagent 上下文注入:Codex 的哲学差异与 workaround

### 9.1 为什么 Codex 没有 SubagentStart hook

Codex 的子 agent 设计是**"一次性的带初始 prompt 的子会话"**。`spawn_agent` 工具签名:

- `agent_type` — 选择 role 模板(如 `explorer` / `worker` 或自定义),模板里有**预置的 system-level 指令**
- `message` — 主 agent 写的任务 prompt,子 agent 唯一的初始输入
- `fork_context`(可选) — 是否 fork 父会话历史
- `items`(可选) — 结构化输入(文本/图片/skill 引用)

子 agent 启动后只看 role prompt + message + fork 的历史。**没有任何运行时通道可以往它上下文里注入内容**——这是和 Claude Code 最根本的哲学差异:

> Codex:agent 是 prompt 的函数,没有运行时注入通道
> Claude Code:hook 可以在生命周期任意节点补充上下文

### 9.2 责任归属的转移

| 机制 | Claude Code | Codex CLI |
|---|---|---|
| 系统级约束 | `SubagentStart` hook 注入 `additionalContext` | agent role 模板预置 system prompt |
| 任务特定约束 | 主 prompt + hook 补充 | **全部写进 spawn 时的 `message`** |
| 工具限制 | `disallowedTools` 字段 | Codex sandbox / permissions / profile |
| 运行中修正 | PreToolUse / PostToolUse 拦截 | 主 agent 通过 `send_input` 纠偏 |
| 退出动作 | `SubagentStop` hook 自动 checkout | 子 agent 按 prompt 里的指令自己调 |

Chorus 的 hook 机制本质是**"降低主 agent 的记忆/纪律负担"**。在 Codex 上,这份负担回到主 agent 的 prompt 责任里。

### 9.3 Workaround A:预渲染指令文件(推荐)

既然不能运行时注入,但可以**预先把指令渲染到文件**,再让子 agent 按约定去读。这是 Codex 上最接近 Claude hook 效果的做法。

**模式**:

```
主 agent 要 spawn sub-agent「task-reviewer」:

Step 1. 主 agent 调用 MCP 拿到动态数据
  chorus_create_session({agentName: "task-reviewer-A"}) → sessionUuid
  chorus_get_task({taskUuid}) → 完整 task + AC 列表

Step 2. 主 agent 把指令渲染成文件
  写入 .chorus/briefings/<sessionUuid>.md,内容包含:
    - 当前 sessionUuid / taskUuid
    - 完整的 AC 自检清单
    - 评审流程步骤
    - 退出前必须调用的工具(add_comment / checkout_task)
    - Chorus MCP 工具的精确调用示例(参数已填好)

Step 3. 主 agent 调 spawn_agent,message 极简
  spawn_agent(
    agent_type="chorus-task-reviewer",
    message="Your briefing is at .chorus/briefings/<sessionUuid>.md.
             Read it first, then execute exactly as instructed.
             Your sessionUuid is <sessionUuid>."
  )

Step 4. 子 agent 启动
  - role prompt(预置)→ "你是 Chorus task-reviewer,只读,输出 VERDICT"
  - initial message(主 agent 传的)→ "去读 briefing 文件"
  - 子 agent 第一步:Read .chorus/briefings/<sessionUuid>.md
  - 此时它拿到的上下文等价于 Claude SubagentStart hook 注入的内容
```

**优势**:
- 主 agent 只需维护一份 briefing 模板(可放 skill 里),不必每次重写冗长 prompt
- 动态数据(sessionUuid、taskUuid、project info)一次 MCP 查询即可,避免子 agent 重复查
- briefing 文件可以被调试查看,可复现
- 子 agent 的 initial message 保持短,主 agent 的 token 开销低

**约束**:
- 子 agent 必须"听话"去读——靠 role prompt 的强约束 + message 里的明确指令
- 文件路径约定要稳定(`.chorus/briefings/<sessionUuid>.md`)
- 清理策略:Stop hook 或 SessionStart lazy cleanup 时删除旧 briefing

### 9.4 Workaround B:Skill progressive disclosure

Codex skill 天然就是"文件化指令",子 agent 读 `SKILL.md` 后会加载里面引用的子文档。可以把**评审规程**放进 `task-reviewer` sub-agent 默认绑定的 skill 里,主 agent 只需传入动态参数。

相比 A 的区别:
- A:每次 spawn 渲染新文件(个性化)
- B:规程是静态的(通用化),动态数据仍靠 message 传

最佳实践是**两者结合**:规程放 skill,动态数据放 briefing 文件。

### 9.5 Workaround C:Stop hook 兜底

Codex 支持 `Stop` hook(turn 结束时触发)。主 agent 的 Stop hook 可以:

- 扫 `.chorus/claimed/` 里未 checkout 的 session,强制 `chorus_session_checkout_task`
- 扫 `.chorus/briefings/` 删除过期文件
- 主 agent 一次 turn 里 spawn 的子 agent 如果没正确清理,Stop hook 一次性回收

这是 Codex 上唯一能做到"无条件执行"的清理点,弥补 `SessionEnd` / `SubagentStop` 缺失。

### 9.6 对 Chorus 移植的具体应用

- **PM workflow**:briefing 里预渲染 idea 全文 + 已有 elaboration 历史,子 agent 只关心生成 proposal
- **Developer workflow**:briefing 里预渲染 task + 上游依赖 task 的 files/API 契约,子 agent 不用再查
- **Reviewer workflow**:briefing 里预渲染 task/proposal 全文 + AC 清单 + 往次 comments,子 agent 聚焦评审
- **session 管理**:主 agent 在 spawn 前 `chorus_create_session` 拿 UUID;briefing 文件名用 sessionUuid;Stop hook 做扫尾 checkout

### 9.7 对阶段 1/2 的影响

在路线图(第 6 节)基础上新增:

- **阶段 1.5** — 实现 briefing 模板:每个 sub-agent(`proposal-reviewer` / `task-reviewer`)配一个 `briefing.tmpl.md`,主 agent 在 skill 指令里按模板渲染
- **阶段 2 扩展** — `Stop` hook 加扫尾逻辑,替代 SessionEnd / SubagentStop 的清理职责

---

## 10. 关键更正:Codex subagent 原生支持 skill

**(本节对第 9 节的重要修订。)**

深入查阅 Codex 源码(`codex-rs/core/src/session/mod.rs::spawn_internal`、`codex-rs/core/src/agent/role.rs` 及其 tests)和官方 subagent 文档后,发现 Codex subagent **完整支持 skill**,这大幅改变了移植策略。

### 10.1 事实清单

1. **Subagent 独立 discovery** — `spawn_agent` 启动的子会话会用自己的 config(= 父 config + role layer + spawn-time overrides)重新扫描所有 skill 根目录:`$CWD/.agents/skills` → `$REPO_ROOT/.agents/skills` → `$HOME/.agents/skills` → `/etc/codex/skills` → 系统内置 + 插件贡献
2. **Skill 清单注入 system prompt** — 子 agent 启动时,同一套 `skills_instructions`(name + description + SKILL.md 绝对路径)作为系统指令块注入,与主 agent 格式完全一致
3. **Progressive disclosure 在子 agent 中同样有效** — SKILL.md 全文不预加载,模型按需用 `Read` 工具自己打开;`references/` 和 `scripts/` 按 SKILL.md 指引懒加载
4. **显式触发 `$<skill-name>` 有效** — 主 agent 在 `spawn_agent(message=...)` 里写 "请按 `$develop` 执行",子 agent 自己会识别并读取对应 SKILL.md
5. **Role 层可精细裁剪** — 自定义 role 的 TOML 文件里用 `[[skills.config]] path=... enabled=false` 可关掉特定 skill,避免指令噪声
6. **`skills.config` 会继承** — 官方 subagent 文档明确列出 `skills.config` 为可继承字段:"Optional fields such as ... `skills.config` inherit from the parent session when you omit them."

源码证据:`codex-rs/core/src/agent/role_tests.rs::apply_role_skills_config_disables_skill_for_spawned_agent`。

### 10.2 对 Chorus 移植策略的影响

**第 9 节的 Workaround A(预渲染 briefing 文件)不再是核心依赖**,降级为可选增强。新的推荐模式:

| 内容类别 | 载体 | 理由 |
|---|---|---|
| 静态流程规程(评审步骤、VERDICT 格式、工具调用顺序、AC 检查清单模板) | **Codex skill**(`SKILL.md` + 可选 references) | 子 agent 原生 discovery,progressive disclosure 自动生效,无需主 agent 重复转述 |
| 动态任务参数(`sessionUuid`、`taskUuid`、当前项目 UUID、评审轮次、具体 AC 列表) | **`spawn_agent` message** | 这些数据每次任务不同,必须由主 agent 在 spawn 时传入 |
| 深度定制场景数据(完整的 task 内容 + 上游依赖快照 + 历次 comments) | **可选 briefing 文件** `.chorus/briefings/<sessionUuid>.md` | 如果数据量大、想节省子 agent 的 MCP 往返查询次数时启用 |
| role 级工具限制(READ-ONLY、禁用 Edit/Write/Bash) | **自定义 role TOML** + `sandbox_mode` | 比依赖 prompt 约束可靠 |
| 禁止 reviewer 读取无关 skill(如避免 develop skill 干扰评审判断) | role TOML 里 `[[skills.config]] enabled=false` | 减小子 agent 指令噪声 |

### 10.3 修订后的子 agent 调用模板

以 task-reviewer 为例:

```
spawn_agent(
  agent_type="chorus-task-reviewer",
  message="""
  Review Chorus task {taskUuid} for Chorus session {sessionUuid}.
  Max review rounds: {maxRounds}.
  Follow the $review skill exactly — pay attention to the Turn Budget Rule
  and the VERDICT output format.
  Before exit: chorus_add_comment with VERDICT, then chorus_session_checkout_task.
  """
)
```

这里 `$review` 触发子 agent 读 `review/SKILL.md`,skill 里 300+ 行的评审规程无需重复写进 message。动态参数(taskUuid / sessionUuid / maxRounds)由主 agent 精确传入。

### 10.4 打包建议更新

第 5 节的插件目录结构保持不变,额外增加:

```
chorus-codex-plugin/
├── agents/
│   ├── proposal-reviewer.toml         # Codex role 格式(非 Claude 的 .md)
│   │   └─ 内含 sandbox_mode="read-only" + skills.config 禁用无关 skill
│   └── task-reviewer.toml
```

把原 Claude 的 `proposal-reviewer.md` / `task-reviewer.md` 里的:
- `disallowedTools` → role TOML 的 `sandbox_mode` + 工具白名单
- `criticalSystemReminder_EXPERIMENTAL` → role 的 system prompt 段
- prompt 主体的"RE VIEW PROCEDURE"详细步骤 → 移到 skill 里,只在 role prompt 保留"你的身份 + 必读 skill"核心约束

### 10.5 阶段路线图微调

- **阶段 1** 新增:编写 `agents/*.toml` 定义 2 个 role,并把原评审 prompt 按 10.4 拆分
- **阶段 1.5(briefing 模板)** 降级为可选,仅在发现子 agent MCP 查询次数过多时启用
- 其他阶段不变

### 10.6 为什么这个发现重要

Chorus 原版依赖 `SubagentStart` hook 把 session 指令"塞进"子 agent,是因为 Claude Code 没有 skill 对 subagent 可见性的保证。Codex 从设计上就把 skill 作为所有 agent 共享的"只读指令库",等同于**用 skill 机制替代了 hook 注入**。这是 Codex 对 "agent 是 prompt 的函数" 哲学的自洽实现——运行时注入不存在,但 skill 作为 agent-agnostic 的静态指令层,覆盖了 Chorus hook 90% 的注入需求。

剩下 10% 的"真正需要运行时数据"的场景(session UUID 等),由主 agent 在 `spawn_agent` message 里传或写 briefing 文件解决。

---

## 11. 架构决策:移除 `.chorus/` 本地状态目录

**(本节是对前面 5、6、9 节的实质性简化,后续实现以本节为准。)**

### 11.1 决策

Codex 移植版**不使用** `.chorus/` 目录。所有原 Claude 版为支撑 hook 机制而维护的本地文件系统状态都被删除:

| 原 Claude 版路径 | 用途 | Codex 版处理 |
|---|---|---|
| `.chorus/state.json` | Hook 间共享 owner / roles / session 映射 | ❌ 不需要,由主 agent 靠 MCP checkin 获取 |
| `.chorus/sessions/<name>.json` | SubagentStart 创建、SubagentStop 读取的 session 元数据 | ❌ 不需要,Codex 无 SubagentStart |
| `.chorus/pending/<name>` | PreToolUse:Task 写、SubagentStart 原子 mv 认领的同步文件 | ❌ 不需要,Codex 无 Task hook |
| `.chorus/claimed/<agent_id>` | 被 SubagentStart 认领后的 agent 映射 | ❌ 不需要 |
| `.chorus/briefings/<sessionUuid>.md` | 第 9.3 节的 workaround | ❌ 取消,subagent 直接读 skill + `spawn_agent` message 足够 |
| `.chorus/.mcp_headers.*` | MCP HTTP 调用的临时 header 文件 | ❌ 移到 `/tmp/` 或 `$XDG_RUNTIME_DIR/` |

### 11.2 根本原因

Chorus 原版 `.chorus/` 目录的核心价值是**跨 hook 的状态共享**:

- `SessionStart` hook 写 owner/roles → 后续 hooks 读
- `PreToolUse:Task` 写 pending → `SubagentStart` 原子 mv 认领
- `SubagentStart` 写 session 映射 → `TeammateIdle` / `TaskCompleted` / `SubagentStop` 读

Codex 没有 SubagentStart / SubagentStop / TeammateIdle / TaskCompleted 事件,**跨 hook 状态共享的链路在源头就断了**,保留 `.chorus/` 没有任何消费者。

### 11.3 由此放弃的功能(明确的 limitation)

移植版**不提供**以下自动化能力,改由主 agent 的 skill 规程承担:

- ❌ **子 agent 自动创建 Chorus session** — 主 agent 在 `spawn_agent` 前若需 session,自己调 `chorus_create_session` 并把 UUID 写进 message
- ❌ **子 agent 退出时自动 close session / auto-verify** — 子 agent 在 skill 指令下自己调 `chorus_session_checkout_task` 和 `chorus_submit_for_verify`
- ❌ **TeammateIdle 自动心跳** — 依赖 Chorus 后端给 session 设足够长的 TTL,或主 agent 周期性主动 heartbeat
- ❌ **Session 复用** — 每次 spawn 新 session;如需复用,主 agent 自己追踪 UUID

这些是对 Chorus 原版"hook 保证 session 纪律"能力的**明确取舍**,代价是多 agent 并行场景下主 agent 需更主动地管理 session 生命周期,但收益是:

- **零本地状态** — Codex 版插件纯 stateless,无需任何清理逻辑
- **更简单的 debug** — 所有 session 状态的真相来源(source of truth)都在 Chorus 后端,本地没有中间状态会不一致
- **插件可分发性更强** — 无需 `install-hooks.sh` 创建目录结构,skill + MCP + subagent role 一套就行

### 11.4 对前面章节的修订

**第 5.1 节(插件目录)**:保持不变(原本就没有 `.chorus/`)。

**第 5.2 节(Hooks 安装器)**:仅保留 3 个 hook,全部 stateless,不再依赖 `chorus-api.sh` 的 state_get / state_set 函数:

```
hooks/
├── on-session-start.sh          # 调 chorus_checkin,输出 additionalContext
├── on-user-prompt.sh            # 输出简短工作流提醒(静态文本)
├── on-post-submit-proposal.sh   # matcher 命中 chorus_pm_submit_proposal,提醒 spawn reviewer
├── on-post-submit-for-verify.sh # matcher 命中 chorus_submit_for_verify,提醒 spawn reviewer
└── chorus-mcp-call.sh           # 精简版 MCP HTTP 调用 helper(不含 state 管理)
```

**第 6 节路线图**:

- 阶段 1 不变
- **阶段 1.5(briefing 模板)完全取消**
- 阶段 2 简化:去掉 `on-session-end.sh` lazy cleanup 逻辑(无目录需清理),去掉 Stop hook 兜底扫描逻辑(无 claimed 文件需扫描)

**第 9 节(subagent workaround)**:9.3 Workaround A(briefing 文件)正式作废。9.4(skill progressive disclosure)+ 9.5(Stop hook,仅用于其他用途,非 Chorus 清理)继续作为推荐方案。

### 11.5 对用户的体感影响

| 场景 | Claude Chorus | Codex Chorus(简化版) |
|---|---|---|
| 单人手动完成一个 proposal 全流程 | 无差异 | 无差异 |
| 主 agent 单独完成一个 task | 无差异 | 无差异 |
| 主 agent spawn 一个 reviewer | hook 自动建 session,reviewer 无感 | 主 agent 提前建 session,传 UUID |
| 10 个并行 worker 做一个 proposal 的 tasks | hook 自动管 10 个 session,退出时自动 checkout | 主 agent 自己维护 {worker → sessionUuid} 表,或直接不用 session(可接受:Chorus session 是可选的,只影响 observability,不影响 task 状态) |
| session 泄漏(worker 异常退出没 checkout) | SubagentStop hook 兜底 | 依赖 Chorus 后端 TTL |

**关键洞察**:Chorus session 的核心作用是**多 agent 并行时的 observability 归因**(把 comments / work reports 按 agent 分组)。单 agent 场景下 session 是可选的。因此简化版对绝大多数用户(单 agent 使用)零影响,只对重度并行场景的"谁做了什么"归因能力打折。

这是一个可接受的工程取舍。

---

## 12. 更正日志(Plugin hooks 实装状态)

**2026-04 初步研究**(本文 1–11 节写作时)认为"plugin manifest 不支持声明 hooks"。该结论来自半年前的文档与 GitHub issue,在当前 Codex 0.125.0 版本上需要修正为更精确的描述:

1. **插件声明层** — `.codex-plugin/plugin.json` **可以**写 `"hooks": "./hooks.json"`,插件根目录**可以**放 `hooks.json`。这是官方 scaffold 与社区约定(如 Figma 插件示例)的做法,是"正确的打包方式"。
2. **运行时加载层** — Codex 0.125.0 的 runtime **尚未**把 plugin 内 hooks.json 纳入 hook discovery。本机二进制 strings 扫描显示 `.codex-plugin/plugin.json` 的 `hooks` 字段值仍是字面 `[TODO: ./hooks.json]`,同时 `plugin_hook` / `effective_hook` 等符号不存在。
3. **跟踪 issue** — openai/codex#16430(bug:plugin-local hooks 不被加载)、#17331(feature request:把 hooks 纳入 plugin manifest loading)
4. **移植版的应对**:
   - 按**未来兼容格式**在插件内放 `hooks.json` 与 `.codex-plugin/plugin.json` 的 `hooks` 字段
   - 继续提供 `install-hooks.sh` 作为当前版本的过渡
   - `install-hooks.sh` 增加**自检**:扫描 Codex 二进制符号,若已实装原生 plugin hook 加载则自动跳过(可用 `CHORUS_INSTALL_FORCE=1` 强制安装)
5. **用户视角**:Codex 修复 #16430 后,从 marketplace 安装本插件会自动获得 hooks,`install-hooks.sh` 会自行检测到不再需要

---

## 13. 安装流程实证(2026-04-27)

本节记录在 **Codex 0.125.0 + Linux** 上对已发布插件的端到端安装 / 运行验证。**所有结论都通过二进制字符串扫描和 app-server JSON-RPC 实际返回交叉确认**,不再依赖旧文档或 issue。

### 13.1 `codex plugin` 命令表面

```
codex plugin marketplace <add|upgrade|remove>
```

就这三个子命令。**没有 `codex plugin install` / `list` / `enable`**。这是官方刻意的设计:

- `marketplace add` 只把**来源**注册进 `~/.codex/config.toml` 的 `[marketplaces.<name>]`,不做任何插件安装。
- 单个插件的 *安装 / 卸载 / 启用 / 禁用* 必须走 **TUI `/plugins` 面板**(底层对应 JSON-RPC `plugin/install` / `plugin/uninstall`,配合 `config/value/write` 持久化 `[plugins."<name>@<marketplace>"] enabled = true`)。

### 13.2 规范安装流程(验证通过)

```bash
# 1. 注册 marketplace(可多个来源并存)
codex plugin marketplace add /home/ubuntu/dev/ai-pm

# 2. 进入 TUI,打开插件面板,安装 Chorus
codex
#   > /plugins
#   选 chorus-plugins → chorus → Install
```

安装副作用(验证后的实际产物):

- `~/.codex/config.toml` 追加:
  ```toml
  [marketplaces.chorus-plugins]
  source_type = "local"
  source      = "/home/ubuntu/dev/ai-pm"

  [plugins."chorus@chorus-plugins"]
  enabled = true
  ```
- 插件完整拷贝到:
  ```
  ~/.codex/plugins/cache/chorus-plugins/chorus/0.7.5/
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    ├── hooks.json
    ├── skills/{chorus,idea,proposal,develop,review,quick-dev,yolo}/SKILL.md
    ├── agents/{chorus-proposal-reviewer,chorus-task-reviewer}.toml
    ├── hooks/*.sh
    └── bin/install-hooks.sh
  ```

### 13.3 Skills 命名空间(官方行为)

`skills/list` JSON-RPC 返回显示插件 skill 被加上前缀:

| 插件中路径 | Codex 暴露的 skill name |
|---|---|
| `skills/chorus/SKILL.md`    | `chorus:chorus`    |
| `skills/develop/SKILL.md`   | `chorus:develop`   |
| `skills/idea/SKILL.md`      | `chorus:idea`      |
| `skills/proposal/SKILL.md`  | `chorus:proposal`  |
| `skills/quick-dev/SKILL.md` | `chorus:quick-dev` |
| `skills/review/SKILL.md`    | `chorus:review`    |
| `skills/yolo/SKILL.md`      | `chorus:yolo`      |

所有 skill `scope: "user"`、`enabled: true`。**在 TUI 里输入 `$chorus:develop` 激活**(裸 `$develop` 是否工作取决于是否有同名碰撞;有前缀更可靠)。

### 13.4 MCP 加载(已验证)

`codex mcp list` 输出中 `chorus` 在 `Url` 表里并显示 `enabled`:

```
Name    Url                    Bearer Token Env Var  Status   Auth
chorus  ${CHORUS_URL}/api/mcp  -                     enabled  Unsupported
```

注意:

- `${CHORUS_URL}` / `${CHORUS_API_KEY}` 是插件 `.mcp.json` 中的环境变量占位符;**必须由用户导出**,否则 HTTP 传输层 URL 展开为空,`codex mcp list` 仍报 enabled,但实际请求失败。
- `Bearer Token Env Var` 列为空是因为我们用的是 `headers.Authorization = "Bearer ${CHORUS_API_KEY}"` 的写法;专用的 `bearer_token_env_var` 字段是另一种备选(由二进制 strings 确认)。二者等价。

### 13.5 Marketplace schema(严格版,基于二进制字面量)

```json
{
  "name": "chorus-plugins",
  "interface": { "displayName": "Chorus AI-DLC" },
  "plugins": [
    {
      "name": "chorus",
      "source": {
        "source": "local",
        "path":   "./plugins/chorus"
      },
      "policy": {
        "installation":   "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

实证纠错(相对于早期本文草稿):

- `installation` 枚举只接受 `NOT_AVAILABLE` / `AVAILABLE` / `INSTALLED_BY_DEFAULT`。曾出现过 `"manual"` 这种写法是错的。
- `authentication` 枚举只有 `ON_INSTALL` / `ON_USE`,没有 `apiKey` / `none`。`ON_INSTALL` = 安装时一次性配置(最适合需要固定 API key 的 MCP);`ON_USE` = 每次使用时弹窗(更适合 OAuth / 短期 token)。Chorus 要求长期 bearer,故 `ON_INSTALL`。
- `source.path` 必须是 `./plugins/<name>`(repo 相对)。因此 monorepo 使用 `plugins/<name>` → `../packages/chorus-codex-plugin` 的 symlink。
- `plugin.json` 里 `mcpServers: "./.mcp.json"` 和 `apps: "./.app.json"` 路径**有**前缀点;但 `hooks: "./hooks.json"`(注意 hooks 文件在插件根**没有**前置点,作为路径写法前缀点是 `./`,不是 `.hooks.json`)。二进制内字面匹配:`"mcpServers": "./.mcp.json"`、`"apps": "./.app.json"`、`"hooks": "./hooks.json"`。

### 13.6 "看不到"的排查清单

用户报告 "装完看不到 MCP 和 skills" 的常见真因(按概率排序):

1. **只跑了 `marketplace add`,没进 `/plugins` 做 install** — 最常见。
   - 验证:`ls ~/.codex/plugins/cache/<marketplace>/<plugin>/` 是否存在。
2. **安装完没重启 Codex session** — MCP 服务在会话启动时建立连接,新增 server 不会热刷新给当前 session(`config/mcpServer/reload` 存在但不是默认触发)。
3. **`$skill` 没加命名空间前缀** — 打 `$chorus:develop`,不是 `$develop`。
4. **MCP 环境变量为空** — 服务显示 `enabled` 但连不上。用 `env | grep CHORUS` 自查。
5. **`plugin.json` 有非法字段** — Codex 在启动时会静默跳过 schema 错误的插件。用以下命令探测实际 skills 列表:
   ```bash
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-01-01","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"skills/list","params":{}}' \
     '{"jsonrpc":"2.0","id":3,"method":"plugin/list","params":{}}' \
     | codex app-server
   ```

---

## 14. 最终架构(2026-04-27 重构)

经过方案迭代,最终确定**不把 MCP 注册放进插件**。关键洞察:

### 14.1 为什么 `.mcp.json` 走不通

三条现实约束叠加,让 plugin-local `.mcp.json` 对 Chorus 这种"私有部署 + 用户自持 key"的 SaaS 无法工作:

1. **`${VAR}` 不展开** — Codex 对 `url` / `args` / `http_headers.*` 任何字符串都字面处理。实测写 `url = "http://test-${HOME}/mcp"`,`codex mcp list` 原样回显 `${HOME}`,未替换。
2. **MCP 子进程不继承 shell env** — 实测父进程 `export CHORUS_URL=...` 后启动 codex,MCP 子进程 `process.env.CHORUS_URL` 为 `<unset>`。env 字段里必须显式列出要"注入"的变量,而值本身是 TOML 字面量(`env = { K = "literal" }`),完全不从父进程读取。
3. **`args` / `command` 不支持插件相对路径** — 子进程 cwd = session cwd(用户打开 codex 的目录),不是插件安装目录。没有 `${CODEX_PLUGIN_DIR}` 之类占位符。把 proxy 放在插件里用相对路径启动不可行。

参考:二进制 strings 里有 `= uses unsupported `bearer_token`; set `bearer_token_env_var`.`(拒绝顶级 `bearer_token`),但 **`http_headers = { Authorization = "Bearer cho_xxx" }` 字面量被完全接受**,实测 `codex mcp list` 显示 `Auth = Bearer token`。

### 14.2 最终方案:install script + plugin 分离

**职责划分**

| 组件 | 负责 |
|---|---|
| Codex 插件 (`packages/chorus-codex-plugin/`) | skills + agents + hooks 的**内容**,通过 marketplace 分发 |
| Install script (`public/install-codex.sh`) | marketplace 注册 + `~/.codex/config.toml` 里的 `[mcp_servers.chorus]` 写入 |
| Chorus backend | HTTP streamable MCP endpoint(已有) |

**用户路径**

```bash
# 一行装齐(onboarding 里贴这个):
curl -sSL https://chorus.ai/install-codex.sh | bash

# 然后:
codex          # /plugins → chorus → Install
```

**Install script 做的 4 件事**

1. `codex --version` 探测
2. `codex plugin marketplace add <chorus-repo-url>`(幂等,已存在则跳过)
3. 交互或 `CHORUS_URL`/`CHORUS_API_KEY` env 读取凭据
4. idempotent 写入 `~/.codex/config.toml`:
   ```toml
   [mcp_servers.chorus]
   url = "<user-provided-url>"

   [mcp_servers.chorus.http_headers]
   Authorization = "Bearer <user-provided-key>"
   ```
   清理正则 `^\[mcp_servers\.chorus(?:\.[^\]]+)?\][^\[]*` 同时匹配主表和子表,key 轮换干净。

### 14.3 砍掉的东西

相对于 13 节的设想,最终版不再需要:

- `packages/chorus-codex-plugin/.mcp.json` — 删
- `packages/chorus-codex-plugin/bin/install-hooks.sh` — 删(hook 的自动加载限制独立存在,但不在本次范围)
- `plugin.json` 里的 `"mcpServers": "./.mcp.json"` 字段 — 删
- stdio proxy(Node 实现的 stdio↔HTTP 代理) — 不需要了,因为直接用 Codex 原生 HTTP MCP 传输

### 14.4 Trade-offs

**放弃了什么**

- "装插件即可用"的一键体验 — 变成"跑一次安装脚本 + `/plugins` install"两步
- 插件完全自包含 — 现在依赖外部 `install-codex.sh` 分发

**换来了什么**

- 简单、透明、零运行时依赖(Node proxy 都不要)
- 直接用 Codex 的 HTTP MCP 传输,稳定且社区验证过
- API key 轮换一条命令(`install-codex.sh` rerun)
- 当 Codex 未来解锁 `${VAR}` 展开 / env 透传,迁移回 plugin-local `.mcp.json` 只需恢复删掉的文件
- 对 onboarding UX 无损 — `curl | bash` 比"让用户手动编辑 `~/.codex/config.toml`"体验好得多,且与 Homebrew / nvm / pyenv 等生态做法一致

### 14.5 未来 Codex 解锁路径

如果 Codex 某个版本加上以下任一能力,可以把 MCP 注册并回插件:

1. `.mcp.json` 支持 `${CHORUS_URL}` / `${CHORUS_API_KEY}` 插值(最简单的改法)
2. MCP 子进程默认继承父进程 env(停止过滤)
3. `command` / `args` 支持 `${CODEX_PLUGIN_DIR}` 占位符(让 stdio proxy 可行)
4. plugin manifest 增加 `postInstall` hook(安装时跑自定义脚本写 config.toml)

目前追踪的相关 issue:openai/codex#16430(plugin-local hooks)、#17331(plugin manifest loading)。

---

## 15. Install script 实施细节(2026-04-27)

### 15.1 零外部依赖

`public/install-codex.sh` 是纯 `bash + awk + POSIX coreutils`,不依赖 Python/jq/node(除了 `codex` 本身)。实现时先用 `python3` 做 TOML 段处理,被指正后改成 awk,覆盖 macOS(BSD awk)和 Linux(GNU awk)。

### 15.2 五步流程

1. **Check codex** — `command -v codex` 存在即 pass;打印 `codex --version`
2. **Register marketplace** — `codex plugin marketplace add <url>`。grep `^\[marketplaces\.chorus-plugins\]` 检测已存在则跳过
3. **Collect credentials** — 优先 `CHORUS_URL` / `CHORUS_API_KEY` env;否则交互(`stty -echo` 读 key 不回显);通过 `/dev/tty` fallback 支持 `curl | bash` 场景
4. **Write [mcp_servers.chorus]** — awk 清理 `^\[mcp_servers\.chorus(\..*)?\][^\[]*` 主表+子表,然后 append 字面量 URL + `[mcp_servers.chorus.http_headers] Authorization = "Bearer <key>"`。`chmod 600` 保护 secret
5. **Install hooks** — 见 15.3

### 15.3 Hooks 装配(步骤 5)

Codex 0.125.0 **不加载 plugin-local `hooks.json`**,必须装到 `~/.codex/hooks.json` 或 `~/.codex/config.toml [hooks]`(二选一,装两份会报 `loading hooks from both <A> and <B>`)。二进制里明确字符串:

```
hooks.json/config.toml
failed to parse hooks config
loading hooks from both <A> and <B>/; prefer a single representation for this layer
```

而且 hooks 由 feature flag 控制 — 二进制里的 feature 白名单包含 `codex_hooks`,必须在 config.toml 里显式:

```toml
[features]
codex_hooks = true
```

**实施策略**

- 定位插件安装目录:`$CODEX_HOME/plugins/cache/chorus-plugins/chorus/<latest-semver>/hooks/`(用 `ls -1 | sort -V | tail -1` 选最新版)
- 如果 `~/.codex/hooks.json` 不存在,或已是 chorus-owned(`grep -q "chorus-plugins/chorus" $HOOKS_JSON`)→ 直接写 4 个 hook 条目,`command` 字段全部使用绝对路径指向 cache 里的脚本
- 如果已存在且**不是** chorus-owned → 打印警告,不覆写,提示用户手动处理(避免踩用户自己的 hooks)
- 对 `[features] codex_hooks = true`:三种情况幂等处理(不存在 → append;`[features]` 已存在但缺 `codex_hooks` → 用 awk 在 header 后插入;已启用 → 跳过)

**为什么不放 config.toml 的 `[hooks]` 段**

技术上都行,但独立 `hooks.json` 更简单:
- 清理只需要 `rm ~/.codex/hooks.json`,不会误伤 config.toml 其他段
- chorus 版本升级时 hooks 内容会变,独立文件可以整体重写,不需要在混合 TOML 里做 section-level diff
- Codex 官方示例(plugin manifest 里 `"hooks": "./hooks.json"`)也默认用 JSON 格式

### 15.4 Hook 事件支持现状

Codex 0.125.0 的 hook 事件枚举(从二进制 strings 精确取):

| Event            | 何时触发                      | Chorus 使用 |
|------------------|-------------------------------|---|
| `SessionStart`   | session 启动/resume/clear    | ✅ checkin |
| `UserPromptSubmit` | 用户发送 prompt 之前         | ✅ 注入 reminder |
| `PreToolUse`     | 工具调用前(可阻止)           | 未用 |
| `PostToolUse`    | 工具调用后                    | ✅ 提案/任务提交后 spawn reviewer |
| `PermissionRequest` | 权限请求时                 | 未用 |
| `Stop`           | turn 结束前                   | 未用(需要 SubagentStop 才有意义) |
| `Notification`   | 系统通知                      | 未用 |

注意 `SubagentStop` / `TeammateIdle` / `TaskCompleted` 这些 Claude Code 有的事件 Codex 暂无,见 11 节的 stateless 决策。

### 15.5 用户 UX

```bash
curl -sSL https://chorus.ai/install-codex.sh | bash
# → 5/5 steps, all green
codex
# > /plugins → chorus-plugins → chorus → Install
# skills + agents + hooks + MCP 全部工作
```

如果用户先安装了插件再跑 installer,hooks 也一样能装(installer 会从 cache 读到脚本路径);
如果用户先跑 installer 再装插件,installer 的 step 5 会打印 warning "Plugin not yet installed — skipping hooks. Run Codex TUI /plugins → Install first, then re-run this installer."

### 15.6 bash 3.2 兼容性(macOS system bash)

macOS 直到今天的 `/bin/bash` 仍然是 3.2.57(2007 年版本,Apple 出于 GPLv3 许可问题一直没升)。
`curl | bash` 场景下 shebang 解析到的也是这个版本,所以 `install-codex.sh` **必须**能在 bash 3.2 上跑。

#### 允许 / 禁用清单

禁用(bash 4+ 专属):

- `${VAR,,}` / `${VAR^^}` 大小写转换(用 `tr '[:upper:]' '[:lower:]'` 代替)
- `declare -A` / `typeset -A` 关联数组(用多个普通变量或 `sed`/`awk` 代替)
- `mapfile` / `readarray`(用 `while IFS= read -r line` 代替)
- `&>file` 合并重定向(写 `>file 2>&1`)
- `|&` 管道(写 `2>&1 |`)
- `;;&` case 穿透
- `coproc`

允许(3.2 原生):

- `[[ ]]`, `[[ =~ ]]` regex 匹配
- `$'\033[...m'` ANSI 字面量
- `${var:-default}`, `${var:+value}`, `${var#prefix}`, `${var%suffix}`
- 函数 `name() { … }`
- `printf '%s' "$var"`
- `$(…)` 命令替换(嵌套也 OK)

#### 回归测试:`public/test-install-codex.sh`

参考 `public/chorus-plugin/bin/test-syntax.sh` 的模式,覆盖 4 个维度:

1. **静态扫描** — grep 出上面禁用清单的所有命中
2. **`bash -n` 解析** — 用 bash 3.2 做语法检查
3. **端到端 dry run** — 用 fake `codex` stub + 隔离的 `CODEX_HOME`,验证生成的 `config.toml` 含 `[mcp_servers.chorus]`、literal URL、literal `Authorization = "Bearer …"`、`chmod 600`
4. **幂等重跑** — 用轮换的 key 再跑一次,验证只有一个 mcp 块、只有一个 http_headers 块、旧 key 被清掉

#### 运行

Linux (需要本地编译的 bash 3.2 做准确回归):

```bash
# 一次性:编译 bash 3.2
cd /tmp && curl -sSLO https://ftp.gnu.org/gnu/bash/bash-3.2.tar.gz \
  && tar xf bash-3.2.tar.gz && cd bash-3.2 \
  && ./configure --without-bash-malloc --disable-nls && make -j4
# 路径固定为 /tmp/bash32-build/bash-3.2/bash(test 脚本会自动检测)

# 跑回归
bash public/test-install-codex.sh
# → 17 passed, 0 failed
```

macOS:

```bash
bash public/test-install-codex.sh
# 系统 /bin/bash 就是 3.2.57,test 脚本会自动用它
```

显式指定 bash 路径(CI):

```bash
BASH32=/custom/path/bash-3.2 bash public/test-install-codex.sh
```

#### 当前状态(2026-04-27)

17/17 全绿,两个 bash 版本(3.2.0 自建 + 当前系统 bash)都通过。

### 15.7 砍掉 UserPromptSubmit hook(2026-04-28)

**决策**: 从 Codex 插件里完全移除 `UserPromptSubmit` hook(源码、installer、用户 hooks.json 三处同步清理)。

**原因**:

- `UserPromptSubmit` 原本设计是每次用户按回车时注入简短工作流提醒(会话状态、未读通知等)。
- Codex TUI 0.125 会把 hook 的 `additionalContext` **原样 echo 到 status 区**(`hook context: …` 前缀),视觉上非常嘈杂——每次发言都闪一次。
- 注入的内容本质是 reminder,不是实时状态——`SessionStart` hook 一次性注入 checkin 已经覆盖了主要场景;未读通知靠 skill 里的 `chorus_get_notifications` 工具显式拉即可。
- 保留它的边际收益 ≪ 它对 UX 的负面冲击。

**清理清单**:

- `packages/chorus-codex-plugin/hooks.json` — 去掉 UserPromptSubmit 节
- `packages/chorus-codex-plugin/hooks/on-user-prompt.sh` — 删
- `public/install-codex.sh` — 生成 `~/.codex/hooks.json` 时不再写 UserPromptSubmit
- `~/.codex/plugins/cache/chorus-plugins/chorus/<ver>/` — 同步删
- `~/.codex/hooks.json` — installer 重跑覆盖

剩余 hook: `SessionStart`(一次性 checkin)+ `PostToolUse`(submit_proposal / submit_for_verify → reviewer 引导)。
