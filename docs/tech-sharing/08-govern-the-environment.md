# 治理环境，而不是提示词

## Govern the Environment, Not the Prompt

> 本文源码基线：`docs/tech-sharing` 分支，2026-08-16。源码位置以符号名为准，行号用于帮助定位。

## 摘要

当 coding agent 能调用 shell、修改文件、访问网络并持续运行时，把“请谨慎”写进 system prompt 不是治理。Prompt 可以塑造行为，却不是不可绕过的执行边界。本文提出一个面向 coding agent 的分层治理架构：identity/authority、placement/isolation、resource envelope、lifecycle/recovery、commit/evidence 五层执行边界，分别落到 Chorus control plane、vendor runtime、OS/container 与 repository/CI 等不同 reference monitor。核心方法不是声称存在一个统一 policy plane，而是为每条 policy 建立 coverage matrix：谁强制、覆盖什么、怎样绕过、留下什么证据、失败后如何恢复。源码分析表明，Chorus 已能强制经过其 MCP/API、daemon routing 与工作流状态机的动作，并提供 cwd 定向、并发上限、interrupt/reconcile、Activity、turn 与 token 证据；但 shell、filesystem、network、secret 与 merge policy 的最终强制仍依赖 runtime、OS/container 和 repository。本文将现状分为“已有”“部分具备”“暂不宣称”三档，并由缺口导出 vendor-neutral policy schema、capability negotiation、pre-start execution envelope、运行中 quota/kill-switch 与 policy decision log 的路线图。环境治理的质量不是最强一层的能力，而是最薄弱且可绕过路径的实际覆盖。

## Abstract

When coding agents can invoke shells, mutate files, access networks, and run continuously, adding “be careful” to a system prompt is not governance. Prompts can shape behavior, but they are not non-bypassable execution boundaries. This paper presents a layered governance architecture for coding agents with five execution boundaries: identity and authority, placement and isolation, resource envelope, lifecycle and recovery, and commit and evidence. Enforcement is distributed across the Chorus control plane, vendor runtimes, the operating system or container, and repository or CI controls. The central method is not to claim a unified policy plane, but to maintain a coverage matrix for every policy: enforcement point, covered action, bypass path, evidence, and recovery. Source analysis shows that Chorus can enforce actions traversing its MCP/API, daemon routing, and workflow state machines, and can provide cwd targeting, concurrency caps, interrupt and reconciliation paths, and Activity, turn, and token evidence. Final enforcement over shell, filesystem, network, secrets, and merge policy still belongs to runtime, OS/container, and repository layers. We classify current capabilities as present, partial, or not claimed, then derive a roadmap for a vendor-neutral policy schema, capability negotiation, pre-start execution envelopes, runtime quotas and kill switches, and policy decision logs. Governance quality is determined not by the strongest layer, but by the weakest bypassable path.

---

## 1. 命题：Prompt 是建议，Environment 才能形成边界

### 1.1 行为指令不等于强制

一个 prompt 可以要求 Agent：

- 只读文件，不要修改；
- 不要访问公网；
- 修改前先征求同意；
- 不要输出 secret；
- 测试通过后才能提交；
- 不要自行 merge。

这些要求有价值，但其执行者仍是被治理的 Agent 自己。模型可能误解、忘记、被更晚的内容覆盖，或通过一个未被 prompt 枚举的工具产生同样副作用。只要最终动作没有经过独立于模型的检查点，prompt 就是 behavioral policy，不是 reference monitor。

本文将“可执行 policy”定义为：

```text
policy
  = subject identity
  + action and resource
  + decision point outside model reasoning
  + enforceable allow / deny / stop outcome
  + durable evidence
  + defined recovery
```

NIST SP 800-53 将 access enforcement、least privilege、audit 与 system monitoring 分成不同控制族 [1]。这种分层思路不能被简化为“只要有一个网关，所有动作都被治理”。Coding agent 还可能直接调用本地 shell、filesystem 或 network；没有处在调用路径上的网关无法拦截这些动作。

### 1.2 本篇与第 3、4 篇的边界

第 3 篇研究 capability plane：某个 Agent 在 Chorus MCP 中能看到、能调用什么。第 4 篇研究 decision/state plane：哪些高影响状态转换需要证据、review 或授权。第 6 篇深挖 context 与 attribution，第 7 篇深挖跨 runtime 的 coordination-by-artifact。本篇不吸收这些论证，而是回答更上层的问题：

