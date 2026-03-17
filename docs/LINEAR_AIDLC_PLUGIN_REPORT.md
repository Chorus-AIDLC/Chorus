# Linear AI-DLC Plugin — Execution Report

> Date: 2026-03-15
> Author: Admin Claude
> Status: Research & Design

## 1. Executive Summary

本报告调研了为 Linear 构建一套类似 Chorus Plugin 的 AI-DLC（AI-Driven Development Lifecycle）插件的可行性。插件目标是让 Claude Code Agent 能够通过 Linear 管理项目、任务、文档，实现 Idea → Proposal → Task → Execute → Verify → Done 的 AI-DLC 工作流。

**结论**: Linear 的 API 能力和官方 MCP 服务器可以支撑大部分 AI-DLC 工作流，但 Linear 的数据模型缺少 Chorus 的一些核心概念（Proposal、Elaboration、Agent Session），需要通过 Label + Custom View + 约定映射来模拟。某些场景下 Linear 的原生能力（Cycles、Initiatives、Workflow States）反而比 Chorus 更成熟。

---

## 2. Linear 集成能力概览

### 2.1 API

| 项目 | 详情 |
|------|------|
| API 类型 | **GraphQL only** (`https://api.linear.app/graphql`) |
| TypeScript SDK | `@linear/sdk` — 完整类型化封装 |
| Auth — API Key | `lin_api_xxx`，Header: `Authorization: <KEY>` (不需要 Bearer) |
| Auth — OAuth 2.0 | 支持 PKCE，Scopes: read/write/admin，支持 `actor=app` 模式（以 App 身份操作） |
| Rate Limit | 5,000 req/h (API Key)，250,000 complexity/h (API Key)，OAuth App 可达 2M complexity/h |
| Webhook | 支持 Issue/Project/Document/Cycle 等全部资源的 create/update/remove 事件 |

### 2.2 MCP Server

| Server | 类型 | 工具数 | 传输 |
|--------|------|--------|------|
| **官方 Linear MCP** (`mcp.linear.app`) | First-party | ~23 | HTTP Streamable / SSE |
| **w-10-m/linear-mcp** (社区最全) | Community | ~40 | stdio |
| **jerhadf/linear-mcp-server** | Community | ~5 | stdio |

**官方 MCP 工具清单** (~23 tools):
- Query: `list_issues`, `list_projects`, `list_teams`, `list_users`, `list_documents`, `list_cycles`, `list_comments`, `list_issue_labels`, `list_issue_statuses`, `list_project_labels`
- Read: `get_issue`, `get_project`, `get_team`, `get_user`, `get_document`, `get_issue_status`
- Create: `create_issue`, `create_project`, `create_comment`, `create_issue_label`
- Update: `update_issue`, `update_project`
- Search: `search_documentation`

### 2.3 Linear 数据模型

```
Workspace
├── Teams (1..*)
│   ├── Issues (核心工作单元)
│   │   ├── Title, Description (Markdown)
│   │   ├── Status (Team-specific Workflow States)
│   │   ├── Priority (Urgent/High/Medium/Low/None)
│   │   ├── Assignee, Labels, Estimate, Due Date
│   │   ├── Sub-issues (parent/child)
│   │   ├── Relations (blocking/blocked-by/duplicate/related)
│   │   ├── Comments, Attachments
│   │   └── SLAs
│   ├── Cycles (定期迭代，自动滚动)
│   └── Workflow States (Triage → Backlog → Todo → In Progress → Done → Canceled)
├── Projects (跨 Team，有里程碑)
├── Initiatives (高层目标，聚合 Projects)
├── Documents
└── Views (动态过滤分组)
```

---

## 3. Chorus vs Linear 概念映射

### 3.1 可直接映射的概念

| Chorus 概念 | Linear 对应 | 映射方式 | 完整度 |
|-------------|------------|---------|--------|
| **Project** | **Project** | 1:1 | ★★★★★ |
| **Task** | **Issue** | 1:1 | ★★★★★ |
| **Task Status** (open → in_progress → verify → done → closed) | **Workflow States** | 通过 Team Workflow 自定义状态，添加 `Verify` 状态 | ★★★★☆ |
| **Task Priority** | **Issue Priority** | 1:1 (Urgent/High/Medium/Low) | ★★★★★ |
| **Task Dependencies** (DAG) | **Issue Relations** (blocking/blocked-by) | 1:1 | ★★★★★ |
| **Comment** | **Comment** | 1:1 | ★★★★★ |
| **Document** | **Document** | 1:1 | ★★★★☆ |
| **Project Group** | **Initiative** | Initiative 聚合多个 Projects | ★★★★★ |
| **Activity Stream** | **Issue History + Audit Log** | Linear 自动记录所有变更历史 | ★★★★☆ |
| **Agent Assignment** | **Issue Assignee** | OAuth App + `actor=app` 可作为机器人用户 | ★★★☆☆ |

