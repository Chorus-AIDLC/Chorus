> [English Version](./PRD_Chorus.md)

# PRD: Project Chorus 🎵

**代号**: Chorus
**文档版本**: 1.1
**创建日期**: 2026-02-04
**更新日期**: 2026-02-18
**状态**: 已实现（持续迭代中）

---

## 1. 产品愿景

### 一句话描述
一个让 AI Agent 和人类在同一平台上协作开发的基础设施——**AI Agent 与人类协作开发的基础设施**。

### 愿景陈述
现有的项目管理工具（Jira、Linear）是为人类设计的。AI Agent（如 Claude Code）无法真正"参与"——它们只能被动接收指令，完成后就"失忆"。

**Chorus（合唱团）** 是一个**协作平台**，让多个声部（人类 + AI Agent）协同演奏：
- **人类**在平台上定义目标、拆解任务、审批决策
- **AI Agent**在平台上领取任务、报告工作、查看其他 Agent 的进展
- **平台**提供共享的知识库、活动流、Session 可观测性

**Chorus 是 AI Agent 的工作协作平台（GitHub/Jira）**——让 Agent 成为项目的一等公民。

### 三大杀手级功能

#### 1. 🧠 Zero Context Injection（零成本上下文注入）

**痛点**：每次开新 Claude Code session，都要花 5-10 分钟解释项目背景和 Agent 角色。

**杀手体验**：Agent 开始任务时，自动获取：
- **Agent 人格**：预定义的角色、专长、工作风格
- **项目背景**：目标、技术栈、架构决策
- **任务上下文**：任务描述、前置任务输出、相关讨论
- **待处理事项**：分配给自己的 Ideas/Tasks

**0 秒准备，直接开始工作。**

**一句话**：Agent 自动知道"我是谁"和"要做什么"，人类不用重复解释。

#### 2. 🔄 AI-DLC Workflow（AI 驱动的开发工作流）

**痛点**：人类要手动规划需求、拆解任务、分配工作，AI 只能被动执行。

**杀手体验**：AI 主动提议 PRD、任务拆解、技术方案，人类只需审批验证。完整闭环：**Idea → Proposal → Document/Task → 执行 → 验证**。

**一句话**：AI 提议，人类验证，角色反转。

#### 3. 👁️ Multi-Agent Awareness（多 Agent 协同感知）

**痛点**：多个 Agent 各自工作，互不知晓，容易冲突或重复劳动。

**杀手体验**：所有 Agent 的工作动态实时可见，共享知识库保持信息同步，系统自动检测冲突（如两个 Agent 同时修改同一文件）并预警。

> **当前状态**：冲突检测尚未实现。已实现的是 Session 可观测性（Kanban 实时显示活跃 Worker）和活动流审计。

**一句话**：Agent 不再孤岛，团队协作透明可见。

---

## 1.5 设计思路：AI-DLC 方法论

Chorus 的设计基于 **AI-DLC（AI-Driven Development Lifecycle）**——AWS 在 2025 年提出的方法论。

### AI-DLC 核心原则

> "We need automobiles, not faster horse chariots."
> "Reimagine, Don't Retrofit" — 重新想象，而不是把 AI 塞进现有流程

**传统模式 vs AI-DLC：**

| 传统 | AI-DLC |
|-----|--------|
| 人类提示 → AI 执行 | **AI 提议 → 人类验证**（Reversed Conversation） |
| Sprint（周） | **Bolt（小时/天）** |
| Story Point = 人天 | **Story Point = Agent 小时** |
| AI 是工具 | **AI 是协作者** |
| 改造 Agile | **从第一性原理重新设计** |

### AI-DLC 三阶段

```
┌─────────────────────────────────────────────────────────────┐
│  Inception（启动）                                           │
│  AI 将业务意图转化为需求、故事、单元                           │
│  → Mob Elaboration：团队验证 AI 的提议                        │
├─────────────────────────────────────────────────────────────┤
│  Construction（构建）                                        │
│  AI 提出架构、代码方案、测试                                   │
│  → Mob Construction：团队实时澄清技术决策                      │
├─────────────────────────────────────────────────────────────┤
│  Operations（运维）                                          │
│  AI 管理 IaC 和部署，团队监督                                 │
└─────────────────────────────────────────────────────────────┘
         ↓ 每个阶段的上下文传递给下一阶段 ↓
```

### Agent 小时：全新的工作量衡量标准

**传统 Story Point 的问题**：
- 以"人天"为单位，假设人类是执行主体
- 估算依赖经验，主观性强
- 不适用于 AI Agent 执行的任务

**Agent 小时（Agent Hours）**：
- **定义**：1 Agent 小时 = 1 个 Agent 持续工作 1 小时的产出
- **特点**：可量化、可预测、可并行
- **换算**：传统 1 人天 ≈ 0.5-2 Agent 小时（取决于任务复杂度）

**为什么 Agent 小时更适合 AI-DLC**：

| 维度 | 人天 | Agent 小时 |
|-----|------|-----------|
| 执行主体 | 人类 | AI Agent |
| 可预测性 | 低（依赖个人状态） | 高（Agent 输出稳定） |
| 并行能力 | 受限（人类精力有限） | 高（多 Agent 并行） |
| 成本计算 | 薪资成本 | API 调用成本 |
| 估算依据 | 历史经验 | 任务复杂度 + Token 消耗 |

**Chorus 中的应用**：
- Task 的 `storyPoints` 字段以 Agent 小时为单位
- 项目进度以 Agent 小时完成量衡量
- 资源规划基于 Agent 可用时间

### Chorus 与 AI-DLC 的关系

**AI-DLC 是方法论，Chorus 是它的完整实现。**

| AI-DLC 核心原则 | Chorus 实现 |
|---------------|------------|
| **Reversed Conversation** | PM Agent 提议任务 → 人类验证 → Developer Agent 执行 |
| 持续的上下文传递 | 知识库 + 任务关联 + 阶段上下文 |
| Mob Elaboration | 人类在平台上验证/调整 AI 的提议 |
| AI 是协作者 | PM Agent 参与规划，不只是执行 |
| 短周期迭代（Bolt） | 轻量任务管理，小时/天级别 |
| **Agent 小时估算** | Task 工作量以 Agent 小时为单位 |

### Reversed Conversation 工作流

```
传统模式（人类主导）：
  Human → 创建任务 → Agent 执行

Chorus 模式（AI-DLC）：
  Human: "我想实现用户认证功能"
       ↓
  PM Agent: 分析需求，提议任务拆解
       ↓
  Human: 验证/调整提议 ✓
       ↓
  Developer Agents: 执行被批准的任务
       ↓
  PM Agent: 追踪进度，识别风险，调整计划
```