> 一项 policy 应该放在哪一层强制，它覆盖哪些路径，又有哪些路径能绕过它？

这些文章的关系是：

```text
#3 capability plane   -> Chorus 工具发现与调用权限
#4 decision plane     -> Chorus 业务状态与证据门禁
#6 evidence plane     -> context、session、activity 与 usage 归因
#7 federation plane   -> 跨 vendor handoff 与 policy 一致性风险
#8 execution envelope -> 跨 control plane / runtime / OS / repo 的覆盖架构
```

### 1.3 研究问题

- **RQ1：** coding agent 的执行边界应分成哪些层？
- **RQ2：** Chorus 当前在哪些层拥有真实 enforcement point？
- **RQ3：** 哪些能力只是 runtime adapter、操作纪律或事后观测？
- **RQ4：** 怎样从 coverage gap 导出可验证的治理路线图？

---

## 2. 威胁模型与分层 Reference Monitor

### 2.1 被治理的不是“模型”，而是动作路径

本文不假设 Agent 恶意。更常见的失败来自：

- prompt injection 改变行动目标；
- 模型误选工具或误判 cwd；
- 多个 Agent 并发修改同一 worktree；
- subprocess 卡死、崩溃或 daemon 离线；
- credential 权限大于当前任务所需；
- runtime 对同一个抽象 permissionMode 的解释不同；
- 证据缺失时仍推进状态；
- 绕过 Chorus，直接通过 shell、Git 或云 API 产生副作用。

治理对象因此是 action path，而不是模型人格。相同的 `git push` 可以来自 MCP tool、runtime 内建 tool 或 shell command；只有实际位于该路径上的 enforcement point 才能决定它。

### 2.2 四层 reference monitor

一个现实的 coding-agent 环境至少有四个强制层：

| 层 | 典型职责 | 能看到的事实 | 无法单独覆盖 |
|---|---|---|---|
| Chorus control plane | identity、MCP/API、workflow state、routing、audit | actor、entity、permission、turn、status | Agent 直接执行的任意本地/网络动作 |
| Agent runtime | tool approval、sandbox mode、内建 shell/fs policy | 具体 tool call 与 runtime session | runtime 外进程、错误配置、vendor 语义差异 |
| OS / container | process、filesystem、network、secret、resource quota | syscall、mount、cgroup、network namespace | 业务语义、Proposal/Task/AC |
| Repo / CI | branch protection、required checks、review、deploy gate | ref update、commit、check result | 本地未 push 修改、非 repo 外部副作用 |

Docker seccomp profile 在容器/OS 层限制 syscall [2]；Kubernetes resource requests/limits 将 CPU 与 memory 约束交给 scheduler、kubelet 和 container runtime [3]；GitHub protected branches 可要求 review、status checks 和受限 push [5]。它们比 prompt 更接近不可绕过边界，但也只覆盖各自所在的资源域。

### 2.3 最弱可绕过路径原则

假设 Chorus 拒绝 `chorus_admin_verify_task`，但 runtime 仍拥有 unrestricted shell，repository 也允许直接 push 到 protected target 之外的部署脚本。此时“Task 没有被验证”与“代码没有被发布”是两个不同结论。

治理覆盖可以近似表达为：

```text
effective coverage(policy)
  = intersection of enforcement on every path that can create the protected effect
```

如果一种高影响结果存在未经过任何 gate 的替代路径，最强控制层也不能证明该结果受控。Coverage matrix 的目的正是显式暴露这种路径。

---

## 3. 五层执行边界

### 3.1 Identity / Authority：谁在以什么权限行动

Chorus 将 Agent credential 解析为 actor identity 与 permission set。API key 只保存 SHA-256 hash，验证时拒绝已撤销或已过期的 key（`src/lib/api-key.ts:13-30,50-110`）。`hasPermission` 检查预计算的 permission bit；REST helper 对缺权限 Agent 返回 403（`src/lib/auth.ts:22-83,182-236`）。MCP 的 permission-managed tools 在注册时按 permission 裁剪，测试 coverage map 列出 Idea、Proposal、Document、Task 与 Project 的 write/admin 能力（`src/mcp/tools/register-helpers.ts:21-40`；`src/mcp/tools/permission-map.ts:23-98`）。