### 3.2 需要约定/模拟的概念

| Chorus 概念 | Linear 模拟方案 | 复杂度 | 说明 |
|-------------|---------------|--------|------|
| **Idea + Proposal** (合并容器) | **单个 Parent Issue** — Label 从 `harness:idea` → `harness:elaborating` → `harness:proposal` → `harness:approved` 流转 | 低 | 同一个 Issue 既是 Idea 也是 Proposal，通过 Label 状态机流转，PRD 作为 Document，Tasks 作为 Sub-issues |
| **Proposal Approval/Reject** | Label `harness:proposal` → `harness:approved` / `harness:rejected` + Comment | 低 | Admin 在 Parent Issue 上操作 Label + Comment |
| **Elaboration** (AI 追问细化) | Issue Comment Thread | 低 | 用 Comment 对话实现需求细化 |
| **Acceptance Criteria** (逐条勾选) | Issue Description Markdown Checklist | 低 | `- [ ] criterion` 格式，Linear 原生支持 Checkbox |
| **Agent Session** (sub-agent 可观测性) | **无直接对应** — 需要自建 | 高 | 见下文 §3.3 |
| **Agent Roles** (PM/Developer/Admin) | OAuth App Scopes + 插件约定 | 中 | Linear 没有 "agent role" 概念，靠插件层面区分 |
| **Idea → Proposal → Task 流水线** | 单个 Parent Issue + Label 流转 + Sub-issues | 低 | 同一个 Issue 上流转，简洁直观 |

### 3.3 Agent Session — 核心缺失

Chorus 的 Agent Session 是一套**专为 AI Agent 设计的可观测性系统**：
- Session 绑定 sub-agent 生命周期
- Session checkin/checkout 追踪 "哪个 agent 在做哪个 task"
- Heartbeat 保活、自动超时
- Activity Stream 中 session 级归因

**Linear 没有这个概念。** Linear 的 Assignee 是用户级别的，不区分 "同一个 OAuth App 下的多个 sub-agent"。

**模拟方案:**

| 方案 | 描述 | 优劣 |
|------|------|------|
| **A. 本地 State 文件** | 插件在 `.linear-aidlc/sessions/` 维护 session 状态（同 Chorus 插件） | 简单但不可视化，多机器不同步 |
| **B. Issue Comment 日志** | sub-agent 开始/结束时在 Issue 上留 Comment："🤖 agent-worker-1 started / completed" | 可视化但嘈杂 |
| **C. 自建 Session 服务** | 用一个轻量 SQLite/JSON 文件或独立服务存储 session | 最灵活但增加复杂度 |
| **D. 混合方案 (推荐)** | 本地 State 文件 (方案 A) + 关键节点 Comment 日志 (方案 B) | 平衡可视化和简洁 |

---

## 4. Linear 相比 Chorus 的优势

### 4.1 Cycles (迭代管理)
Chorus 没有原生的迭代/Sprint 概念。Linear 的 Cycles 提供：
- 自动滚动（未完成 Issue 自动移入下一个 Cycle）
- Burndown chart
- Cycle-level 进度追踪

**AI-DLC 插件可利用**: PM Agent 创建 Cycle，将 approved 的 Task 分配到当前 Cycle。

### 4.2 Initiatives (战略级目标)
Linear Initiatives 聚合多个 Projects，提供高层目标视图。比 Chorus 的 Project Group 功能更丰富（有进度追踪、Update 时间线）。

### 4.3 Workflow States 高度可定制
Linear 允许每个 Team 自定义完整的状态流（不限于固定的几个状态），支持状态分类：Triage / Backlog / Unstarted / Started / Completed / Canceled。

