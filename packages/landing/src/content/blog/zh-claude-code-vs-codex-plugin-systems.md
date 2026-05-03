---
title: "插件开发者视角看 Claude Code 和 Codex"
description: "同一个插件在 Claude Code 和 Codex 上各写一版。一个装完就跑，一个得陪 harness 一路缝缝补补。"
date: 2026-05-03
lang: zh
postSlug: claude-code-vs-codex-plugin-systems
---

# 插件开发者视角看 Claude Code 和 Codex

给 [Chorus](https://github.com/Chorus-AIDLC/Chorus) 写 CLI 插件的时候，我给 Claude Code 和 Codex CLI 各写了一份。两份干同一件事，但写起来完全不在一个量级。

两边看起来都提供了"插件 + 钩子 + MCP + 子代理"这一套，实际落地差别非常大。这篇按 9 个维度各打 0-5 分，聊聊插件开发者在两边分别能做什么、会卡在哪。

> 基准版本: Claude Code `2.1.126`，Codex CLI `0.128.0`。两边都在快速迭代，后面版本应该会修掉其中一些问题。

Claude Code 那版我之前写过实现细节: [为 Claude Code Agent Teams 构建插件](/blog/building-claude-code-plugin-for-agent-teams)。这篇重点在 Codex 踩过的坑，以及这些坑给插件开发者意味着什么。

---

## 一、安装这一步走多远

从用户角度想: 他听说有 Chorus 这个东西，到他的 CLI 真的能调 Chorus 工具，中间要走几步。

Claude Code 那边用户进 TUI 输两条 slash command 就完事:

```
/plugin marketplace add Chorus-AIDLC/Chorus
/plugin install chorus@chorus-plugins
```

插件自己带 `.mcp.json` 声明了 Chorus 的 MCP server，里面引用了两个环境变量 `${CHORUS_URL}` 和 `${CHORUS_API_KEY}`，用户在 shell 里 export 一下，重启 Claude Code，所有 `chorus_*` 工具立刻可见。

Codex 这边同样是进 TUI，但**没有等价的 `/plugin install` slash command**。官方路径是进 `/plugins` 面板、用方向键挑到插件、手动点 Install。对插件开发者来说意味着没法让用户"复制两行命令装好"，至少得手动操作一次 UI。

我没接受这个现实，写了个 Bash installer 把该干的活都干掉:

1. 注册 marketplace
2. 交互式问用户要 `CHORUS_URL` 和 `CHORUS_API_KEY`
3. 往 `~/.codex/config.toml` 里写 MCP 配置
4. **关键一招**: 直接写 `[plugins."chorus@chorus-plugins"] enabled = true` 到 config.toml，绕过 TUI 让 Codex 下次启动就把插件算作已启用
5. 把钩子手动装到用户全局配置里（下一节细说原因）
6. 开 `[features] codex_hooks = true`

用户体感是 `curl | bash` 一把过，和 Claude Code 看起来差不多。代价是我在 Codex 外面脏改配置文件硬凑出来这个效果，脚本脆得很。只要 Codex 任何一个版本改了 `[plugins."xxx"] enabled = true` 的语义，我的脚本就要重写。

脚本还有一堆细节: 必须兼容 macOS 自带的 Bash 3.2（不能用关联数组、`${VAR,,}`、`mapfile` 这些 Bash 4 的东西），因为 Claude Code 和 Codex 都用系统 bash 跑钩子，在 macOS 上就是 3.2。

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 二、把 MCP server 一起塞进插件

这一节是整个 Codex 插件体验里最让人头大的一块。

先说 Chorus 的需求: agent 和 Chorus 之间的所有交互接口都是 MCP 工具。用户装插件应该等于装 MCP，不该让他们手动改任何配置文件。

Claude Code 的 `.mcp.json` 长这样:

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

运行时 harness 会把 `${CHORUS_URL}` 和 `${CHORUS_API_KEY}` 替换成环境变量的值。插件作者只要声明这份文件，剩下的交给 harness。

Codex 这边同样的思路走不通，两个原因:

第一，**Codex 的 `~/.codex/config.toml` 里所有字段都是字面量，不做任何变量展开**。你写 `url = "${CHORUS_URL}"`，Codex 就真的拿 `${CHORUS_URL}` 这个字符串当 URL 去发请求。

第二，HTTP MCP 的 Bearer token 只有两种写法:

```toml
# 写法 A: 让 Codex 从环境变量读
bearer_token_env_var = "CHORUS_API_KEY"

# 写法 B: 明文 token 直接写在插件里
[mcp_servers.chorus.http_headers]
Authorization = "Bearer cho_xxxxxxx"
```

写法 A 看起来干净，但用户在 macOS 上如果是从 Launchpad / Dock 图形界面启动 Codex，**根本读不到你 shell rc 里 export 的环境变量**。对大部分真实用户来说这条路直接不通。

写法 B 等于要求插件明文带着用户的 token 分发，这不可能。

我最终只能把 MCP 从插件里剥出来，让 installer 在运行时把 `[mcp_servers.chorus]` 写进用户的 `config.toml`，用 awk 保证幂等（重跑能识别出老段整块替换），token 用 `chmod 600` 保护。也就是 **Codex 的插件 manifest 里的 `mcpServers` 声明对 HTTP MCP 基本没用**，只能绕过 harness 自己去写配置文件。

我理解 Codex 这么设计是想让配置文件里不出现明文 secret、逼用户走环境变量。出发点没问题，但它同时也假设了用户的 shell env 是可靠入口，macOS GUI 场景直接戳破这个假设。在 Codex 补 `${VAR}` 展开、或者给插件一种声明"运行时向用户要 secret"的能力之前，HTTP MCP 的插件分发都会长成现在这样: 一半靠 manifest、一半靠旁路脚本。

**Claude Code: 5 / 5 · Codex: 1 / 5**

---

## 三、钩子能不能跟着插件走

这个坑耗了我整整一天去测试、读源码、翻 issue。

场景很简单。Chorus 的插件需要三个钩子: session 启动时调 `chorus_checkin` 把当前 agent 的身份和待办注入上下文；agent 提交 proposal 后触发 reviewer；agent 提交 task 后触发另一个 reviewer。钩子理所应当跟着插件一起交付。

Claude Code 那边就是"理所应当"。插件里放一份 `hooks/hooks.json`，里面用 `${CLAUDE_PLUGIN_ROOT}` 指向插件自己的脚本，harness 加载插件时自动注册，搞定。

Codex 这边我也是这么做的: 插件里放一份 `hooks.json`，manifest 里 `hooks` 字段指过去。我参考的是 Codex 官方插件 example，目录里明摆着有这个文件。装完看 `/plugins` 面板，钩子显示已就位。但 session 启动时钩子**根本不跑**。

为了先确认 hook JSON 本身写对了，我把它原样复制到 `~/.codex/hooks.json`，立刻生效。既然在全局能跑，那肯定是我插件那边哪里没写对。

接下来就是典型的自我怀疑循环。换了几种 hook 命令（绝对路径、相对路径、简单的 `echo` 测试）、改了 matcher、反复 reinstall 插件、换版本号、试了不同的 `hooks` 字段写法、对着 example 目录逐字比对 manifest。每一轮都失败，然后换个假设再来。大半天就这么过去了。

最后实在想不出还能怎么改，去 Codex 仓库搜 issue，找到 [#16430](https://github.com/openai/codex/issues/16430)。另一个开发者踩了同样的坑。issue 里把现状说清楚了: plugin manifest 解析器只认 `skills` / `mcpServers` / `apps` 三个字段，不认 `hooks`；钩子发现逻辑只扫 config layer 下的 `hooks.json`，不扫已安装插件的根目录。manifest schema 和 example 目录暗示的能力，这个版本根本没实现。issue 至今 Open。

读完那一刻才意识到，**官方文档对"插件里的 hooks.json 会不会被加载"从头到尾只字未提**。我是照 schema 和 example 倒推出"应该能用"，真相是它就没做。我整整大半天的自我怀疑，是在排查一个根本不存在的功能。

结论: Codex 插件能挂 skill、能塞 MCP，但**没法真正交付钩子**。插件开发者要么接受钩子功能不可用，要么把钩子手动写进用户的全局 `~/.codex/hooks.json`。

我选了后者: installer 负责把钩子写进用户的 `~/.codex/hooks.json`，还得额外装一层 wrapper 脚本兜底 plugin cache 路径会随版本变化的问题。能跑，但远谈不上健壮——用户手动改了那份文件、装了另一个也写钩子的插件、卸载后没清理，任何一条都是故障。这些在 Claude Code 上都是 harness 自动管理的，插件开发者连想都不用想。

**Claude Code: 5 / 5 · Codex: 0 / 5**

---

## 四、钩子事件够不够用

Chorus 的功能之一是多 agent 并行工作时的可观测性: 用户起 5 个子代理并行写代码，要在看板上看到谁在做哪个任务、做到哪一步、有没有心跳。这件事落到插件层，需要 harness 把 agent 的整个生命周期暴露成钩子事件。

Claude Code 这边钩子事件很全:

| 事件 | Chorus 用来做什么 |
|---|---|
| `SessionStart` | 调 `chorus_checkin`，把身份和待办注入上下文 |
| `UserPromptSubmit` | 轻量状态提醒（不发网络请求） |
| `PreToolUse:Task` | 捕获子代理名字，写到 `.chorus/pending/<name>` |
| `SubagentStart` | **核心**: 创建或复用 session、把 session UUID 和工作流指令注入子代理 |
| `TeammateIdle` | 发 session heartbeat 保活 |
| `TaskCompleted` | 按 task 标签自动 checkout |
| `SubagentStop` | 关 session、查询下游解锁的任务反馈给 Team Lead |
| `SessionEnd` | 清理 `.chorus/` 目录 |

里面最关键的是 `SubagentStart`: 在子代理真正开始工作之前，插件可以先建好 session、把 UUID 直接写进它的上下文。可观测性由 harness 保证，不用让 agent 自己记得去调 MCP 汇报。

Codex 这边的钩子只有 6 个: `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`Stop`。**整个 agent 生命周期相关的事件都没有**。

具体后果:

- 主代理调 `spawn_agent` 之后，子代理的存在对插件完全不可见。没法自动建 session、没法自动 checkin task、没法发 heartbeat、没法自动 checkout。
- 唯一的替代是让主代理**在 prompt 里自我提醒**。我在 `$yolo` skill 的正文里写满了"spawn 前请 `chorus_create_session`、把 `sessionUuid` 塞进子代理初始 prompt、等子代理跑完记得 `close_agent` 同时 `chorus_close_session`"这种纪律。LLM 大部分时候能遵守，偶尔漏一步就是一个泄漏的 session 挂在那里。
- `UserPromptSubmit` 我原本用来做轻量状态提醒，后来砍了。Codex TUI 会把钩子吐出的 `additionalContext` 用 `hook context:` 前缀 echo 到状态区，每次用户发言都刷一屏，噪音比价值大。这是一个 harness 的 UI 选择直接影响钩子实用性的例子。

session 自动追踪在 Codex 上做不出来。

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 五、子代理能不能当一等公民

Chorus 有两个 reviewer agent。Proposal 提交后自动跑 proposal-reviewer，task 提交后自动跑 task-reviewer。要求它们是**只读**的（不能 Edit、Write、Bash），输出必须以 `VERDICT: PASS / PASS WITH NOTES / FAIL` 三选一结尾。

Claude Code 上这就是个标准功能。插件里放一份 `agents/proposal-reviewer.md`:

```yaml
---
description: "Review submitted Chorus proposals for quality"
model: inherit
maxTurns: 20
disallowedTools: [Agent, Edit, Write, NotebookEdit, Bash]
---
```

文件正文就是 reviewer 的 system prompt。主代理调一下 `Task(subagent_type: "chorus:proposal-reviewer")` 就能起来。工具权限、模型选择、轮次上限全都在 harness 层强制。

Codex 上就难了。它的 `spawn_agent` 工具只认四个内置 role: `default` / `explorer` / `worker` / `awaiter`。**插件 manifest 里没有注册新 role 的字段**。我最早想当然地以为 skill 目录下那个 `agents/openai.yaml` 能注册新 role，实测 `spawn_agent(agent_type="chorus-proposal-reviewer")` 直接报 `unknown agent_type`，翻完文档和 Rust 源码才确认 `openai.yaml` 只是给 TUI 的 `/plugins` 面板显示用的元数据。

最后绕了一圈: 把 reviewer 当成一个 skill，spawn 的时候用内置的 `default` role，通过 `items` 数组把 skill 内容塞进去:

```
spawn_agent(
  agent_type="default",
  items=[
    { type: "skill", path: "chorus:chorus-proposal-reviewer" },
    { type: "text",  text: "Review proposal <uuid>. Post VERDICT." }
  ]
)
```

能跑，但丢了三样东西:

1. **工具权限隔离**: 既然是 `default` role，子代理什么工具都能用。我只能在 SKILL.md 里硬写"严禁修改任何文件、严禁运行 Bash"，靠 LLM 自觉。几次 reviewer 手贱顺手改代码的事故都是这么来的。
2. **轮次上限**: harness 层根本没这东西。只能在 prompt 里写"turn budget rule: 剩余 ≤3 轮时立刻提交评论"。
3. **结构化输出约束**: `VERDICT: PASS` 这个字面量是主代理用正则 `^VERDICT: (PASS|PASS WITH NOTES|FAIL)$` 匹配的。但 LLM 特别喜欢自创 "APPROVE"、"OK"、"✅" 这种同义词。我只能在 SKILL.md 和 hook 注入的 additionalContext 里反复强调必须三选一，然后主代理严格匹配，不匹配一律当 FAIL 处理。

还有个 Codex 独有的暗雷: **每条根线程最多 6 个并发子代理，`completed` 状态不释放槽位**，必须显式 `close_agent(id)`。`$yolo` 这种长链路连续 spawn reviewer 和 worker，第 7 次一定爆 `agent thread limit reached`。每个 `spawn_agent` 后面必须配一个 `close_agent`，这条纪律又得写进 skill 的正文让 LLM 记住。

一句话总结: Claude Code 上是 harness 保证的行为，在 Codex 上是 prompt engineering 项目。

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 六、Skills

这一节是整个对比里 Codex 终于站得住的一块。

两边机制差不多: 一个 `SKILL.md` 文件，frontmatter 声明元数据，正文是给 agent 看的操作指引。都支持命名空间（`chorus:develop`），都支持用户手动触发和模型自主触发两种路径。

差异在 frontmatter 的控制位。Claude Code 的 skill 能配 `allowed-tools`（限制可用工具）、`context: fork`（新起一个 context 跑 skill）、`disable-model-invocation`（只允许用户手动触发）、`model`（指定模型）。Codex 的 frontmatter 少一些，但够用。

我把 Chorus 的 7 个 skill 从 Claude Code 移植到 Codex，一天内完成。只改了三处:

1. 触发词从 `/chorus:develop` 换成 `$chorus:develop`
2. 正文里提到的 `Task` 工具全换成 `spawn_agent`
3. 原本依赖 hook 自动 spawn reviewer 的部分改成 advisory context，让主代理显式 spawn

**Claude Code: 5 / 5 · Codex: 4 / 5**

---

## 七、配置里能不能写变量

从插件开发者角度，这条决定了插件是不是真"写一次多机通用"。

Claude Code 给了两种变量:

- `${CLAUDE_PLUGIN_ROOT}`: 在钩子配置里展开成插件安装路径
- `${VAR}`: 在 MCP 配置里展开成环境变量

钩子子进程还能继承 shell env。插件作者基本不用操心路径和 secret。

Codex 这边三条限制叠在一起:

- `~/.codex/config.toml` 所有字段都是字面量，不做任何展开
- `~/.codex/hooks.json` 里的 `command` 字段必须是绝对路径，像 `${CODEX_PLUGIN_DIR}` 这样的变量不支持
- Plugin cache 路径带 semver（`$CODEX_HOME/plugins/cache/chorus-plugins/chorus/<semver>/`），每次版本升级路径就变

三者合起来意味着"插件安装路径"这件事 harness 给不出一个稳定的引用。插件作者要么每次升级重写 `hooks.json`，要么像前一节提到的那样自己多塞一层间接层。

Claude Code 这块是 0 行代码，Codex 这块是 Bash installer 里一整段逻辑加一个常驻 wrapper 脚本。

**Claude Code: 5 / 5 · Codex: 1 / 5**

---

## 八、Marketplace

两边都是 JSON 清单放 GitHub 仓库。

Claude Code 的 `.claude-plugin/marketplace.json` 支持 `source` 指向仓库内路径、别的 GitHub repo、或任意 Git URL。`/plugin marketplace update` 热更。

Codex 的 `.agents/plugins/marketplace.json` 多了两类 policy: `installation` 三档（`AVAILABLE` / `INSTALLED_BY_DEFAULT` / `NOT_AVAILABLE`）和 `authentication` 两档（`ON_INSTALL` / `ON_USE`）。语义设计比 Claude Code 规整，考虑了更多场景。我用 `INSTALLED_BY_DEFAULT` 弥补了 "没有 CLI install 命令" 的问题，首次启动会自动装入。

格式都够用。差异在生态: Claude Code 社区已经有一批第三方插件，Codex 这边还基本只有官方 skill 样例，插件开发者几乎没有公开先例可参考。

**Claude Code: 4 / 5 · Codex: 3 / 5**

---

## 九、文档和调试

**插件开发者遇到"我按文档写了但 harness 就是不认"的时候该怎么办**，这一条是写这篇文章最有感触的。

Codex 这边第三节那种惨痛的踩坑经历背后，其实有一个让人意外的好处: **代码完全开源**。文档不齐没关系，去仓库里翻 Rust 源码就能把行为坐实。我后面一堆结论（`spawn_agent` 只接受四个内置 role、`~/.codex/config.toml` 不展开变量、`completed` 子代理不释放线程槽位）都是靠读 `codex-rs/` 下的代码才敢下断言的。文档跟不上进度，但真相至少是可读的。

Claude Code 反过来。官方文档写得不错，钩子事件字段、`additionalContext` 的注入目标、MCP 的变量展开规则都交代得清楚。但代码不开源，文档没覆盖到的行为就只能靠猜和试。好在前阵子 Claude Code 有一次"开源"的契机，社区里已经能找到比较完整的源码，很多之前只能猜的细节现在能验证了。靠官方 + 这份"意外可得"的代码，Claude Code 这边的调试体验反而从模糊变清晰。

开源和文档两件事上，两边各赢一半。Claude Code 文档更齐整，Codex 源码随时可读。实际做插件的时候，这两种资源的价值是互补的。

**Claude Code: 4 / 5 · Codex: 4 / 5**

---

## 总分

| 维度 | Claude Code | Codex |
|---|---:|---:|
| 安装 | 5 | 2 |
| MCP 集成 | 5 | 1 |
| 钩子交付 | 5 | 0 |
| 钩子事件覆盖 | 5 | 2 |
| 子代理 | 5 | 2 |
| Skills | 5 | 4 |
| 配置变量 | 5 | 1 |
| Marketplace | 4 | 3 |
| 文档和调试 | 4 | 4 |
| **合计** | **43 / 45** | **19 / 45** |

---

## 总结

Claude Code 的插件系统是把**多 agent 协作**当一等公民设计的: `SubagentStart` 注入到子代理、`TeammateIdle` 能发心跳保活、frontmatter 里的 `disallowedTools` 是 harness 级的约束。这些能力都是给插件开发者干活用的基础设施，在上面搭复杂的协作逻辑不用自己造轮子。

Codex 的插件系统还在早期: 三个扩展点（插件、钩子、MCP）已经开出来，但缺失的那一块恰好是真正支撑多 agent 协作需要的部分。钩子交付不工作、子代理只有四个内置 role、配置不展开变量、生命周期事件缺席，每一项单独看都是几百行 Rust 能补上的事情，叠在一起就是目前这副"很多事做不到、能做的都得陪个 installer 脚本"的样子。

如果你正在考虑写 CLI 插件:

1. **纯 MCP 集成**: Claude Code 写完能直接装。Codex 得陪一个 installer 脚本。
2. **依赖多 agent 观测**（session 生命周期、心跳、任务编排）: Codex 现阶段做不了。
3. **纯 skill 集合**: 两边差不多。
4. **需要隔离的只读子代理**: Claude Code 的 `agents/*.md` frontmatter 直接起飞。Codex 现阶段只能靠 prompt 软约束，别指望 harness 做权限隔离。