这层能强制：

- 哪个 API key 代表哪个 Agent；
- key 撤销或到期后不再建立 Agent auth context；
- 哪些 Chorus MCP mutations 对其可见；
- 调用 Chorus REST/MCP 时是否持有所需 bit；
- handler/service 上的 ownership、assignee 与状态不变量。

它不能自动限制该 OS 用户已拥有的 shell credential、云 credential 或 Git SSH key。把 Chorus Agent 设为 read-only，不会撤销进程环境里另一个 token 的权限。

### 3.2 Placement / Isolation：在哪里运行，和谁共享故障域

Chorus 可把 wake 硬定向到 `(host, cwd)`。Pinned target 离线时返回 `offline_pin`，保留 Notification 但不回退到其他在线 cwd（`src/services/notification-turn.ts:570-648`）。Waker 对 directed runtime cwd 重新验证，并让 transcript probe 与 subprocess spawn 使用同一个 resolved cwd（`cli/waker.mjs:454-478`）。

这解决的是错误落点与 session continuity，不是完整隔离：

- cwd 是路径，不是 filesystem namespace；
- 两个不同 Agent 可以指向同一个 physical worktree；
- `DaemonConnection` conflict 只保护同 Agent/host/cwd 的重复 daemon，不是 workspace lease；
- branch、index、HEAD、build cache 与 network 仍可能共享。

因此第 7 篇建议的独立 worktree/branch 和 integration owner 是当前操作纪律。真正的强隔离需要 container、mount namespace、独立 credential 与 repo policy。

### 3.3 Resource Envelope：启动前决定预算，运行中能够硬停

Daemon config 已有两个真实资源控制：

- `maxConcurrency`：每个 Agent runtime 的 wake queue cap；
- `sigintTimeoutMs`：interrupt 从 graceful 到 forceful 的升级窗口。

它们可在 top-level 或 `agents[]` entry 配置（`cli/daemon-config.mjs:305-436`）。`WakeQueue` 对同 key 串行、跨 key 在 `maxConcurrency` 内并发，并在 shutdown 后停止启动新 batch（`cli/wake-queue.mjs:1-20,24-75,123-171`）。

Interrupt 则对 subprocess tree 先发 SIGINT，超时后 POSIX 使用 SIGKILL process group，Windows 使用 `taskkill /T /F`；默认升级窗口为 10 秒（`cli/process-killer.mjs:34-35,62-150`）。

但这些不等于通用 resource envelope。当前代码没有提供：

- per-turn hard token cap；
- per-Idea cost budget；
- CPU/memory quota；
- network egress allowlist；
- filesystem write byte/path quota；
- secret access lease；
- wall-clock deadline自动触发 interrupt。

Chorus 已采集部分 terminal token usage，但采集是事后 evidence，不是消费前 admission control。

### 3.4 Lifecycle / Recovery：失败后状态不能永远说“运行中”

执行治理不仅是“允许启动”，还包括：

```text
pending -> running -> ended | interrupted
```

`advanceTurn` 是 turn status 的单一 chokepoint，拒绝 skip、backward、terminal re-entry 与重复 transition；terminal usage 与 session rollup 在同一 transaction 更新（`src/services/daemon-session.service.ts:609-741`）。

Daemon 死亡时，orphan reconcile 对 stale origin 的 running turns 写入 `interrupted(offline)`；pending turns 留给 reconnect backfill。新 process generation 可强制收敛上一代遗留 turn（`src/services/daemon-session.service.ts:772-880`）。

这些机制提供：

- 同 session 的有序执行；
- 明确 terminal 状态；
- 用户 interrupt 与 crash/offline 的区别；
- stale execution 的恢复入口；
- 后续审计所需的时间与原因。

它们不提供任意业务 mutation 的 exactly-once。Agent 在被 SIGKILL 前可能已经写了一半外部系统；恢复逻辑必须针对每种副作用定义 idempotency 或 compensation。

### 3.5 Commit / Evidence：什么事实允许工作跨过决策边界