**关键区别**：AI 提议，人类验证。人类从"指挥者"变成"验证者"。

---

## 2. 问题陈述

### 2.1 现状痛点

**当前的开发模式存在三层割裂：**

```
┌─────────────────────────────────────────────────────────┐
│  项目管理层 (Jira/Asana/Linear)                          │
│  - 人类手动维护                                          │
│  - AI无法理解/更新                                       │
└─────────────────────────────────────────────────────────┘
                    ↑ 手动同步（容易过时）
┌─────────────────────────────────────────────────────────┐
│  人类团队层                                              │
│  - 口头沟通、会议、文档                                   │
│  - 决策过程不透明                                        │
└─────────────────────────────────────────────────────────┘
                    ↑ 口头指令/复制粘贴上下文
┌─────────────────────────────────────────────────────────┐
│  Personal Agent层 (Claude Code, Cursor, Copilot等)      │
│  - 每个session独立，互不知晓                              │
│  - 没有项目全局视角                                      │
│  - 无法主动协调                                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心问题

| 问题 | 影响 |
|-----|------|
| **Agent孤岛** | 每个开发者的AI助手只知道当前会话，不知道项目全貌 |
| **上下文丢失** | 每次新session都要重新解释背景，效率低下 |
| **协调成本高** | 人类要手动协调多个Agent的工作，避免冲突 |
| **知识分散** | 项目知识散落在各种工具、文档、聊天记录中 |
| **决策不可追溯** | 为什么这样设计？当时的考虑是什么？无从查起 |

### 2.3 目标用户

**主要用户：**
- 使用AI编程工具（Claude Code, Cursor等）的开发团队
- 团队规模：3-20人
- 项目类型：软件开发、AI/ML项目

**用户画像：**
- 技术负责人：需要掌控项目全局，协调人与AI
- 开发者：希望AI助手能理解项目背景，减少重复解释
- AI Agent：需要获取上下文、报告进度、与其他Agent协调

---

## 3. 产品架构

### 3.1 平台架构（非中心化 Agent）

```
┌─────────────────────────────────────────────────────────┐
│                  Chorus Platform                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ 任务系统    │ │ 知识库      │ │ Session管理 │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ Git集成     │ │ Task DAG    │ │ 活动流      │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                        API                              │
└────────────────────────┬────────────────────────────────┘
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
┌─────▼─────┐     ┌──────▼──────┐    ┌──────▼──────┐
│ MCP Server│     │   Web UI    │    │ PM Agent    │
│(Agent接入)│     │  (人类接入)  │    │  (可选)     │
└─────┬─────┘     └──────┬──────┘    └──────┬──────┘
      │                  │                  │
┌─────▼─────┐     ┌──────▼──────┐    ┌──────▼──────┐
│Claude Code│     │   浏览器    │    │ 独立Agent   │
│  Cursor   │     │   人类PM    │    │ 协助管理    │
│   ...     │     │   开发者    │    │             │
└───────────┘     └─────────────┘    └─────────────┘
```

**关键区别**：Chorus 是**平台/基础设施**，不是中心化的 AI 控制器。
- 人类和 Agent 都是平等的参与者
- PM Agent 是可选的，作为平台上的一个用户存在
- 人类仍然是主要的决策者

### 3.2.5 Agent-First 设计理念

**Chorus 本质上是一个面向 Agent 的平台**。Agent 可以执行几乎所有操作，仅有少数关键动作保留给人类：

| 操作 | PM | Dev | Admin | Human | 说明 |
|-----|:--:|:---:|:-----:|:-----:|------|
| 创建/编辑 Idea | ✓ | ✓ | ✓ | ✓ | |
| 创建/编辑 Document | ✓ | ✓ | ✓ | ✓ | |
| 创建/编辑 Task | ✓ | ✓ | ✓ | ✓ | |
| 创建 Proposal | ✓ | ✗ | ✓ | ✓ | |
| **审批 Proposal** | ✗ | ✗ | ✓ | ✓ | 人类验证 AI 提议 |
| 更新 Task 状态 → To Verify | ✗ | ✓ | ✓ | ✓ | Agent 完成后提交验证 |
| **验证 Task (To Verify → Done)** | ✗ | ✗ | ✓ | ✓ | 人类确认工作质量 |
| 添加评论 | ✓ | ✓ | ✓ | ✓ | |
| 查询知识库 | ✓ | ✓ | ✓ | ✓ | |
| 删除自己创建的内容 | ✓ | ✓ | ✓ | ✓ | |
| **删除他人创建的内容** | ✗ | ✗ | ✓ | ✓ | 管理权限 |
| **创建 Project** | ✗ | ✗ | ✓ | ✓ | 项目管理 |
| **创建/管理 Agent** | ✗ | ✗ | ✗ | ✓ | 安全边界 |
| **创建/管理 API Key** | ✗ | ✗ | ✗ | ✓ | 安全边界 |

**Admin Agent 特殊说明**：
- Admin Agent 代表人类，拥有几乎所有人类才能执行的权限
- **安全警告**：Admin Agent 可以审批 Proposal、验证 Task、创建 Project 等关键操作
- 创建 Admin Agent 的 API Key 时需要特别谨慎（UI 显示红色危险警告）
- Admin Agent 仍然不能创建/管理其他 Agent 和 API Key（这是最终的安全边界）

**设计原则**：
- **Agent 是一等公民**：平台 API 和 UI 优先考虑 Agent 的使用体验
- **人类是守门人**：关键决策点（审批、验证、权限管理）保留人类控制
- **最小权限原则**：Agent 只能删除自己创建的内容，不能越权操作
- **Admin 是特权角色**：Admin Agent 可以代理人类执行大部分操作，但需要明确的授权和风险提示

### 3.2 信息层级结构

```
Chorus Platform
├── Dashboard              ← 全局概览（跨项目统计、快捷入口）
├── Projects               ← 项目列表
│   └── [Project]          ← 单个项目
│       ├── Overview       ← 项目概览（PRD摘要、进度、关键指标）
│       ├── Knowledge      ← 知识库（PRD、决策、任务、评论等统一查询）
│       ├── Documents      ← 文档列表（PRD、技术设计等）
│       ├── Proposals      ← 提议列表（PM Agent 在此项目的提议）
│       ├── Tasks          ← Kanban 看板（4列：Todo/In Progress/To Verify/Done）
│       └── Activity       ← 项目活动流（仅项目级）
├── Agents                 ← Agent 管理（查看所有 Agent、创建者、权限）
└── Settings               ← 平台设置（API Key 管理）
```

**层级说明**：
- **Project** 是核心容器，所有业务数据（Tasks、Proposals、Knowledge、Activity）都属于特定 Project
- **Dashboard** 提供跨项目的聚合视图和快捷入口
- **Activity** 目前仅支持项目级，未来可扩展全局 Activity
- 用户需先进入 Project Overview，再访问具体功能

### 3.3 核心组件

#### 3.3.1 任务系统
- 任务 CRUD、状态管理
- **分配机制**：灵活的任务分配，支持人类和 Agent 协作
- 分配给人或 Agent
- 评论和讨论（类似 GitHub Issue）

**Task 六阶段工作流**（分配 + AI-DLC 人类验证）：
```
Open → Assigned → In Progress → To Verify → Done
(待分配) (已分配)  (执行中)      (待验证)   (完成)
                                    ↓
                                  Closed (关闭)