**AI-DLC 状态映射建议:**
```
Triage      → idea (待细化)
Backlog     → elaborated (已细化，待排期)
Todo        → open (待分配)
In Progress → in_progress (开发中)
In Review   → verify (待验证)  ← 自定义添加
Done        → done (完成)
Canceled    → closed (关闭)
```

### 4.4 Sub-Issues (原生层级)
Linear 原生支持 Issue 的 parent/child 关系，比 Chorus 的 flat task list 更灵活。可以用 parent Issue 表示 Epic/Story，child Issues 表示具体 Task。

### 4.5 Issue Relations (DAG)
Linear 的 `blocking` / `blocked-by` 关系天然形成 DAG，与 Chorus 的 TaskDependency 等价。

### 4.6 SLA 与 Due Date
Linear 原生支持 SLA（Issue 响应时间、解决时间目标），Chorus 目前没有。

---

## 5. 插件架构设计

### 5.1 目录结构

```
public/linear-aidlc-plugin/
├── .claude-plugin/
│   └── plugin.json              # Claude Code 插件清单
├── .mcp.json                    # MCP server 配置 (Linear 官方 MCP)
├── bin/                         # Hook 脚本 (Bash 3.2)
│   ├── linear-api.sh            # GraphQL API 封装 + 状态管理
│   ├── on-session-start.sh      # 启动: 获取 viewer 信息、列出 Team/Project
│   ├── on-user-prompt.sh        # 快速本地检查
│   ├── on-pre-enter-plan.sh     # 注入 Proposal 工作流引导
│   ├── on-pre-exit-plan.sh      # 提醒创建 Document + Issues
│   ├── on-pre-spawn-agent.sh    # 记录待 spawn 的 agent
│   ├── on-subagent-start.sh     # Session 管理 + 上下文注入
│   ├── on-subagent-stop.sh      # 自动更新 Issue 状态 + 清理
│   ├── on-teammate-idle.sh      # 心跳 (更新 Issue Comment)
│   ├── on-task-completed.sh     # CC Task 完成 → Linear Issue 状态更新
│   ├── on-session-end.sh        # 清理本地状态
│   └── test-syntax.sh           # Bash 3.2 兼容性测试
├── hooks/
│   └── hooks.json               # Hook 事件路由配置
├── skills/linear-aidlc/
│   ├── SKILL.md                 # Skill 主文件
│   ├── package.json             # Skill 元数据
│   └── references/
│       ├── 00-common-tools.md   # 通用 Linear MCP 工具参考
│       ├── 01-setup.md          # 安装配置指南
│       ├── 02-pm-workflow.md    # PM Agent 工作流
│       ├── 03-developer-workflow.md  # Developer Agent 工作流
│       ├── 04-admin-workflow.md # Admin Agent 工作流
│       ├── 05-session-management.md  # Session 管理
│       ├── 06-agent-teams.md    # Claude Code Agent Teams 集成
│       └── 07-label-conventions.md   # Label 约定文档
└── templates/
    ├── workflow-states.json     # 推荐的 Workflow State 配置
    └── labels.json              # 推荐的 Label 集合
```

### 5.2 MCP 配置

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer ${LINEAR_API_KEY}"
      }
    }
  }
}
```

**备选方案**: 如果官方 MCP 工具不够用（例如缺少 bulk operations、cycle management），可用社区 `w-10-m/linear-mcp` (40 tools) 替代：

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/linear-mcp"],
      "env": {
        "LINEAR_API_KEY": "${LINEAR_API_KEY}"
      }
    }
  }
}
```

### 5.3 Hook 设计

#### Session 生命周期 (与 Chorus 插件一致)