Proposal submission 需要文档、Task、输入 Idea 与结构化 AC 等完整性条件（`src/services/proposal.service.ts:234-343`）。Approval 将 drafts、dependencies 与 AC 在 transaction 中物化（`:774-899`）。Task 状态机限制 `open -> assigned -> in_progress -> to_verify -> done` 的合法边（`src/services/task.service.ts:140-153`），admin AC verification 又把 evidence 与 verifier identity 分开保存（`:894-931`）。

Activity 记录 actor、target、action、value 与可选 session attribution（`prisma/schema.prisma:411-435`）；DaemonSession/Turn 保存 runtime origin、status、interruption 和 usage（`:657-742`）。

这层能证明“谁通过 Chorus 把哪个实体推进到什么状态，并留下什么 evidence”。它不能证明：

- 测试覆盖充分；
- reviewer 判断正确；
- Activity 捕获了所有 shell/Git/cloud 动作；
- 已验证 commit 就是最终 merge/deploy 的 commit；
- token 多或少代表工作质量。

Auditability 是治理输入，不是治理效果本身。

---

## 4. Vendor Runtime 不是统一 Policy Engine

### 4.1 一个抽象 mode，三种不同 enforcement

Daemon 将 `permissionMode` 解析为 `chorus | yolo`，并允许每个 `agents[]` entry 独立覆盖（`cli/daemon-config.mjs:341-436`）。Adapter 再把它翻译到各 runtime：

| Runtime | `chorus` | `yolo` |
|---|---|---|
| Claude Code | 只预授权 `mcp__chorus__*` | `--dangerously-skip-permissions` |
| Codex | read-only sandbox | bypass approvals and sandbox |
| Kiro | trust `fs_read,@chorus` | trust all tools |

对应实现分别位于 `cli/claude-spawner.mjs:150-182`、`cli/codex-spawner.mjs:73-108`、`cli/kiro-spawner.mjs:45-75`。

这些映射保留了“受限/全开”的意图，却不具备完全相同的能力集合。例如 Claude restricted mode 聚焦 Chorus MCP tools，Codex restricted mode 是 read-only sandbox，Kiro restricted mode同时信任 filesystem read 和整个 Chorus MCP server。抽象名相同，不代表 wire-level semantics 相同。

### 4.2 Capability negotiation 缺失时只能诚实退化

当前 config 由操作者声明 mode，adapter 静态映射 flag。Control plane 没有从 runtime 查询：

- 是否支持 network deny；
- 是否支持 path-scoped write；
- 是否支持 per-tool approval；
- 是否能硬限制 token/time；
- sandbox 是否覆盖 subprocess descendants；
- 当前 runtime version 是否改变了 flag 语义。

因此现状属于 policy translation，不是 negotiated policy compliance。安全结论必须写成具体 adapter 与版本上的 posture，而不能写成“所有 Agent 都被统一 sandbox”。

### 4.3 Secret delivery 是必要机制，也是扩大面

Daemon 为 subprocess 注入该 Agent 的 Chorus URL/API key，使其能够回读和写回 control plane（`cli/claude-spawner.mjs:328-342`；`cli/codex-spawner.mjs:275-287`；`cli/kiro-spawner.mjs:277-296`）。每个 multi-agent config 拥有独立 credential，这优于共享一个 fleet key；但 credential 仍进入 child environment，其泄露面取决于 runtime、OS process visibility、logs 与工具权限。

Chorus 当前没有通用 secret broker、短期 capability token 或按 turn 自动轮换。凭据隔离只能归为“部分具备”：identity 独立已实现，secret lifecycle 与 least-privilege delivery 仍依赖部署环境。

---

## 5. Coverage Matrix：不要只列“有 Guardrail”

### 5.1 当前代表性矩阵