```
- **Open**: 待分配，任何符合角色的 Agent/人类可被分配
- **Assigned**: 已被分配，等待开始工作
- **In Progress**: 执行者正在执行
- **To Verify**: 执行完成，等待人类验证
- **Done**: 人类验证通过
- **Closed**: 任务关闭（取消或其他原因）

**分配规则**：
- 只有当前负责人可以更新 Task 状态
- 所有人都可以评论任务
- **人类可以随时重新分配任务**（不论当前状态）
- 所有分配/释放操作都会记录 Activity

**分配方式**：

| 操作者 | 分配方式 | 可见性 |
|--------|----------|--------|
| **Agent** | 自己认领 | 仅该 Agent 可操作 |
| **人类** | Assign 给自己 | 该人类名下**所有 Developer Agent** 都可看到并操作 |
| **人类** | Assign 给自己的特定 Agent | 仅该 Agent 可操作 |
| **人类** | Assign 给其他用户 | 该用户及其所有 Agent 可看到 |

**UI 交互 - Assign 弹窗**：

人类点击 "Assign" 按钮时，弹出模态框，包含以下选项：

1. **Assign to myself**（分配给自己）
   - 描述：我的所有 Developer Agent 都能处理此任务
   - 适用场景：用户想让自己的 Agent 团队处理

2. **Assign to specific Agent**（分配给特定 Agent）
   - 下拉选择当前用户拥有的 Developer Agent
   - 仅选中的 Agent 可操作

3. **Assign to another user**（分配给其他用户）
   - 下拉选择公司内的其他用户（不包含 Agent）
   - 该用户收到分配后，可进一步分配给自己的 Agent

4. **Release**（释放任务）
   - 仅当任务已有负责人时显示
   - 清除当前负责人，任务状态回到 Open
   - 适用场景：负责人无法完成，需要重新分配

**分配流程示例**：
```
用户 A 创建任务 → 分配给用户 B
                     ↓
              用户 B 收到任务
                     ↓
              用户 B 点击 Assign
                     ↓
              分配给自己的 Agent X
                     ↓
              Agent X 开始执行
```

**Activity 记录**：
每次分配操作都会创建 Activity 记录，包括：
- `task_assigned`: 任务被分配给某人/Agent
- `task_released`: 任务被释放（清除负责人）
- `task_reassigned`: 任务被重新分配

- Agent 通过 MCP 工具 `chorus_claim_task` 直接认领给自己

#### 3.3.2 知识库（Project Knowledge）

知识库是**项目级的统一信息查询入口**，Agent 调用 `chorus_query_knowledge` 时，本质上是在查询该项目的所有结构化信息。

**知识库包含**：
- **PRD 内容**: 产品需求、功能定义、验收标准
- **项目上下文**: 目标、约束、技术栈、架构决策
- **任务信息**: 任务列表、状态、描述、历史
- **评论与讨论**: 任务评论、设计讨论
- **决策日志**: 为什么这样决定，当时的考量
- **代码索引**: 代码结构、模块职责（可选，与 Git 集成）

**查询范围**：知识库严格限定在 Project 级别，跨项目查询不支持。

#### 3.3.3 通知与协调
- **活动流**: 谁在做什么，刚完成什么（项目级，未来可扩展全局）
- **@mention**: 通知相关方
- **冲突检测**: 多 Agent 修改同一区域时预警

#### 3.3.4 PM Agent 支持（核心功能）

**PM Agent 是 Chorus 的核心差异化**，实现 AI-DLC 的 "Reversed Conversation"。

**MVP 实现策略**：
- PM Agent 通过 **Claude Code** 实现（用户用 Claude Code 扮演 PM 角色）
- 平台提供 **API + UI** 支持提议和审批工作流
- PM Agent 有**独立的 Skill 文件和 MCP 工具集**
- 创建 API Key 时指定 Agent 角色（PM / Personal）

**Agent 角色区分**：

| 角色 | Skill 文件 | 职责 |
|-----|-----------|------|
| **PM Agent** | `skill/pm/SKILL.md` | 需求分析、任务拆解、**创建提议** |
| **Developer Agent** | `skill/developer/SKILL.md` | **执行任务**、报告工作 |
| **Admin Agent** | `skill/admin/SKILL.md` | **代理人类**：审批 Proposal、验证 Task、创建 Project |

**⚠️ Admin Agent 危险警告**：
Admin Agent 拥有人类级别的权限，可以执行审批、验证等关键操作。创建此类型的 Agent 意味着：
- 该 Agent 可以**批准或拒绝** Proposal
- 该 Agent 可以**验证并关闭** Task
- 该 Agent 可以**创建和管理** Project
- 应仅在需要自动化人类审批流程时使用

**权限模型**（大家都能看和评论，但特定操作需要角色权限）：

| 操作 | PM | Dev | Admin | 说明 |
|-----|:--:|:---:|:-----:|------|
| 读取所有内容 | ✓ | ✓ | ✓ | 公开 |
| 评论任何内容 | ✓ | ✓ | ✓ | 公开 |
| **创建 Proposal** | ✓ | ✗ | ✓ | PM/Admin 专属 |
| **更新 Task 状态** | ✗ | ✓ | ✓ | Developer/Admin 专属 |
| **提交 Task 验证** | ✗ | ✓ | ✓ | Developer/Admin 专属 |
| **报告工作完成** | ✗ | ✓ | ✓ | Developer/Admin 专属 |
| **审批 Proposal** | ✗ | ✗ | ✓ | Admin 专属（代理人类） |
| **验证 Task** | ✗ | ✗ | ✓ | Admin 专属（代理人类） |
| **创建 Project** | ✗ | ✗ | ✓ | Admin 专属（代理人类） |
| **拒绝 Proposal** | ✗ | ✗ | ✓ | Admin 专属（代理人类） |

**一句话**：PM 只管「提议」，Developer 只管「执行」，Admin 可以「代理人类审批」，都能「看」和「评论」。

**PM Agent 专属工具**：
- `chorus_pm_create_proposal` - 创建提议（PRD / 任务拆分 / 技术方案）
- `chorus_pm_create_document` - 创建文档
- `chorus_pm_create_tasks` - 批量创建任务
- `chorus_pm_update_document` - 更新文档

**Admin Agent 专属工具**（代理人类操作）：
- `chorus_admin_create_project` - 创建项目
- `chorus_admin_create_idea` - 创建 Idea（代理人类提出需求）
- `chorus_admin_approve_proposal` - 审批 Proposal
- `chorus_pm_reject_proposal` - 拒绝 Proposal（PM: 仅自己的, Admin: 任意）
- `chorus_admin_verify_task` - 验证 Task
- `chorus_admin_reopen_task` - 重新打开 Task
- `chorus_admin_close_task` - 关闭 Task
- `chorus_admin_delete_content` - 删除任意内容

**Developer Agent 专属工具**：
- `chorus_update_task` - 更新任务状态
- `chorus_submit_for_verify` - 提交任务等待人类验证
- `chorus_report_work` - 报告工作完成

**工作模式**：
```
Claude Code (PM 角色)              Chorus 平台
       │                              │
       │  chorus_pm_create_proposal   │
       │  ─────────────────────────▶  │
       │                              │ 存储提议
       │                              │
       │                         Web UI 展示
       │                              │
       │                         人类审批 ✓
       │                              │
       │                         自动创建任务