| Hook | 脚本 | 作用 | 与 Chorus 差异 |
|------|------|------|---------------|
| SessionStart | `on-session-start.sh` | 调用 `list_teams` + `list_projects` 获取上下文 | 无 `checkin` 概念，改为查询 viewer + 活跃 Projects |
| UserPromptSubmit | `on-user-prompt.sh` | 本地文件检查，提醒 session 状态 | 相同 |
| PreToolUse:EnterPlanMode | `on-pre-enter-plan.sh` | 注入 "创建 Document + Issue 计划" 引导 | Chorus 注入 Proposal 流程，这里注入 Document 流程 |
| PreToolUse:ExitPlanMode | `on-pre-exit-plan.sh` | 提醒提交 Document 和创建 Issues | 相同 |
| PreToolUse:Task | `on-pre-spawn-agent.sh` | 写 pending 文件 | 相同 |
| SubagentStart | `on-subagent-start.sh` | 本地 session 创建 + Comment 日志 + 上下文注入 | 无 MCP session，改用本地文件 + Issue Comment |
| SubagentStop | `on-subagent-stop.sh` | 更新 Issue 状态 + Comment + 清理 | 无 session checkout，改为 Issue Comment + 状态更新 |
| TeammateIdle | `on-teammate-idle.sh` | 更新 Issue Comment "still working..." | 无 heartbeat API，改为 Comment 更新 |
| TaskCompleted | `on-task-completed.sh` | `linear:issue:<id>` 标记 → 更新 Issue 状态 | 同 Chorus 的 `chorus:task:<uuid>` |
| SessionEnd | `on-session-end.sh` | 清理 `.linear-aidlc/` | 相同 |

#### `linear-api.sh` — GraphQL API 封装

由于 Linear 是 GraphQL only，`linear-api.sh` 需要封装 GraphQL 请求：

```bash
# 核心函数
linear_graphql() {
  local query="$1"
  local variables="$2"
  curl -s -X POST https://api.linear.app/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -d "{\"query\": \"$query\", \"variables\": $variables}"
}

# 或者调用 MCP 工具（通过 Claude Code 的 MCP session）
linear_mcp_call() {
  local tool="$1"
  local params="$2"
  # 通过本地 HTTP 调用 MCP server
}
```

**关键区别**: Chorus 插件的 `chorus-api.sh` 通过 HTTP 直接调用 Chorus 的 REST API。Linear 插件需要调用 GraphQL API 或者通过 MCP Proxy。

### 5.4 Label 约定 (Convention over Configuration)

由于 Linear 没有 Idea / Proposal / Elaboration 等原生概念，通过 Label 约定模拟：

```json
{
  "aidlc-labels": {
    "workflow": {
      "aidlc:idea": { "color": "#7C3AED", "description": "Idea — needs elaboration" },
      "aidlc:elaborating": { "color": "#F59E0B", "description": "Idea under AI elaboration" },
      "aidlc:proposal": { "color": "#3B82F6", "description": "Proposal — pending approval" },
      "aidlc:approved": { "color": "#10B981", "description": "Proposal approved" },
      "aidlc:rejected": { "color": "#EF4444", "description": "Proposal rejected" }
    },
    "role": {
      "aidlc:pm": { "color": "#8B5CF6", "description": "PM Agent work item" },
      "aidlc:dev": { "color": "#06B6D4", "description": "Developer Agent work item" },
      "aidlc:admin": { "color": "#F97316", "description": "Admin review needed" }
    },
    "agent": {
      "aidlc:agent-assigned": { "color": "#6366F1", "description": "Assigned to AI Agent" }
    }
  }
}
```

### 5.5 AI-DLC 工作流映射

#### PM Agent Workflow

```
1. [获取 Ideas]
   list_issues(team, filter: label="aidlc:idea", status="Triage")

2. [Claim Idea]
   update_issue(id, assignee=self)

3. [Elaboration — 需求细化]
   create_comment(issueId, body="## Elaboration Questions\n1. ...")
   update_issue(id, label+="aidlc:elaborating")
   # 等待用户回复 Comment
   list_comments(issueId) → 检查回复

4. [创建 Proposal]
   create_document(title="PRD: xxx", content="...")     # PRD
   update_issue(id, label: "aidlc:idea" → "aidlc:proposal")
   # 在 Issue Description 中列出 Task Drafts (Markdown checklist)

5. [Proposal 审批]
   # Admin 审批: 添加 label "aidlc:approved" + Comment "Approved"
   # Admin 拒绝: 添加 label "aidlc:rejected" + Comment "Rejected: reason"

6. [Materialize Tasks]
   # 审批通过后，批量创建 Issues (作为原 Idea Issue 的 sub-issues 或独立 Issues)
   create_issue(title, description, team, project, parent=ideaIssue)  × N
   # 设置 blocking/blocked-by relations 形成 DAG
```

#### Developer Agent Workflow