| Policy | Enforcement point | 覆盖动作 | 可绕过路径 | Evidence | Recovery |
|---|---|---|---|---|---|
| Agent authentication | API-key validator | Chorus MCP/REST 请求 | OS、Git、cloud 的其他 credential | key UUID、actor、last-used | revoke/expire key，轮换 credential |
| Chorus mutation permission | MCP registration + REST/handler gates | Chorus entity API/MCP | shell 直调其他系统；部分 public mutation coverage gap见第 3 篇 | auth actor、Activity、entity state | revoke/reopen/修正状态，视实体而定 |
| Cwd hard pin | notification target selection + Waker validation | daemon wake 的 spawn cwd | Agent 在运行后 `cd`、访问绝对路径；不同 Agent 共用物理 tree | DaemonConnection、session origin、runtimeCwd | notify-only、重新定向、独立 worktree |
| Filesystem isolation | runtime sandbox 或 OS/container，Chorus 无统一 gate | 被 sandbox/mount namespace 覆盖的路径 | unrestricted shell、宿主路径、共享 worktree | runtime/container audit，Chorus 仅有 cwd origin | 丢弃环境、重建 worktree、人工清理 |
| Runtime restricted mode | vendor CLI flags | runtime 能识别的 tools/sandbox | vendor 语义差异、yolo config、runtime 外 credential | daemon config/log、adapter version | interrupt、重新以受限 mode 启动 |
| Wake concurrency | `WakeQueue` | daemon 管理的 wake batch | Agent 自建进程；不同 daemon/host | running/pending snapshot、turns | queue drain、interrupt、reconcile |
| CPU / memory | OS/container quota；Chorus 当前无 gate | 配置了 cgroup/container limit 的进程 | 未容器化进程、错误的 resource scope | host/container metrics | kill/restart/扩容，依 host policy |
| Token / cost / wall time | Chorus 当前仅 usage evidence + stop primitive | 已报告 usage 与手工 interrupt | backend 不报告、阈值不自动触发、外部 API spend | per-turn usage + session rollup | 当前主要是诊断/人工 interrupt |
| Secret delivery | child environment + deployment controls | 注入给指定 Agent subprocess 的 Chorus credential | child/log/process visibility、继承环境、其他 host secret | config/launch logs；无完整 access ledger | revoke/rotate key，终止进程 |
| Network egress | OS/container/network policy；Chorus 当前无统一 gate | 被 namespace/firewall/proxy 覆盖的连接 | unrestricted host network、替代 credential/tunnel | network/proxy audit，非 Chorus Activity | revoke credential、隔离 host、补偿外部副作用 |
| Subprocess stop | process-killer + control channel | 注册的 wake process tree | detached/外部服务；Windows graceful tree限制 | interrupted reason、execution/turn | resume/re-dispatch、人工清理副作用 |
| Proposal/Task gate | service state machine + permission | Chorus workflow transition | 直接 push/merge/deploy；advisory reviewer 可被忽略 | Proposal review、AC、Activity、comments | reject/revoke/reopen |
| Branch/merge policy | repo/CI，非 Chorus server | protected ref 与 deploy workflow | 未保护 ref、外部 admin override | commit/check/review/deploy logs | revert/rollback，依 repo 配置 |
| Cross-vendor policy equivalence | adapter flag mapping；无 capability negotiation | 每个 adapter 已实现的 posture | runtime/version 语义不同或 required capability 缺失 | config、adapter/runtime version | fail closed 尚属 roadmap；当前需人工校准 |
| Policy decision correlation | Chorus Activity/Turn + 外部 logs | 进入各证据面的动作 | control-plane 外动作、缺 correlation ID | 分散 evidence | 人工 stitching；一等 policy log 属 roadmap |

矩阵必须针对“受保护效果”审查，而不是针对产品功能审查。比如 `permissionMode=chorus` 是一个配置功能；真正的问题是它是否覆盖“写生产文件”“访问公网”“读取 secret”三种不同效果。

### 5.2 三种常见误判

**误判一：有日志，所以受控。** Activity 和 token usage 只能说明观测到了什么；它们不能阻止动作。

**误判二：能 interrupt，所以有 quota。** Interrupt 是 stop primitive；没有 admission、计量阈值和自动触发，它还不是 CPU/token/cost policy。

**误判三：有 MCP permission，所以 Agent 是 least privilege。** 该结论只对经过 MCP/REST 的 Chorus 能力成立；runtime shell、filesystem 与网络仍需其他层。

---

## 6. Chorus 现状：Has / Partial / Not Claimed

### 6.1 已有且可实证