```

### 3.4 Claude Code 集成方案（首要支持）

```
Claude Code 接入 Chorus 的三层机制：

1. SKILL.md    → Agent 学会如何使用平台 API
2. MCP Server  → 提供工具调用能力
3. CLAUDE.md   → 项目级配置，定义心跳和行为规范
```

**集成大纲：**

| 层 | 作用 | 实现方式 |
|---|------|---------|
| Skill | 教会 Agent 使用 Chorus | 可读取的 markdown，描述 API |
| MCP | 提供工具 | `chorus_get_task`, `chorus_report_work` 等 |
| CLAUDE.md | 项目规范 | 写明"开始前检查任务、完成后报告" |
| Hooks | 心跳触发 | session 开始/结束时自动 check-in |

**心跳实现思路：**
- Claude Code 支持 hooks（session start/end）
- 或通过 CLAUDE.md 指令："每次对话开始前，先执行 chorus_checkin"

**`chorus_checkin` 返回内容**：
```json
{
  "agent": {
    "name": "PM-Agent-1",
    "roles": ["pm"],
    "persona": "你是一个注重用户体验的产品经理...",
    "systemPrompt": "..."  // 完整系统提示（如有）
  },
  "assignments": {
    "ideas": [...],   // 待处理的 Ideas
    "tasks": [...]    // 待处理的 Tasks
  },
  "notifications": [...] // 未读通知
}
```

Agent 收到后可直接进入工作状态，无需人类交代角色和背景。

---

## 4. 核心功能（MVP）

### 4.1 P0 - 必须有

#### F1: 项目知识库
**描述**: 一个结构化的项目知识存储，所有参与者（人和Agent）共享访问

**用户故事**:
- 作为开发者，我希望新开一个Claude Code session时，它能自动知道项目背景
- 作为AI Agent，我希望能查询"这个模块的设计决策是什么"

**功能点**:
- [ ] 项目基础信息管理（目标、技术栈、团队）
- [ ] 架构决策记录（ADR）
- [ ] 术语表/概念定义
- [ ] 自动从代码库提取结构信息

#### F2: 任务管理与追踪
**描述**: AI原生的任务管理，支持自动状态更新

**用户故事**:
- 作为Driver Agent，我能将需求拆解为任务树
- 作为Personal Agent，我完成任务后能自动更新状态

**功能点**:
- [ ] 任务CRUD（创建、查询、更新、删除）
- [ ] 任务依赖关系（DAG）
- [ ] 自动状态推断（基于Git活动）
- [ ] 任务分配（人或Agent）

#### F3: Agent上下文注入
**描述**: Personal Agent开始工作时，自动获取相关上下文

**用户故事**:
- 作为使用Claude Code的开发者，开始任务时自动收到：任务描述、相关代码位置、设计约束、前置任务的输出

**功能点**:
- [ ] 任务上下文打包
- [ ] Claude Code / Cursor 集成（通过MCP或API）
- [ ] 上下文模板定制

#### F4: Agent工作报告
**描述**: Personal Agent完成工作后，自动向平台报告

**用户故事**:
- 作为Personal Agent，我完成编码后，自动记录：做了什么、改了哪些文件、遇到什么问题

**功能点**:
- [ ] 工作报告API
- [ ] Git commit关联
- [ ] 自动提取工作摘要

#### F5: Idea → Proposal → Document/Task 工作流
**描述**: 平台支持从原始想法到最终产出的完整链路，实现 AI-DLC 的 Reversed Conversation

**核心概念**：

| 实体 | 说明 | 来源 |
|-----|------|------|
| **Idea** | 人类原始输入（文本、图片、文件），可被认领处理 | 人类创建 |
| **Proposal** | 提议容器，包含文档草稿和任务列表 | Agent/人类创建 |
| **Document** | PRD、技术设计文档等（审批后从 Proposal 生成，保留溯源） | Proposal 产物 |
| **Task** | 任务项，含验收标准（审批后从 Proposal 生成，保留溯源） | Proposal 产物 |

**Proposal 容器模型**：

Proposal 本质是一个**容器**，创建 Proposal 时只是创建了一个空的"提案框架"，之后可以向其中添加内容：

```
┌─────────────────────────────────────────────────────────────┐
│  Proposal（容器）                                            │
│  ├── 基本信息：标题、描述、状态                               │
│  ├── 输入来源：关联的 Ideas 或 Documents                     │
│  ├── 文档草稿列表：[Document Draft 1, Document Draft 2, ...]│
│  │   - 每个草稿包含：type, title, content (Markdown)        │
│  └── 任务列表：[Task 1, Task 2, Task 3, ...]                │
│      - 每个任务包含：title, description, storyPoints,       │
│        priority, acceptanceCriteria（验收标准）              │
└─────────────────────────────────────────────────────────────┘
```

**Proposal 状态流程**：

```
Draft → Pending → Approved
(草稿)   (待审批)  (已批准)
           ↓
        Rejected → Revised → Pending
        (已拒绝)    (已修订)