```
1. [获取可用任务]
   list_issues(team, filter: status="Todo", assignee=null)

2. [Claim Task]
   update_issue(id, assignee=self)

3. [开始工作]
   update_issue(id, status="In Progress")
   create_comment(issueId, "🤖 Started working on this issue")

4. [报告进度]
   create_comment(issueId, "Progress update: ...")

5. [Self-check & Submit]
   # 检查 Description 中的 Checklist 是否全部完成
   update_issue(id, status="In Review")
   create_comment(issueId, "Ready for verification. All criteria met.")

6. [完成]
   # Admin 验证后: update_issue(id, status="Done")
```

#### Admin Agent Workflow

```
1. [审批 Proposals]
   list_issues(filter: label="aidlc:proposal")
   # 审核 Document + Task Drafts
   update_issue(id, label+="aidlc:approved")
   create_comment(issueId, "✅ Proposal approved")

2. [验证 Tasks]
   list_issues(filter: status="In Review")
   # 检查完成情况
   update_issue(id, status="Done")
   create_comment(issueId, "✅ Verified and completed")

3. [管理项目]
   create_project(...), update_project(...)
```

---

## 6. 可行性对比矩阵

### 6.1 功能完整度对比

| AI-DLC 功能 | Chorus 实现 | Linear 实现 | 可行性 |
|-------------|------------|------------|--------|
| Idea 管理 | 原生 Idea 实体 | Issue + Label `aidlc:idea` | ✅ 可行，略有妥协 |
| Elaboration (AI 追问) | 原生 Elaboration API | Issue Comment Thread | ✅ 可行 |
| Proposal (PRD + Tasks) | 原生 Proposal 实体 | Document + Issue Description | ⚠️ 可行但散落多处 |
| Proposal 审批流 | 原生 approve/reject API | Label 状态机 + Comment | ⚠️ 可行但不原子 |
| Task CRUD | 原生 Task API | Issue API | ✅ 完全可行 |
| Task DAG | TaskDependency 模型 | Issue Relations (blocking) | ✅ 完全可行 |
| Acceptance Criteria | 原生 criteria + checkbox | Markdown Checklist in Description | ✅ 可行 |
| Agent Session | 原生 Session API | 本地文件 + Comment 日志 | ⚠️ 降级但可用 |
| Session Heartbeat | 原生 heartbeat API | 无（本地 timestamp） | ⚠️ 仅本地 |
| Session Checkin/Checkout | 原生 checkin/checkout | Comment + 本地状态 | ⚠️ 降级 |
| Multi-agent 可观测性 | Web UI Session 面板 | Linear Activity + Comments | ⚠️ 碎片化 |
| Notification | 原生 notification API | Linear Notification（有限） | ⚠️ Linear 不支持 agent→agent 通知 |
| Agent Roles | 原生 role-based tools | 插件层面约定 | ✅ 可行 |
| Cycle/Sprint | 无 | ✅ 原生 Cycles | Linear 更优 |
| Initiative | Project Group（基础） | ✅ 原生 Initiatives | Linear 更优 |
| SLA | 无 | ✅ 原生 SLA | Linear 更优 |

### 6.2 实现难度评估