1. **Identity 与细粒度 Chorus authority**：独立 Agent credential、`{resource}:{action}`、MCP tool shaping、REST/handler gate。
2. **Addressable placement**：host/cwd connection、hard pin、offline 不静默 fallback、session-origin continuity。
3. **受控 daemon concurrency**：同 key 串行、跨 key cap、自然 coalescing。
4. **运行中 stop primitive**：授权 interrupt、SIGINT 到强杀的 escalation。
5. **Lifecycle recovery**：turn state machine、disconnect/stale/generation reconcile、resume/re-dispatch。
6. **Workflow commit gate**：Proposal validation/approval、Task/AC/verify/reopen。
7. **Evidence substrate**：Comment、Activity、turn/transcript、interrupt reason、per-turn usage 与 session rollup。

这些结论都应限定为 Chorus 管理的 control path。

### 6.2 部分具备或依赖 runtime

1. **Runtime permission posture**：有 adapter mapping，但跨厂商语义不等价。
2. **Filesystem restriction**：Codex read-only、Kiro/Claude tool trust各有映射，但不是 Chorus 统一 filesystem policy。
3. **Secret isolation**：per-agent credential 已分离，但没有通用短期 secret lease。
4. **Workspace isolation**：可定向 cwd，可操作独立 worktree，但无 server-enforced lease。
5. **Resource governance**：有 concurrency 与 interrupt，有 usage 观测，但无多数 hard quota。
6. **Review enforcement**：Proposal/verify 是硬 gate；独立 reviewer VERDICT 主要由 skill/hook 驱动，仍是 behavioral gate。

### 6.3 当前暂不宣称

- 统一 network egress policy；
- 任意 shell/filesystem 的不可绕过 sandbox；
- branch/worktree 强隔离和 distributed workspace lock；
- 跨 runtime 的 hard token、cost、CPU、memory、wall-time quota；
- 对所有 secret access 的短期、最小权限发放；
- 对所有外部副作用的统一 approval intercept；
- Activity/turn 构成完整 distributed trace；
- 有 guardrail 即代表结果正确；
- 已定义、验证了一个 autonomy 或 governance score。

Anthropic 的 autonomy 研究显示真实 Agent action 同时包含 safeguards、human oversight 与少量不可逆动作 [4]。这些外部统计可帮助选择观察维度，但不是 Chorus 已达到的安全效果，也不能替代本地 threat model。

---

## 7. Roadmap：从配置映射到可验证 Execution Envelope

### 7.1 Vendor-neutral policy schema

第一步不是再增加一个 `strict=true`，而是把期望写成可比较的结构：

```yaml
identity:
  agent: <uuid>
  chorusPermissions: [task:read, task:write]
placement:
  host: build-01
  cwd: /worktrees/task-123
filesystem:
  read: [/repo]
  write: [/worktrees/task-123]
network:
  egress: [chorus.example, registry.example]
resources:
  wallTimeSeconds: 1800
  maxConcurrentTurns: 1
  tokenBudget: 200000
commit:
  branch: task-123
  requireChecks: [unit, lint]
  merge: human_only
```

Schema 必须区分 `required` 与 `best_effort`。否则不支持某能力的 adapter 会静默把强约束降级成提示。

### 7.2 Capability negotiation 与 fail-closed admission

Adapter 启动前应报告 capability：

```text
supports.fs.readOnly
supports.fs.pathScopedWrite
supports.network.egressAllowlist
supports.processTreeKill
supports.tokenHardLimit
supports.usageReport
supports.backendResume
```

Policy compiler 比较 required policy 与 runtime/host capability：

- 完全覆盖：允许启动；
- 只能 best effort：显式记录 downgrade，并按 policy 决定是否继续；
- required 缺失：fail closed，不创建 execution。

Policy decision 应与被治理的业务动作分离；Chorus 的实现仍需自行定义 actor、runtime、workspace 和 evidence 等领域输入，并由实际位于动作路径上的 reference monitor 执行。

### 7.3 Pre-start execution envelope

在 subprocess 启动前，Control plane、daemon 与 host jointly materialize：

- execution UUID 与 policy version；
- actor credential 或短期 token；
- runtime flags；
- container/cgroup/network namespace；
- worktree/branch lease；
- allowed secret handles；
- deadline、quota 与 kill target；
- evidence sinks。

启动应是 admission transaction，而不是“先运行，再补记 policy”。无法建立关键边界时应拒绝 wake，而非让 prompt 自行补救。

### 7.4 Runtime quota 与 kill-switch