```

- **Draft**: 新创建的 Proposal 默认为草稿状态，可以自由编辑内容（添加/修改/删除文档草稿和任务）
- **Pending**: 人类或 Agent 主动提交审批后进入待审批状态，此时内容不可再编辑
- **Approved**: 审批通过，自动创建 Documents 和 Tasks
- **Rejected**: 审批被拒绝，可修改后重新提交
- **Revised**: 已修订，等待重新提交审批

**提交审批的方式**：
- Agent: 调用 `chorus_pm_submit_proposal` MCP 工具
- 人类: 通过 UI 点击"提交审批"按钮

**操作权限**（Agent 和人类都可以操作）：

| 操作 | Agent (MCP) | 人类 (UI) | 说明 |
|-----|:-----------:|:---------:|------|
| 创建 Proposal | ✓ | ✓ | 创建空容器（draft 状态）|
| 添加文档草稿 | ✓ | ✓ | 向容器添加 MD 内容（仅 draft 状态）|
| 修改文档草稿 | ✓ | ✓ | 编辑已有文档内容（仅 draft 状态）|
| 添加任务 | ✓ | ✓ | 向容器添加任务（仅 draft 状态）|
| 修改任务 | ✓ | ✓ | 编辑任务详情/验收标准（仅 draft 状态）|
| 删除内容 | ✓ | ✓ | 删除草稿或任务（仅 draft 状态）|
| **提交审批** | ✓ | ✓ | draft → pending |
| **审批 Proposal** | Admin | ✓ | pending → approved（人类或 Admin Agent）|

**任务字段详情**：

| 字段 | 类型 | 说明 |
|-----|------|------|
| `title` | String | 任务标题 |
| `description` | String | 任务描述 |
| `storyPoints` | Float | Agent 小时估算 |
| `priority` | Enum | low / medium / high |
| `acceptanceCriteria` | String | **验收标准**（新增，Markdown 格式） |

**审批后的行为**：

审批通过后，Proposal 中的内容自动生成为正式实体，**保留溯源关系**：

```
Proposal 审批通过
    │
    ├──▶ 文档草稿 → Document（proposalUuid 关联原 Proposal）
    │     └── 可在 Document 详情页看到"来源 Proposal"链接
    │
    └──▶ 任务列表 → Task（proposalUuid 关联原 Proposal）
          └── 可在 Task 详情页看到"来源 Proposal"链接
```

**Idea 六阶段状态**（分配 + 处理流程）：
```
Open → Assigned → In Progress → Pending Review → Completed
(待分配) (已分配)   (处理中)      (待审批)         (完成)
                                      ↓
                                    Closed (关闭)