| 模块 | 难度 | 工作量估计 | 说明 |
|------|------|-----------|------|
| 插件骨架 (plugin.json, .mcp.json, hooks.json) | 低 | 可从 Chorus 插件复制 | 结构完全一致 |
| Hook 脚本 (bin/*.sh) | 中 | 需重写 API 调用层 | GraphQL 替代 REST，无 session API |
| `linear-api.sh` (GraphQL 封装) | 中 | 新写 | curl + GraphQL，比 REST 复杂一些 |
| Skill 文档 (skills/) | 中 | 大量文档工作 | 重写 workflow 文档 |
| Label 初始化脚本 | 低 | 首次运行时创建 Labels | `create_issue_label` × N |
| Workflow State 配置指南 | 低 | 文档 | 指导用户添加 "In Review" 状态 |
| Session 模拟 (本地 + Comment) | 中 | 新设计 | 最大的架构差异点 |
| Proposal 模拟 (Document + Label) | 中高 | 工作流编排 | 散落在多个 Linear 实体中 |

---

## 7. 推荐实现策略

### Phase 1: MVP — Developer Workflow (最快出价值)

聚焦 Developer Agent 的核心工作流，因为这是最直接映射的部分：

1. 插件骨架 (plugin.json, .mcp.json, hooks.json)
2. `linear-api.sh` GraphQL 封装
3. SessionStart hook — 获取 viewer + team + project 上下文
4. SubagentStart/Stop hooks — 本地 session + Issue Comment 日志
5. Developer Skill 文档 — claim task, work, submit
6. TaskCompleted hook — `linear:issue:<id>` 标记
7. TeammateIdle hook — 本地心跳

**可复用 Chorus 代码**: 80% 的 hook 逻辑（文件管理、并发安全、context injection）。

### Phase 2: PM Workflow + Proposal 模拟

1. Label 初始化脚本
2. PM Skill 文档 — idea → elaboration → proposal → approval
3. EnterPlanMode/ExitPlanMode hooks — 注入 Proposal 流程
4. Proposal 流程编排（Document + Label 状态机）

### Phase 3: Admin Workflow + 高级功能

1. Admin Skill 文档 — approve/reject/verify
2. Cycle 集成（AI-DLC + Sprint 管理）
3. Initiative 集成
4. Webhook 集成（实时通知而非轮询）

---

## 8. MCP Server 选型建议

### 推荐: 官方 MCP Server + 自定义 GraphQL 补充

| 场景 | 工具来源 |
|------|---------|
| Issue CRUD, Project, Comment, Document | 官方 MCP (`mcp.linear.app`) |
| Cycle 管理, Bulk 操作, 时间追踪 | `linear-api.sh` 直接 GraphQL |
| Label 管理 (create_issue_label 已有) | 官方 MCP |
| Issue Relations (blocking) | 官方 MCP `update_issue` 或 GraphQL |

**为什么不纯用社区 MCP?** 官方 MCP 由 Linear 维护，稳定性和兼容性有保障。社区 MCP 工具更多但可能有版本滞后风险。

**为什么不纯用官方 MCP?** 官方 MCP 缺少 Cycle 管理、Bulk 操作、Issue Relations 详细操作。Hook 脚本中需要直接调用 GraphQL 来补充。

---

## 9. 关键风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Proposal 模拟碎片化 | 审批流程不原子，状态可能不一致 | 用 Label 状态机 + 乐观锁 Comment 检查 |
| Agent Session 无服务端支持 | 多机器/多用户无法共享 session 状态 | Phase 3 引入轻量 Session 服务，或接受本地 session 局限 |
| Rate Limit (5000 req/h) | 多 agent 并发可能触发 | 使用 OAuth App (2M complexity/h) + 请求合并 |
| 官方 MCP 工具不足 | 某些操作需要 fallback 到 GraphQL | `linear-api.sh` 封装 GraphQL 作为补充 |
| Label 约定无强制力 | 用户/其他工具可能破坏 Label 状态 | 在 Hook 中做状态校验和自动修复 |

---

## 10. 总结

| 维度 | Chorus Plugin | Linear AI-DLC Plugin |
|------|--------------|---------------------|
| **原生 AI-DLC 支持** | ★★★★★ — 专为此设计 | ★★☆☆☆ — 需大量约定 |
| **项目管理成熟度** | ★★★☆☆ — 基础功能 | ★★★★★ — Cycles, SLA, Initiatives |
| **MCP Server** | 自建 (完全控制) | 官方提供 (~23 tools) |
| **Agent Session** | ★★★★★ — 原生 | ★★☆☆☆ — 需模拟 |
| **Proposal/审批** | ★★★★★ — 原生 | ★★☆☆☆ — Label 模拟 |
| **Task DAG** | ★★★★☆ — 原生 | ★★★★★ — 原生 Relations |
| **UI 可视化** | ★★★★☆ — 自建 UI | ★★★★★ — Linear 原生 UI |
| **生态集成** | ★★☆☆☆ — 独立系统 | ★★★★★ — GitHub/Slack/Figma 等 |
| **多 Agent 协作** | ★★★★★ — 核心设计 | ★★☆☆☆ — 单 assignee 限制 |
| **插件复用度** | — (参考基准) | ~60% Hook 逻辑可复用 |

**最终建议**: Linear AI-DLC 插件是可行的，且能利用 Linear 成熟的项目管理 UI 作为可视化层。最大的妥协在 Agent Session 和 Proposal 流程上——这些是 Chorus 的核心差异化功能，在 Linear 中只能通过约定模拟。建议 Phase 1 先聚焦 Developer Workflow（映射最直接），快速验证价值后再逐步扩展 PM 和 Admin 流程。