现有 `maxConcurrency` 和 process-tree interrupt 可作为 stop primitive，但还需要：

1. 实时 usage meter；
2. threshold policy；
3. 单调 budget ledger；
4. daemon/host 不能伪造的 kill authority；
5. terminal reason，如 `quota_token`、`quota_time`、`policy_revoked`；
6. 对外部副作用的 compensation/runbook。

硬停不等于安全完成。Policy 必须说明 kill 后如何处理 dirty worktree、partial deploy、open transaction 和未上传 evidence。

### 7.5 Policy decision log

结束后产出一等 policy log：

```text
requested policy
negotiated capabilities
accepted downgrades
admission decision
runtime policy events
quota observations
interrupt / recovery actions
artifact commit
verification and release decision
```

它应关联 Notification、Turn、DaemonExecution、Activity、commit、CI check 与 verification，但保留每条证据的 provenance。Correlation 提升审计能力，不应被包装成确定性 replay 或自动正确性证明。

### 7.6 如何评价治理，而不是只数功能

未来 evaluation 应按 scenario 测试：

- 缺权限的 MCP 与 REST 调用是否都被拒；
- offline hard pin 是否绝不漂移；
- runtime 不支持 required sandbox 时是否 fail closed；
- token/time threshold 是否在上界内停止 process tree；
- crash/restart 后 turn 是否收敛且不误杀新 generation；
- Agent 能否经 shell 或绝对路径绕过声明的 workspace policy；
- 未经 required checks/review 是否无法更新 protected ref；
- policy log 能否回答谁、何时、基于什么 evidence 放行。

评价单位是“保护效果是否覆盖所有可行路径”，不是“产品是否有一个 guardrails 页面”。

---

## 8. 结论

Coding-agent 治理不能只存在于 coding agent 的 prompt 中。Prompt 负责表达意图；可信环境负责在动作路径上执行 identity、placement、resource、lifecycle 与 commit policy。

Chorus 已经是其中一个真实 control plane：它能强制经过自身的身份、MCP/API、routing、turn 与 workflow 状态转换，也能留下持久 evidence。它还通过 vendor adapter 把受限/全开 posture 映射到 Claude Code、Codex 和 Kiro，并提供 queue cap、interrupt 与 recovery primitives。

但 Chorus 不是整个执行环境。Shell、filesystem、network、secret、branch 与 deploy 的最终边界分散在 runtime、OS/container 和 repo/CI。把这些层统称为“统一 policy plane”会掩盖最危险的问题：哪条路径仍然可以绕过。

因此正确的治理产物不是更长的 system prompt，而是：

1. 一份明确的 threat model；
2. 一份五层 execution envelope；
3. 一张包含 bypass 与 recovery 的 coverage matrix；
4. 一次启动前 capability negotiation；
5. 一条运行中可硬停的 quota/kill path；
6. 一份结束后可关联的 policy decision log。

环境治理的质量取决于最薄弱且可绕过的那一层。只有把它写出来、测试它、并在缺失时 fail closed，“govern the environment, not the prompt”才从口号变成工程边界。

---

## 参考资料

1. NIST, “Security and Privacy Controls for Information Systems and Organizations,” SP 800-53 Rev. 5.
   <https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final>
2. Docker Docs, “Seccomp security profiles for Docker.”
   <https://docs.docker.com/engine/security/seccomp/>
3. Kubernetes Docs, “Resource Management for Pods and Containers.”
   <https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/>
4. Anthropic, “Measuring AI agent autonomy in practice.”
   <https://www.anthropic.com/research/measuring-agent-autonomy>
5. GitHub Docs, “About protected branches.”
   <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
6. Chorus 技术分享第 3 篇，[Capability-Shaped Tool Surface](03-capability-shaped-tool-surface.md)。
7. Chorus 技术分享第 4 篇，[Reversed Conversation](04-reversed-conversation.md)。
8. Chorus 技术分享第 6 篇，[Context and Attribution](06-context-and-attribution.md)。
9. Chorus 技术分享第 7 篇，[Cross-Vendor Federation](07-cross-vendor-federation.md)。

> 外部资料用于建立 guardrail、policy engine、OS resource control、repository gate 与 autonomy measurement 的对照；Chorus 能力与限制均以本文引用的仓库源码为准。