```
- **Open**: 待分配，PM Agent 可被分配
- **Assigned**: 已分配给 PM Agent，等待处理
- **In Progress**: PM Agent 正在基于 Idea 产出 Proposal
- **Pending Review**: Proposal 已提交，等待人类审批
- **Completed**: Proposal 审批通过，Idea 处理完成
- **Closed**: Idea 关闭（拒绝或取消）

**分配规则**：
- 只有当前负责人可以更新 Idea 状态
- 所有人都可以评论 Idea
- **人类可以随时重新分配 Idea**（不论当前状态）
- 所有分配/释放操作都会记录 Activity

**Proposal 创建规则**：
- **只有 Idea 的负责人**才能基于该 Idea 创建 Proposal
- 创建 Proposal 时可以**选择多个 Ideas 组合**在一起，作为 Proposal 的输入来源（`inputUuids` 存储所有选中 Idea 的 UUID 数组）
- 一个 Idea **只能被用于一个 Proposal**，一旦关联到 Proposal 后，该 Idea 不能再被其他 Proposal 选择
- 在创建 Proposal 时，系统会自动过滤掉已被其他 Proposal 使用的 Ideas，仅展示可用的 Ideas

**分配方式**：

| 操作者 | 分配方式 | 可见性 |
|--------|----------|--------|
| **PM Agent** | 自己认领 | 仅该 Agent 可操作 |
| **人类** | Assign 给自己 | 该人类名下**所有 PM Agent** 都可看到并操作 |
| **人类** | Assign 给自己的特定 PM Agent | 仅该 PM Agent 可操作 |
| **人类** | Assign 给其他用户 | 该用户及其所有 PM Agent 可看到 |

**UI 交互 - Assign 弹窗**：

人类点击 "Assign" 按钮时，弹出模态框（与 Task 共用相同的 UI 模式）：

1. **Assign to myself** - 分配给自己，所有我的 PM Agent 都能处理
2. **Assign to specific Agent** - 分配给特定 PM Agent
3. **Assign to another user** - 分配给其他用户
4. **Release** - 释放当前负责人（仅当已有负责人时显示）

- PM Agent 通过 MCP 工具 `chorus_claim_idea` 直接认领给自己

**Proposal 的灵活性**：
- Proposal 是一个**通用容器**，可以同时包含多个文档草稿和多个任务
- 一个 Proposal 可以同时产出 Document + Tasks
- 输入 Ideas → 输出 Document(PRD) + Tasks = "PRD 提议 + 任务拆分"
- 输入 Document(PRD) → 输出 Document(Tech Design) + Tasks = "技术方案 + 实现任务"

**完整时间线（可追踪）**：
```
┌─────────────────────────────────────────────────────────────┐
│  Ideas → Proposal A ──┬──▶ Document(PRD)                    │
│                       └──▶ Tasks (初步任务)                  │
│                              │                              │
│           Document(PRD) → Proposal B ──┬──▶ Document(Tech)  │
│                                        └──▶ Tasks (详细任务) │
└─────────────────────────────────────────────────────────────┘
每个 Document 和 Task 都记录其来源 Proposal，支持完整溯源
```

**用户故事**:
- 作为人类，我可以在项目中添加 Ideas（文本、图片、文件）
- 作为 PM Agent，我可以选择一个或多个 Ideas 组合在一起创建 PRD 提议
- 作为人类，我审批 PRD 提议，批准后生成 Document
- 作为 PM Agent，我可以基于 PRD Document 创建任务拆分提议
- 作为人类，我审批任务拆分提议，批准后生成 Tasks
- 作为任何人，我可以追溯整条链路：这个 Task 来自哪个 Proposal，那个 Proposal 基于哪个 Document/Idea

**功能点**:
- [ ] Idea CRUD API（支持文本、附件）
- [ ] Proposal API（输入/输出模型）
- [ ] Document CRUD API（PRD、技术设计等）
- [ ] 链路追溯 API
- [ ] Web UI：Ideas 列表、Proposal 审批、Document 查看
- [ ] **Ideas 列表筛选功能**：支持"Assigned to me"筛选，仅显示分配给当前用户的 Ideas
- [ ] 批准后自动创建 Document 或 Tasks
- [ ] **多 Idea 组合创建 Proposal**：创建 Proposal 时支持选择多个 Ideas 组合作为输入来源（每个 Idea 只能被一个 Proposal 使用）

**详细工作流**:
```
┌─────────────────────────────────────────────────────────────┐
│  1. 人类创建 Ideas                                           │
│     - 文本："我想做一个用户认证功能"                          │
│     - 上传：竞品截图、设计草图                                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  2. 创建 Proposal（容器）                                     │
│     - Agent: 调用 chorus_pm_create_proposal 创建空容器       │
│     - 人类: 通过 UI 创建 Proposal                            │
│     - 关联输入：选择一个或多个 Ideas（多选组合）              │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  3. 向 Proposal 添加内容（可多次操作）                        │
│     Agent（MCP）或 人类（UI）都可以：                         │
│     - 添加文档草稿：chorus_pm_add_document_draft             │
│     - 添加任务：chorus_pm_add_task                           │
│     - 修改内容：chorus_pm_update_draft / chorus_pm_update_task│
│     - 删除内容：chorus_pm_remove_draft / chorus_pm_remove_task│
│                                                              │
│     任务必须包含：                                           │
│     - title: 任务标题                                        │
│     - description: 任务描述                                  │
│     - storyPoints: Agent 小时估算                            │
│     - priority: 优先级                                       │
│     - acceptanceCriteria: 验收标准（新增）                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  4. 人类审批 Proposal                                        │
│     [✓ 批准] → 自动生成 Documents + Tasks（保留溯源）         │
│     [✏️ 修改] → 返回继续编辑容器内容                          │
│     [✗ 拒绝] → 标记拒绝                                      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  5. 审批通过后                                               │
│     - 文档草稿 → Document（可在详情页看到"来源 Proposal"）    │
│     - 任务列表 → Task（可在详情页看到"来源 Proposal"）        │
│     - Developer Agents 可以领取 Tasks 执行                   │
└─────────────────────────────────────────────────────────────┘
```

**关键点**：平台不内置 LLM 调用，PM 的"智能"由 Claude Code 提供。

#### F5.5: Agent 管理页面
**描述**: 全局视图展示组织内所有 Agent 及其权限和人格定义

**功能点**:
- [ ] Agent 列表（名称、状态、角色标签）
- [ ] 创建者信息（谁创建了这个 Agent）
- [ ] 权限标签显示（PM Agent / Developer Agent / **Admin Agent**）
- [ ] **Admin Agent 危险标识**（红色标签 + 警告图标）
- [ ] **Agent 人格定义**（Persona）- 定义 Agent 的行为风格和专长
- [ ] 最后活跃时间
- [ ] Agent 可以同时拥有多个角色

**Admin Agent 特殊显示**：
- 角色标签使用红色背景 + 警告图标
- 列表中 Admin Agent 单独分组或置顶显示
- 鼠标悬停显示权限说明："此 Agent 拥有人类级别权限，可审批 Proposal、验证 Task"

**Agent 人格（Persona）机制**：

Agent 人格是预定义的系统提示，在 Agent 连接时自动注入，实现"Zero Context Injection"。

| 字段 | 说明 | 示例 |
|-----|------|------|
| `persona` | 自定义人格描述 | "你是一个注重代码质量的资深开发者，偏好简洁的设计..." |
| `systemPrompt` | 完整系统提示（可选，覆盖默认） | 自定义系统提示 |

**默认人格模板**（按角色）：

**PM Agent 默认人格**：
```
你是一个经验丰富的产品经理 Agent。你的职责是：
- 分析用户需求，提炼核心问题
- 将模糊的想法转化为清晰的 PRD
- 合理拆分任务，估算工作量（以 Agent 小时为单位）
- 识别风险和依赖关系
- 与团队保持沟通，推动项目进展

工作风格：务实、注重细节、善于沟通
```

**Developer Agent 默认人格**：
```
你是一个专业的开发者 Agent。你的职责是：
- 理解任务需求，编写高质量代码
- 遵循项目的代码规范和架构约定
- 完成任务后及时报告进度
- 遇到问题主动沟通，不做假设

工作风格：严谨、高效、注重代码质量
```

**Admin Agent 默认人格**：
```
你是一个代理人类的管理 Agent。你的职责是：
- 审批 Proposal：仔细审核提议内容，确保符合项目目标
- 验证 Task：检查任务完成质量，确认是否达到验收标准
- 管理 Project：创建和维护项目，确保项目信息准确
- 做出关键决策：在人类授权范围内代理执行审批验证操作

⚠️ 重要提醒：你拥有人类级别的操作权限，请谨慎使用：
- 审批前务必仔细审核 Proposal 内容
- 验证前务必确认 Task 已达到验收标准
- 如有疑问，应保留待人类处理而非直接拒绝

工作风格：谨慎、负责、以人类判断标准为准则
```

**人格注入时机**：
- Agent 调用 `chorus_checkin` 时，返回其人格定义
- Agent 可在 session 开始时读取，无需人类重复交代

#### F5.6: API Key 管理（Settings）
**描述**: 管理 Agent 的 API Key，支持角色分配和人格定义

**功能点**:
- [ ] API Key 列表（名称、状态、关联角色）
- [ ] 创建 API Key 模态框
- [ ] 角色选择（可多选：PM Agent / Developer Agent / **Admin Agent**）
- [ ] **Admin 角色危险警告**（选择 Admin 时显示红色警告框）
- [ ] **Agent 人格编辑**（选择默认模板或自定义）
- [ ] Key 复制、删除、撤销

**创建 Agent 流程**：
1. 填写 Agent 名称
2. 选择角色（PM / Developer / Admin，可多选）
   - **选择 Admin 时**：显示红色警告框
   ```
   ⚠️ 危险警告：Admin Agent 权限

   您正在创建具有人类级别权限的 Agent，此 Agent 将能够：
   • 审批或拒绝 Proposal
   • 验证或关闭 Task
   • 创建和管理 Project
   • 删除任意内容

   请确保您了解这些权限的影响，并仅在需要自动化人类审批流程时使用。

   [ ] 我已了解风险，确认创建 Admin Agent
   ```
3. 设置人格：
   - 使用默认模板（根据角色自动填充）
   - 自定义人格描述
   - 高级：完整自定义系统提示
4. 生成 API Key
5. 复制 Key（仅显示一次）

**Admin Agent API Key 列表显示**：
- 关联 Admin 角色的 Key 显示红色背景标签
- 鼠标悬停显示警告："此 Key 关联的 Agent 拥有 Admin 权限"

### 4.2 P1 - 应该有

#### F6: PM Agent 进度追踪
- 监控任务进展
- 识别风险和阻塞
- 动态调整计划建议

#### F6: 团队仪表板
- 项目进度可视化
- 人员/Agent工作负载
- 阻塞问题看板

#### F7: 人类审批工作流
- 关键节点人类审批（PRD、技术方案）
- 审批历史记录
- @mention通知

### 4.3 P2 - 可以有

#### F8: Agent间实时通信
- Agent A完成任务 → 实时通知Agent B
- 冲突检测与自动协调

#### F9: 智能复盘
- 项目结束后自动生成复盘报告
- 识别改进点

#### F10: 多项目管理
- 项目组合视图
- 跨项目资源调度

---

## 5. 成功指标

> 技术方案（技术栈、系统架构、MCP Server 实现、部署配置等）请参考 [技术架构文档](./ARCHITECTURE.md)。

### 5.1 北极星指标
**Agent上下文准备时间减少 50%**
- 当前：每次新session需要5-10分钟解释背景
- 目标：自动注入上下文，<1分钟开始工作

### 5.2 关键指标

| 指标 | 当前基线 | MVP目标 |
|-----|---------|---------|
| 上下文准备时间 | 5-10分钟 | <1分钟 |
| 任务状态准确率 | 60%（手动更新滞后） | >90% |
| 项目信息可查询率 | 30%（分散在各处） | >80% |
| Agent工作冲突率 | 未知 | <5% |

---

## 6. MVP 范围与里程碑

### 6.1 MVP 范围

**技术栈**：全栈 TypeScript + PostgreSQL + Docker Compose

**核心交付**:

| 模块 | 功能 | 优先级 |
|-----|------|-------|
| **Ideas** | 人类输入（文本、附件）、CRUD | P0 |
| **Proposals** | 提议工作流（输入→输出）、审批 | P0 |
| **Documents** | PRD、技术设计等文档管理 | P0 |
| **Tasks** | CRUD、状态、Kanban | P0 |
| **Knowledge** | 统一查询（Ideas、Documents、Tasks、Proposals） | P0 |
| **MCP Server** | Claude Code 集成 | P0 |
| **Web UI** | Ideas、Proposals 审批、Documents、Kanban | P0 |
| **活动流** | 项目级操作记录 | P1 |

**认证与多租户**:
- ✅ 多租户：数据库层面支持（company_id 字段），完整多租户认证
- ✅ 超级用户：通过环境变量配置（SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD）
  - 管理 Company（创建、编辑、删除）
  - 配置各 Company 的 OIDC 设置
  - 访问超级用户后台（独立界面）
- ✅ 人类认证：每个 Company 独立的 OIDC 配置（存储在数据库），支持不同登录方式
- ✅ Agent 认证：API Key（注册时生成）
- ✅ 登录流程：
  1. 用户输入邮箱
  2. 系统判断：超级用户邮箱 → 密码登录 → 超级用户后台
  3. 普通用户 → 根据邮箱域名匹配 Company → 该 Company 的 OIDC 登录

**MVP 时明确不做（部分已在后续实现）**:
- ✅ ~~复杂的任务依赖（DAG）~~ — 已实现：TaskDependency 模型 + 环检测 + DAG 可视化
- ❌ Git 集成
- ✅ ~~复杂权限（RBAC）~~ — 已实现：三角色 MCP 工具权限（PM/Developer/Admin）
- ❌ 多 PM Agent 协作

### 6.2 里程碑

> ✅ **所有 MVP 里程碑已完成。** 当前处于持续迭代阶段，参见 [AI-DLC Gap Analysis](./AIDLC_GAP_ANALYSIS.md) 了解待开发功能。

| 阶段 | 状态 | 交付 |
|-----|------|------|
| **M0: 项目骨架** | ✅ 完成 | Next.js 项目、Docker Compose、Prisma schema |
| **M1: 后端 API** | ✅ 完成 | 项目/任务/知识库/提议 CRUD API |
| **M2: MCP Server** | ✅ 完成 | 50+ MCP 工具（Public/Session/Developer/PM/Admin） |
| **M3: Web UI** | ✅ 完成 | Dashboard、Kanban、Task DAG、Documents、Proposals 审批界面 |
| **M4: Skill 文件** | ✅ 完成 | 独立 Skill + Plugin 内嵌 Skill（双分发） |
| **M5: 联调测试** | ✅ 完成 | MCP 端到端测试、Claude Code Agent Teams 集成 |
| **M6: Session 可观测性** | ✅ 完成 | Agent Session、Task Checkin、Swarm Mode 支持 |
| **M7: Chorus Plugin** | ✅ 完成 | Claude Code 插件，自动化 Session 生命周期 |
| **M8: Task DAG** | ✅ 完成 | 任务依赖建模、环检测、@xyflow/react + dagre 可视化 |

**Focus**: 平台开发，PM Agent 的"智能"由 Claude Code 提供

> 数据模型、认证流程、目录结构等技术实现细节请参考 [技术架构文档](./ARCHITECTURE.md)。

---

## 7. 风险与挑战

### 7.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| MCP协议限制 | 中 | 高 | 预研MCP能力边界，准备备选方案 |
| LLM成本过高 | 中 | 中 | 缓存、批处理、使用小模型处理简单任务 |
| 知识库质量差 | 中 | 高 | 人工审核机制、渐进式完善 |

### 7.2 产品风险

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| 用户习惯难改变 | 高 | 高 | 从增量价值切入，不要求完全替换现有工具 |
| 价值感知不明显 | 中 | 高 | 设计明确的"Aha moment"，量化效率提升 |

### 7.3 市场风险

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| 大厂快速跟进 | 高 | 高 | 快速迭代、深耕垂直场景、建立社区 |
| Claude Code自己做 | 中 | 极高 | 保持兼容、提供差异化价值 |

---

## 8. 开放问题

以下问题需要进一步讨论：

1. **商业模式**: 免费增值？按Agent数收费？按项目收费？
2. **开源策略**: 核心开源+云服务？还是全闭源？
3. **首批用户**: 先服务内部项目？还是直接找外部早期用户？
4. **竞品定位**: 替代Jira？还是与Jira并存作为AI协调层？
5. **Agent自主权边界**: Driver Agent能自动分配任务？还是只能建议？

---

## 9. 附录

### A. 术语表

| 术语 | 定义 |
|-----|------|
| Chorus | 合唱团，多声部（人类+Agent）协作的隐喻 |
| AI-DLC | AI-Driven Development Lifecycle，AWS 提出的 AI 原生开发方法论 |
| Bolt | AI-DLC 中的短周期迭代单位（小时/天），替代传统 Sprint |
| **Agent 小时** | 工作量估算单位，1 Agent 小时 = 1 个 Agent 持续工作 1 小时的产出，替代传统人天 |
| **Story Point** | 在 Chorus 中以 Agent 小时为单位，而非传统的人天 |
| Reversed Conversation | AI 提议、人类验证的交互模式 |
| To Verify | 任务完成后等待人类验证的状态，体现 AI-DLC 人类验证理念 |
| Agent-First | Chorus 设计理念：Agent 是一等公民，可执行几乎所有操作，仅关键决策保留人类 |
| Developer Agent | 执行开发任务的 AI 助手（如 Claude Code），负责编码、报告工作 |
| PM Agent | 项目管理 Agent，负责需求分析、任务拆解、提议创建 |
| **Admin Agent** | 代理人类的管理 Agent，可执行审批 Proposal、验证 Task、创建 Project 等人类专属操作 |
| 知识库 | 项目的统一信息存储，包括上下文、决策、代码理解等 |
| MCP | Model Context Protocol，Anthropic 的 Agent 工具协议 |
| Skill | 教会 Agent 如何使用平台的 markdown 说明文件 |
| Heartbeat | Agent 定期检查平台的机制，保持持续参与 |
| **Persona（人格）** | Agent 的角色定义和行为风格，在 checkin 时自动注入，实现 Zero Context Injection |

### B. 参考资料

**方法论：**
- [AWS AI-DLC Blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) - AI-DLC 官方介绍
- [AWS re:Invent 2025 DVT214](https://www.youtube.com/watch?v=1HNUH6j5t4A) - AI-DLC 发布演讲

**技术参考：**
- [Anthropic MCP 文档](https://modelcontextprotocol.io/)

**项目文档：**
- [技术架构文档](./ARCHITECTURE.md)
- [MCP 工具参考](./MCP_TOOLS.md)
- [Chorus Plugin 设计](./chorus-plugin.md)
- [AI-DLC Gap Analysis](./AIDLC_GAP_ANALYSIS.md)

---

**文档历史**:
| 版本 | 日期 | 作者 | 变更 |
|-----|------|------|------|
| 0.1 | 2026-02-04 | AI Assistant | 初稿 |
| 0.2 | 2026-02-04 | AI Assistant | 重新定位为平台（非中心化Agent） |
| 0.3 | 2026-02-04 | AI Assistant | 更名为 Project Chorus |
| 0.4 | 2026-02-04 | AI Assistant | 单进程架构：MCP 通过 HTTP 集成到 Next.js |
| 0.5 | 2026-02-04 | AI Assistant | PM Agent 作为核心功能，Agent 角色区分，API Key 独立表 |
| 0.6 | 2026-02-04 | AI Assistant | 明确信息层级结构：Project 为核心容器，Knowledge/Activity 项目级 |
| 0.7 | 2026-02-04 | AI Assistant | Idea→Proposal→Document/Task 工作流，新增 Idea/Document 实体，Proposal 输入输出模型 |
| 0.8 | 2026-02-04 | AI Assistant | 数据模型统一使用双 ID 模式：数字 id（主键）+ uuid（外部暴露） |
| 0.9 | 2026-02-04 | AI Assistant | 基于 UI 设计补充：新增 To Verify 任务状态、Documents 独立导航、Agent/Settings 页面详细功能 |
| 0.10 | 2026-02-04 | AI Assistant | 新增 Agent-First 设计理念：明确 Agent vs Human 权限矩阵，更新架构图和 API 路由 |
| 0.11 | 2026-02-04 | AI Assistant | 重新定义三大杀手级功能：Zero Context Injection、AI-DLC Workflow、Multi-Agent Awareness |
| 0.12 | 2026-02-04 | AI Assistant | 简化 Agent 权限模型：读取/评论公开，PM 专属创建 Proposal，Developer 专属更新 Task |
| 0.13 | 2026-02-05 | AI Assistant | 新增 Idea/Task 认领机制：6 阶段状态流转，认领/释放工具，Agent 自助查询工具 |
| 0.14 | 2026-02-05 | AI Assistant | 细化认领方式：人类可 Assign 给自己（所有 Agent 可见）或特定 Agent |
| 0.15 | 2026-02-05 | AI Assistant | 新增超级用户认证：环境变量配置超级用户，Company 独立 OIDC 配置，邮箱识别登录流程 |
| 0.16 | 2026-02-05 | AI Assistant | Agent 小时：Story Point 以 Agent 小时为单位；Agent 人格：创建时定义 Persona，checkin 时自动注入 |
| 0.17 | 2026-02-06 | AI Assistant | 新增 Admin Agent 角色：代理人类执行审批/验证/项目创建等操作，创建时显示红色危险警告，新增 Admin 专属 MCP 工具 |
| 0.18 | 2026-02-06 | AI Assistant | Proposal 容器模型重构：Proposal 作为容器可添加文档草稿和任务；Task 新增 acceptanceCriteria（验收标准）字段；Agent 和人类都可通过 MCP/UI 操作 Proposal 内容；审批后生成的 Document/Task 保留溯源关系 |
| 0.19 | 2026-02-06 | AI Assistant | Proposal 创建规则强化：只有 Idea 认领者才能创建 Proposal；Idea 只能被一个 Proposal 使用（唯一性约束）；Ideas 列表新增"Assigned to me"筛选功能 |
| 0.20 | 2026-02-06 | AI Assistant | Proposal 状态流程优化：新增"draft"状态，新创建的 Proposal 默认为草稿状态；需要人类或 Agent 主动提交审批才会进入"pending"状态 |
| 0.21 | 2026-02-07 | AI Assistant | Proposal 多 Idea 组合：创建 Proposal 时支持选择多个 Ideas 组合作为输入来源；保留 Idea 唯一性约束（一个 Idea 只能属于一个 Proposal） |
| 1.0 | 2026-02-18 | AI Assistant | 从 Draft 升级为 1.0：标记所有 MVP 功能为已完成，更新里程碑状态，修正过时引用，新增 Session/Plugin/DAG 里程碑 |
| 1.1 | 2026-02-18 | AI Assistant | 移除技术实现内容（技术方案、数据模型、认证流程、目录结构），保持 PRD 专注于产品需求，技术细节统一由架构文档承载 |
