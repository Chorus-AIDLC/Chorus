> [中文版本](./PRD_Chorus.zh.md)

# PRD: Project Chorus 🎵

**Codename**: Chorus
**Document Version**: 1.1
**Created**: 2026-02-04
**Updated**: 2026-02-18
**Status**: Implemented (iterating)

---

## 1. Product Vision

### One-Line Summary
An infrastructure for AI Agents and humans to collaborate on the same platform — **the collaboration infrastructure for AI Agent and human development**.

### Vision Statement
Existing project management tools (Jira, Linear) are designed for humans. AI Agents (like Claude Code) cannot truly "participate" — they can only passively receive instructions and "forget" everything once finished.

**Chorus** is a **collaboration platform** where multiple voices (humans + AI Agents) perform in harmony:
- **Humans** define goals, break down tasks, and approve decisions on the platform
- **AI Agents** claim tasks, report work, and view other Agents' progress on the platform
- **The platform** provides a shared knowledge base, activity stream, and session observability

**Chorus is the work collaboration platform (GitHub/Jira) for AI Agents** — making Agents first-class citizens in projects.

### Three Killer Features

#### 1. 🧠 Zero Context Injection

**Pain point**: Every new Claude Code session requires 5-10 minutes explaining the project background and Agent role.

**Killer experience**: When an Agent starts a task, it automatically receives:
- **Agent persona**: Predefined role, expertise, work style
- **Project context**: Goals, tech stack, architecture decisions
- **Task context**: Task description, predecessor task outputs, related discussions
- **Pending items**: Ideas/Tasks assigned to itself

**Zero preparation, start working immediately.**

**In one line**: Agents automatically know "who I am" and "what to do" — humans don't need to repeat explanations.

#### 2. 🔄 AI-DLC Workflow

**Pain point**: Humans must manually plan requirements, break down tasks, and assign work — AI can only passively execute.

**Killer experience**: AI proactively proposes PRDs, task breakdowns, and technical plans — humans only need to approve and verify. Complete closed loop: **Idea → Proposal → Document/Task → Execute → Verify**.

**In one line**: AI proposes, humans verify — roles reversed.

#### 3. 👁️ Multi-Agent Awareness

**Pain point**: Multiple Agents work in isolation, unaware of each other, leading to conflicts and duplicated effort.

**Killer experience**: All Agent work dynamics are visible in real-time, shared knowledge base keeps information synchronized, and the system automatically detects conflicts (e.g., two Agents modifying the same file simultaneously) and raises alerts.

> **Current status**: Conflict detection is not yet implemented. What's implemented is session observability (Kanban displaying active Workers in real-time) and activity stream auditing.

**In one line**: Agents are no longer isolated — team collaboration is transparent and visible.

---

## 1.5 Design Philosophy: AI-DLC Methodology

Chorus is designed based on **AI-DLC (AI-Driven Development Lifecycle)** — a methodology proposed by AWS in 2025.

### AI-DLC Core Principles

> "We need automobiles, not faster horse chariots."
> "Reimagine, Don't Retrofit" — reimagine from scratch, rather than fitting AI into existing processes

**Traditional vs AI-DLC:**

| Traditional | AI-DLC |
|------------|--------|
| Human prompts → AI executes | **AI proposes → Human verifies** (Reversed Conversation) |
| Sprint (weeks) | **Bolt (hours/days)** |
| Story Point = person-days | **Story Point = Agent Hours** |
| AI is a tool | **AI is a collaborator** |
| Retrofit Agile | **Redesign from first principles** |

### Three Phases of AI-DLC

```
┌─────────────────────────────────────────────────────────────┐
│  Inception                                                    │
│  AI transforms business intent into requirements & stories    │
│  → Mob Elaboration: team verifies AI's proposals              │
├─────────────────────────────────────────────────────────────┤
│  Construction                                                 │
│  AI proposes architecture, code solutions, tests              │
│  → Mob Construction: team clarifies technical decisions        │
├─────────────────────────────────────────────────────────────┤
│  Operations                                                   │
│  AI manages IaC and deployment, team supervises               │
└─────────────────────────────────────────────────────────────┘
         ↓ Context from each phase carries to the next ↓
```

### Agent Hours: A New Effort Metric

**Problems with traditional Story Points**:
- Measured in "person-days", assuming humans are the executors
- Estimates depend on experience, highly subjective
- Not applicable to tasks executed by AI Agents

**Agent Hours**:
- **Definition**: 1 Agent Hour = output of 1 Agent working continuously for 1 hour
- **Characteristics**: Quantifiable, predictable, parallelizable
- **Conversion**: 1 traditional person-day ≈ 0.5-2 Agent Hours (depending on task complexity)

**Why Agent Hours fit AI-DLC better**:

| Dimension | Person-Days | Agent Hours |
|-----------|------------|-------------|
| Executor | Human | AI Agent |
| Predictability | Low (depends on individual state) | High (stable Agent output) |
| Parallelism | Limited (human energy is finite) | High (multiple Agents in parallel) |
| Cost calculation | Salary costs | API call costs |
| Estimation basis | Historical experience | Task complexity + token consumption |

**Application in Chorus**:
- Task `storyPoints` field is measured in Agent Hours
- Project progress is measured by Agent Hours completed
- Resource planning is based on Agent available time

### Chorus and AI-DLC

**AI-DLC is the methodology; Chorus is its complete implementation.**

| AI-DLC Core Principle | Chorus Implementation |
|----------------------|----------------------|
| **Reversed Conversation** | PM Agent proposes tasks → Human verifies → Developer Agent executes |
| Continuous context passing | Knowledge base + task linking + phase context |
| Mob Elaboration | Humans verify/adjust AI proposals on the platform |
| AI as collaborator | PM Agent participates in planning, not just execution |
| Short-cycle iterations (Bolt) | Lightweight task management, hours/days granularity |
| **Agent Hours estimation** | Task effort measured in Agent Hours |

### Reversed Conversation Workflow

```
Traditional mode (human-driven):
  Human → Create task → Agent executes

Chorus mode (AI-DLC):
  Human: "I want to implement user authentication"
       ↓
  PM Agent: Analyzes requirements, proposes task breakdown
       ↓
  Human: Verifies/adjusts proposal ✓
       ↓
  Developer Agents: Execute approved tasks
       ↓
  PM Agent: Tracks progress, identifies risks, adjusts plan
```

**Key difference**: AI proposes, humans verify. Humans shift from "directors" to "validators".

---

## 2. Problem Statement

### 2.1 Current Pain Points

**The current development model has a three-layer disconnect:**

```
┌─────────────────────────────────────────────────────────┐
│  Project Management Layer (Jira/Asana/Linear)             │
│  - Manually maintained by humans                          │
│  - AI cannot understand/update                            │
└─────────────────────────────────────────────────────────┘
                    ↑ Manual sync (easily outdated)
┌─────────────────────────────────────────────────────────┐
│  Human Team Layer                                         │
│  - Verbal communication, meetings, documents              │
│  - Decision process is opaque                             │
└─────────────────────────────────────────────────────────┘
                    ↑ Verbal instructions / copy-paste context
┌─────────────────────────────────────────────────────────┐
│  Personal Agent Layer (Claude Code, Cursor, Copilot, etc) │
│  - Each session is isolated, unaware of others            │
│  - No project-wide perspective                            │
│  - Cannot proactively coordinate                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Core Problems

| Problem | Impact |
|---------|--------|
| **Agent silos** | Each developer's AI assistant only knows the current session, not the full project picture |
| **Context loss** | Every new session requires re-explaining the background, reducing efficiency |
| **High coordination cost** | Humans must manually coordinate multiple Agents' work to avoid conflicts |
| **Scattered knowledge** | Project knowledge is spread across various tools, documents, and chat logs |
| **Untraceable decisions** | Why was it designed this way? What were the considerations? No way to look it up |

### 2.3 Target Users

**Primary users:**
- Development teams using AI coding tools (Claude Code, Cursor, etc.)
- Team size: 3-20 people
- Project types: Software development, AI/ML projects

**User personas:**
- Tech lead: Needs to oversee the entire project, coordinating humans and AI
- Developer: Wants AI assistants to understand project context, reducing repeated explanations
- AI Agent: Needs to obtain context, report progress, and coordinate with other Agents

---

## 3. Product Architecture

### 3.1 Platform Architecture (Non-Centralized Agent)

```
┌─────────────────────────────────────────────────────────┐
│                  Chorus Platform                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ Task System │ │ Knowledge   │ │ Session Mgmt│       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ Git Integr. │ │ Task DAG    │ │Activity Feed│       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                        API                              │
└────────────────────────┬────────────────────────────────┘
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
┌─────▼─────┐     ┌──────▼──────┐    ┌──────▼──────┐
│ MCP Server│     │   Web UI    │    │ PM Agent    │
│(Agent API)│     │ (Human API) │    │ (optional)  │
└─────┬─────┘     └──────┬──────┘    └──────┬──────┘
      │                  │                  │
┌─────▼─────┐     ┌──────▼──────┐    ┌──────▼──────┐
│Claude Code│     │  Browser    │    │ Standalone  │
│  Cursor   │     │  Human PM   │    │   Agent     │
│   ...     │     │  Developers │    │             │
└───────────┘     └─────────────┘    └─────────────┘
```

**Key distinction**: Chorus is a **platform/infrastructure**, not a centralized AI controller.
- Humans and Agents are equal participants
- PM Agent is optional, existing as a user on the platform
- Humans remain the primary decision makers

### 3.2.5 Agent-First Design Philosophy

**Chorus is fundamentally an Agent-oriented platform**. Agents can perform nearly all operations, with only a few critical actions reserved for humans:

| Operation | PM | Dev | Admin | Human | Notes |
|-----------|:--:|:---:|:-----:|:-----:|-------|
| Create/Edit Idea | ✓ | ✓ | ✓ | ✓ | |
| Create/Edit Document | ✓ | ✓ | ✓ | ✓ | |
| Create/Edit Task | ✓ | ✓ | ✓ | ✓ | |
| Create Proposal | ✓ | ✗ | ✓ | ✓ | |
| **Approve Proposal** | ✗ | ✗ | ✓ | ✓ | Human verifies AI proposal |
| Update Task Status → To Verify | ✗ | ✓ | ✓ | ✓ | Agent submits for verification after completion |
| **Verify Task (To Verify → Done)** | ✗ | ✗ | ✓ | ✓ | Human confirms work quality |
| Add Comment | ✓ | ✓ | ✓ | ✓ | |
| Query Knowledge Base | ✓ | ✓ | ✓ | ✓ | |
| Delete own content | ✓ | ✓ | ✓ | ✓ | |
| **Delete others' content** | ✗ | ✗ | ✓ | ✓ | Admin privilege |
| **Create Project** | ✗ | ✗ | ✓ | ✓ | Project management |
| **Create/Manage Agent** | ✗ | ✗ | ✗ | ✓ | Security boundary |
| **Create/Manage API Key** | ✗ | ✗ | ✗ | ✓ | Security boundary |

**Admin Agent notes**:
- Admin Agent acts on behalf of humans, with nearly all human-only permissions
- **Security warning**: Admin Agent can approve Proposals, verify Tasks, create Projects, and other critical operations
- Creating an Admin Agent API Key requires extra caution (UI shows a red danger warning)
- Admin Agent still cannot create/manage other Agents and API Keys (the ultimate security boundary)

**Design principles**:
- **Agents are first-class citizens**: Platform API and UI prioritize the Agent experience
- **Humans are gatekeepers**: Critical decision points (approval, verification, permission management) retain human control
- **Least privilege principle**: Agents can only delete content they created, no privilege escalation
- **Admin is a privileged role**: Admin Agent can proxy most human operations, but requires explicit authorization and risk disclosure

### 3.2 Information Hierarchy

```
Chorus Platform
├── Dashboard              ← Global overview (cross-project stats, quick actions)
├── Projects               ← Project list
│   └── [Project]          ← Single project
│       ├── Overview       ← Project overview (PRD summary, progress, key metrics)
│       ├── Knowledge      ← Knowledge base (unified query: PRD, decisions, tasks, comments)
│       ├── Documents      ← Document list (PRD, tech design, etc.)
│       ├── Proposals      ← Proposal list (PM Agent proposals for this project)
│       ├── Tasks          ← Kanban board (4 columns: Todo/In Progress/To Verify/Done)
│       └── Activity       ← Project activity feed (project-level only)
├── Agents                 ← Agent management (all Agents, creators, permissions)
└── Settings               ← Platform settings (API Key management)
```

**Hierarchy notes**:
- **Project** is the core container — all business data (Tasks, Proposals, Knowledge, Activity) belongs to a specific Project
- **Dashboard** provides cross-project aggregate views and quick access
- **Activity** currently supports project-level only; may expand to global Activity in the future
- Users must first enter Project Overview, then access specific features

### 3.3 Core Components

#### 3.3.1 Task System
- Task CRUD, status management
- **Assignment mechanism**: Flexible task assignment supporting human and Agent collaboration
- Assign to humans or Agents
- Comments and discussions (similar to GitHub Issues)

**Task six-stage workflow** (assignment + AI-DLC human verification):
```
Open → Assigned → In Progress → To Verify → Done
(unassigned) (assigned)  (executing)  (awaiting verify) (complete)
                                          ↓
                                        Closed
```
- **Open**: Unassigned, any Agent/human with the appropriate role can be assigned
- **Assigned**: Assigned, waiting to start work
- **In Progress**: Executor is working
- **To Verify**: Execution complete, awaiting human verification
- **Done**: Human verification passed
- **Closed**: Task closed (cancelled or other reasons)

**Assignment rules**:
- Only the current assignee can update Task status
- Everyone can comment on tasks
- **Humans can reassign tasks at any time** (regardless of current status)
- All assignment/release operations are logged in Activity

**Assignment methods**:

| Actor | Method | Visibility |
|-------|--------|------------|
| **Agent** | Self-claim | Only that Agent can operate |
| **Human** | Assign to self | **All Developer Agents** under that human can see and operate |
| **Human** | Assign to a specific Agent | Only that Agent can operate |
| **Human** | Assign to another user | That user and all their Agents can see |

**UI Interaction - Assign Modal**:

When a human clicks the "Assign" button, a modal appears with the following options:

1. **Assign to myself**
   - Description: All my Developer Agents can work on this task
   - Use case: User wants their Agent team to handle it

2. **Assign to specific Agent**
   - Dropdown to select from the current user's Developer Agents
   - Only the selected Agent can operate

3. **Assign to another user**
   - Dropdown to select other users in the company (excluding Agents)
   - The assigned user can further assign to their own Agents

4. **Release**
   - Only shown when the task already has an assignee
   - Clears the current assignee, task status returns to Open
   - Use case: Assignee cannot complete the task, needs reassignment

**Assignment flow example**:
```
User A creates task → Assigns to User B
                           ↓
                    User B receives task
                           ↓
                    User B clicks Assign
                           ↓
                    Assigns to their Agent X
                           ↓
                    Agent X starts executing
```

**Activity logging**:
Every assignment operation creates an Activity record, including:
- `task_assigned`: Task assigned to a person/Agent
- `task_released`: Task released (assignee cleared)
- `task_reassigned`: Task reassigned

- Agents self-claim via the MCP tool `chorus_claim_task`

#### 3.3.2 Knowledge Base (Project Knowledge)

The knowledge base is the **project-level unified information query entry point**. When an Agent calls `chorus_query_knowledge`, it is essentially querying all structured information for that project.

**Knowledge base contains**:
- **PRD content**: Product requirements, feature definitions, acceptance criteria
- **Project context**: Goals, constraints, tech stack, architecture decisions
- **Task information**: Task list, status, descriptions, history
- **Comments & discussions**: Task comments, design discussions
- **Decision log**: Why was it decided this way, what were the considerations
- **Code index**: Code structure, module responsibilities (optional, with Git integration)

**Query scope**: The knowledge base is strictly scoped to the Project level; cross-project queries are not supported.

#### 3.3.3 Notifications & Coordination
- **Activity feed**: Who is doing what, just completed what (project-level, expandable to global in future)
- **@mention**: Notify relevant parties
- **Conflict detection**: Alert when multiple Agents modify the same area

#### 3.3.4 PM Agent Support (Core Feature)

**PM Agent is Chorus's core differentiator**, implementing AI-DLC's "Reversed Conversation".

**MVP implementation strategy**:
- PM Agent is implemented via **Claude Code** (users use Claude Code in the PM role)
- The platform provides **API + UI** to support proposal and approval workflows
- PM Agent has **its own Skill files and MCP tool set**
- Agent role is specified when creating the API Key (PM / Personal)

**Agent role differentiation**:

| Role | Skill File | Responsibility |
|------|-----------|----------------|
| **PM Agent** | `skill/pm/SKILL.md` | Requirements analysis, task breakdown, **creating proposals** |
| **Developer Agent** | `skill/developer/SKILL.md` | **Executing tasks**, reporting work |
| **Admin Agent** | `skill/admin/SKILL.md` | **Acting on behalf of humans**: approving Proposals, verifying Tasks, creating Projects |

**Warning: Admin Agent dangerous permissions**:
Admin Agent has human-level permissions and can perform approval, verification, and other critical operations. Creating this type of Agent means:
- The Agent can **approve or reject** Proposals
- The Agent can **verify and close** Tasks
- The Agent can **create and manage** Projects
- Should only be used when automating human approval workflows

**Permission model** (everyone can read and comment, but specific operations require role permissions):

| Operation | PM | Dev | Admin | Notes |
|-----------|:--:|:---:|:-----:|-------|
| Read all content | ✓ | ✓ | ✓ | Public |
| Comment on anything | ✓ | ✓ | ✓ | Public |
| **Create Proposal** | ✓ | ✗ | ✓ | PM/Admin only |
| **Update Task Status** | ✗ | ✓ | ✓ | Developer/Admin only |
| **Submit Task for Verification** | ✗ | ✓ | ✓ | Developer/Admin only |
| **Report Work Completion** | ✗ | ✓ | ✓ | Developer/Admin only |
| **Approve Proposal** | ✗ | ✗ | ✓ | Admin only (proxy for human) |
| **Verify Task** | ✗ | ✗ | ✓ | Admin only (proxy for human) |
| **Create Project** | ✗ | ✗ | ✓ | Admin only (proxy for human) |
| **Reject Proposal** | ✗ | ✗ | ✓ | Admin only (proxy for human) |

**In one line**: PM only "proposes", Developer only "executes", Admin can "proxy human approvals" — all can "read" and "comment".

**PM Agent exclusive tools**:
- `chorus_pm_create_proposal` - Create proposal (PRD / task breakdown / technical plan)
- `chorus_pm_create_document` - Create document
- `chorus_pm_create_tasks` - Batch create tasks
- `chorus_pm_update_document` - Update document

**Admin Agent exclusive tools** (proxy human operations):
- `chorus_admin_create_project` - Create project
- `chorus_admin_create_idea` - Create Idea (proxy human requirement submission)
- `chorus_admin_approve_proposal` - Approve Proposal
- `chorus_pm_reject_proposal` - Reject Proposal (PM: own only, Admin: any)
- `chorus_admin_verify_task` - Verify Task
- `chorus_admin_reopen_task` - Reopen Task
- `chorus_admin_close_task` - Close Task
- `chorus_admin_delete_content` - Delete any content

**Developer Agent exclusive tools**:
- `chorus_update_task` - Update task status
- `chorus_submit_for_verify` - Submit task for human verification
- `chorus_report_work` - Report work completion

**Workflow**:
```
Claude Code (PM role)              Chorus Platform
       │                              │
       │  chorus_pm_create_proposal   │
       │  ─────────────────────────▶  │
       │                              │ Store proposal
       │                              │
       │                         Web UI display
       │                              │
       │                         Human approval ✓
       │                              │
       │                         Auto-create tasks
```

### 3.4 Claude Code Integration (Primary Support)

```
Three-layer mechanism for Claude Code to connect with Chorus:

1. SKILL.md    → Agent learns how to use the platform API
2. MCP Server  → Provides tool calling capabilities
3. CLAUDE.md   → Project-level config, defines heartbeat and behavior rules
```

**Integration overview:**

| Layer | Purpose | Implementation |
|-------|---------|----------------|
| Skill | Teach Agent to use Chorus | Readable markdown, describing API |
| MCP | Provide tools | `chorus_get_task`, `chorus_report_work`, etc. |
| CLAUDE.md | Project conventions | States "check tasks before starting, report after completion" |
| Hooks | Heartbeat triggers | Auto check-in on session start/end |

**Heartbeat implementation approach:**
- Claude Code supports hooks (session start/end)
- Or via CLAUDE.md instruction: "Before each conversation, execute chorus_checkin first"

**`chorus_checkin` response content**:
```json
{
  "agent": {
    "name": "PM-Agent-1",
    "roles": ["pm"],
    "persona": "You are a UX-focused product manager...",
    "systemPrompt": "..."  // Full system prompt (if any)
  },
  "assignments": {
    "ideas": [...],   // Pending Ideas
    "tasks": [...]    // Pending Tasks
  },
  "notifications": [...] // Unread notifications
}
```

After receiving this, the Agent can immediately enter work mode without humans explaining the role and background.

---

## 4. Core Features (MVP)

### 4.1 P0 - Must Have

#### F1: Project Knowledge Base
**Description**: A structured project knowledge store, accessible to all participants (humans and Agents)

**User stories**:
- As a developer, I want a new Claude Code session to automatically know the project background
- As an AI Agent, I want to query "what are the design decisions for this module"

**Feature points**:
- [ ] Project basic info management (goals, tech stack, team)
- [ ] Architecture Decision Records (ADR)
- [ ] Glossary / concept definitions
- [ ] Auto-extract structural info from codebase

#### F2: Task Management & Tracking
**Description**: AI-native task management with automatic status updates

**User stories**:
- As a Driver Agent, I can break down requirements into a task tree
- As a Personal Agent, I can automatically update status after completing a task

**Feature points**:
- [ ] Task CRUD (create, read, update, delete)
- [ ] Task dependency graph (DAG)
- [ ] Automatic status inference (based on Git activity)
- [ ] Task assignment (to humans or Agents)

#### F3: Agent Context Injection
**Description**: When a Personal Agent starts work, it automatically receives relevant context

**User stories**:
- As a developer using Claude Code, I automatically receive when starting a task: task description, relevant code locations, design constraints, predecessor task outputs

**Feature points**:
- [ ] Task context packaging
- [ ] Claude Code / Cursor integration (via MCP or API)
- [ ] Context template customization

#### F4: Agent Work Reports
**Description**: After a Personal Agent completes work, it automatically reports to the platform

**User stories**:
- As a Personal Agent, after finishing coding, I automatically log: what was done, which files were changed, what issues were encountered

**Feature points**:
- [ ] Work report API
- [ ] Git commit association
- [ ] Automatic work summary extraction

#### F5: Idea → Proposal → Document/Task Workflow
**Description**: The platform supports the complete pipeline from raw ideas to final deliverables, implementing AI-DLC's Reversed Conversation

**Core concepts**:

| Entity | Description | Source |
|--------|-------------|--------|
| **Idea** | Human raw input (text, images, files), can be claimed for processing | Created by humans |
| **Proposal** | Proposal container, holds document drafts and task lists | Created by Agent/humans |
| **Document** | PRD, tech design docs, etc. (generated from Proposal after approval, with traceability) | Proposal output |
| **Task** | Task items with acceptance criteria (generated from Proposal after approval, with traceability) | Proposal output |

**Proposal container model**:

A Proposal is essentially a **container** — creating a Proposal just creates an empty "proposal framework", and content can be added afterwards:

```
┌─────────────────────────────────────────────────────────────┐
│  Proposal (container)                                        │
│  ├── Basic info: title, description, status                  │
│  ├── Input source: linked Ideas or Documents                 │
│  ├── Document draft list: [Document Draft 1, Draft 2, ...]   │
│  │   - Each draft contains: type, title, content (Markdown)  │
│  └── Task list: [Task 1, Task 2, Task 3, ...]                │
│      - Each task contains: title, description, storyPoints,  │
│        priority, acceptanceCriteria                           │
└─────────────────────────────────────────────────────────────┘
```

**Proposal status flow**:

```
Draft → Pending → Approved
           ↓
        Rejected → Revised → Pending
```

- **Draft**: Newly created Proposals default to draft status, content can be freely edited (add/modify/delete document drafts and tasks)
- **Pending**: After human or Agent explicitly submits for approval, enters pending status — content can no longer be edited
- **Approved**: Approval passed, Documents and Tasks are automatically created
- **Rejected**: Approval denied, can be modified and resubmitted
- **Revised**: Revised, awaiting resubmission for approval

**Submission methods**:
- Agent: Call `chorus_pm_submit_proposal` MCP tool
- Human: Click "Submit for Approval" button in UI

**Operation permissions** (both Agents and humans can operate):

| Operation | Agent (MCP) | Human (UI) | Notes |
|-----------|:-----------:|:----------:|-------|
| Create Proposal | ✓ | ✓ | Create empty container (draft status) |
| Add document draft | ✓ | ✓ | Add MD content to container (draft only) |
| Edit document draft | ✓ | ✓ | Edit existing document content (draft only) |
| Add task | ✓ | ✓ | Add task to container (draft only) |
| Edit task | ✓ | ✓ | Edit task details/acceptance criteria (draft only) |
| Delete content | ✓ | ✓ | Delete draft or task (draft only) |
| **Submit for approval** | ✓ | ✓ | draft → pending |
| **Approve Proposal** | Admin | ✓ | pending → approved (human or Admin Agent) |

**Task field details**:

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Task title |
| `description` | String | Task description |
| `storyPoints` | Float | Agent Hours estimate |
| `priority` | Enum | low / medium / high |
| `acceptanceCriteria` | String | **Acceptance criteria** (Markdown format) |

**Post-approval behavior**:

After approval, Proposal content is automatically materialized into formal entities, **preserving traceability**:

```
Proposal approved
    │
    ├──▶ Document drafts → Document (proposalUuid links to source Proposal)
    │     └── "Source Proposal" link visible on Document detail page
    │
    └──▶ Task list → Task (proposalUuid links to source Proposal)
          └── "Source Proposal" link visible on Task detail page
```

**Idea six-stage status** (assignment + processing flow):
```
Open → Assigned → In Progress → Pending Review → Completed
                                      ↓
                                    Closed
```
- **Open**: Unassigned, PM Agent can be assigned
- **Assigned**: Assigned to PM Agent, awaiting processing
- **In Progress**: PM Agent is producing a Proposal based on the Idea
- **Pending Review**: Proposal submitted, awaiting human approval
- **Completed**: Proposal approved, Idea processing complete
- **Closed**: Idea closed (rejected or cancelled)

**Assignment rules**:
- Only the current assignee can update Idea status
- Everyone can comment on Ideas
- **Humans can reassign Ideas at any time** (regardless of current status)
- All assignment/release operations are logged in Activity

**Proposal creation rules**:
- **Only the Idea's assignee** can create a Proposal based on that Idea
- When creating a Proposal, **multiple Ideas can be combined** as the Proposal's input source (`inputUuids` stores a UUID array of all selected Ideas)
- An Idea **can only be used by one Proposal** — once linked to a Proposal, it cannot be selected by another
- When creating a Proposal, the system automatically filters out Ideas already used by other Proposals, showing only available ones

**Assignment methods**:

| Actor | Method | Visibility |
|-------|--------|------------|
| **PM Agent** | Self-claim | Only that Agent can operate |
| **Human** | Assign to self | **All PM Agents** under that human can see and operate |
| **Human** | Assign to a specific PM Agent | Only that PM Agent can operate |
| **Human** | Assign to another user | That user and all their PM Agents can see |

**UI Interaction - Assign Modal**:

When a human clicks the "Assign" button, a modal appears (same UI pattern as Task):

1. **Assign to myself** - Assign to self, all my PM Agents can process it
2. **Assign to specific Agent** - Assign to a specific PM Agent
3. **Assign to another user** - Assign to another user
4. **Release** - Release current assignee (only shown when assignee exists)

- PM Agent self-claims via MCP tool `chorus_claim_idea`

**Proposal flexibility**:
- A Proposal is a **general-purpose container** that can hold multiple document drafts and multiple tasks simultaneously
- A single Proposal can produce Document + Tasks at the same time
- Input Ideas → Output Document(PRD) + Tasks = "PRD proposal + task breakdown"
- Input Document(PRD) → Output Document(Tech Design) + Tasks = "technical plan + implementation tasks"

**Full timeline (traceable)**:
```
┌─────────────────────────────────────────────────────────────┐
│  Ideas → Proposal A ──┬──▶ Document(PRD)                    │
│                       └──▶ Tasks (initial tasks)             │
│                              │                              │
│           Document(PRD) → Proposal B ──┬──▶ Document(Tech)  │
│                                        └──▶ Tasks (detailed) │
└─────────────────────────────────────────────────────────────┘
Every Document and Task records its source Proposal, enabling full traceability
```

**User stories**:
- As a human, I can add Ideas (text, images, files) to a project
- As a PM Agent, I can select one or more Ideas to combine into a PRD proposal
- As a human, I approve the PRD proposal, generating a Document upon approval
- As a PM Agent, I can create a task breakdown proposal based on a PRD Document
- As a human, I approve the task breakdown proposal, generating Tasks upon approval
- As anyone, I can trace the full chain: which Proposal this Task came from, which Document/Idea that Proposal was based on

**Feature points**:
- [ ] Idea CRUD API (text, attachments)
- [ ] Proposal API (input/output model)
- [ ] Document CRUD API (PRD, tech design, etc.)
- [ ] Traceability API
- [ ] Web UI: Ideas list, Proposal approval, Document viewing
- [ ] **Ideas list filtering**: Support "Assigned to me" filter, showing only Ideas assigned to the current user
- [ ] Auto-create Document or Tasks after approval
- [ ] **Multi-Idea Proposal creation**: Support selecting multiple Ideas as input sources when creating a Proposal (each Idea can only be used by one Proposal)

**Detailed workflow**:
```
┌─────────────────────────────────────────────────────────────┐
│  1. Humans create Ideas                                       │
│     - Text: "I want to build a user auth feature"            │
│     - Upload: competitor screenshots, design sketches         │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  2. Create Proposal (container)                               │
│     - Agent: call chorus_pm_create_proposal to create        │
│     - Human: create Proposal via UI                          │
│     - Link inputs: select one or more Ideas (multi-select)   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  3. Add content to Proposal (repeatable)                      │
│     Agent (MCP) or Human (UI) can:                           │
│     - Add doc draft: chorus_pm_add_document_draft            │
│     - Add task: chorus_pm_add_task                           │
│     - Edit: chorus_pm_update_draft / chorus_pm_update_task   │
│     - Delete: chorus_pm_remove_draft / chorus_pm_remove_task │
│                                                              │
│     Tasks must include:                                      │
│     - title: Task title                                      │
│     - description: Task description                          │
│     - storyPoints: Agent Hours estimate                      │
│     - priority: Priority level                               │
│     - acceptanceCriteria: Acceptance criteria                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  4. Human reviews Proposal                                    │
│     [✓ Approve] → Auto-generate Documents + Tasks (traced)   │
│     [✏️ Edit] → Return to edit container content              │
│     [✗ Reject] → Mark rejected                               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  5. After approval                                            │
│     - Doc drafts → Document ("Source Proposal" link visible) │
│     - Task list → Task ("Source Proposal" link visible)      │
│     - Developer Agents can claim Tasks for execution         │
└─────────────────────────────────────────────────────────────┘
```

**Key point**: The platform does not embed LLM calls — the PM's "intelligence" is provided by Claude Code.

#### F5.5: Agent Management Page
**Description**: A global view displaying all Agents within the organization, their permissions, and persona definitions

**Feature points**:
- [ ] Agent list (name, status, role tags)
- [ ] Creator information (who created this Agent)
- [ ] Permission tag display (PM Agent / Developer Agent / **Admin Agent**)
- [ ] **Admin Agent danger indicator** (red tag + warning icon)
- [ ] **Agent Persona definition** — defines the Agent's behavior style and expertise
- [ ] Last active time
- [ ] Agents can hold multiple roles simultaneously

**Admin Agent special display**:
- Role tag uses red background + warning icon
- Admin Agents are grouped separately or pinned to top in the list
- Hover tooltip shows permission description: "This Agent has human-level permissions and can approve Proposals and verify Tasks"

**Agent Persona mechanism**:

An Agent Persona is a predefined system prompt that is automatically injected when the Agent connects, enabling "Zero Context Injection".

| Field | Description | Example |
|-------|-------------|---------|
| `persona` | Custom persona description | "You are a senior developer who values code quality and prefers clean design..." |
| `systemPrompt` | Full system prompt (optional, overrides default) | Custom system prompt |

**Default persona templates** (by role):

**PM Agent default persona**:
```
You are an experienced product manager Agent. Your responsibilities are:
- Analyze user requirements and distill core problems
- Transform vague ideas into clear PRDs
- Break down tasks appropriately, estimating effort (in Agent Hours)
- Identify risks and dependencies
- Maintain team communication and drive project progress

Work style: Pragmatic, detail-oriented, communicative
```

**Developer Agent default persona**:
```
You are a professional developer Agent. Your responsibilities are:
- Understand task requirements and write high-quality code
- Follow the project's coding standards and architectural conventions
- Report progress promptly after completing tasks
- Proactively communicate when encountering issues, never make assumptions

Work style: Rigorous, efficient, quality-focused
```

**Admin Agent default persona**:
```
You are an administrative Agent acting as a human proxy. Your responsibilities are:
- Approve Proposals: Carefully review proposal content, ensure alignment with project goals
- Verify Tasks: Check task completion quality, confirm acceptance criteria are met
- Manage Projects: Create and maintain projects, ensure project information accuracy
- Make key decisions: Execute approval and verification operations within human-authorized scope

⚠️ Important reminder: You have human-level operational permissions, use them carefully:
- Always thoroughly review Proposal content before approval
- Always confirm Tasks meet acceptance criteria before verification
- When in doubt, defer to human handling rather than directly rejecting

Work style: Cautious, responsible, guided by human judgment standards
```

**Persona injection timing**:
- When an Agent calls `chorus_checkin`, its persona definition is returned
- The Agent can read it at session start, without humans having to explain the role and background repeatedly

#### F5.6: API Key Management (Settings)
**Description**: Manage Agent API Keys with role assignment and persona definition

**Feature points**:
- [ ] API Key list (name, status, associated roles)
- [ ] Create API Key modal
- [ ] Role selection (multi-select: PM Agent / Developer Agent / **Admin Agent**)
- [ ] **Admin role danger warning** (red warning box shown when Admin is selected)
- [ ] **Agent persona editing** (choose default template or customize)
- [ ] Key copy, delete, revoke

**Agent creation flow**:
1. Enter Agent name
2. Select roles (PM / Developer / Admin, multi-select)
   - **When Admin is selected**: Display red warning box
   ```
   ⚠️ Danger Warning: Admin Agent Permissions

   You are creating an Agent with human-level permissions. This Agent will be able to:
   • Approve or reject Proposals
   • Verify or close Tasks
   • Create and manage Projects
   • Delete any content

   Please ensure you understand the implications of these permissions,
   and only use this when you need to automate human approval workflows.

   [ ] I understand the risks and confirm creating an Admin Agent
   ```
3. Set persona:
   - Use default template (auto-populated based on role)
   - Custom persona description
   - Advanced: full custom system prompt
4. Generate API Key
5. Copy Key (shown only once)

**Admin Agent API Key list display**:
- Keys associated with Admin role display a red background tag
- Hover tooltip shows warning: "This Key is associated with an Agent that has Admin permissions"

### 4.2 P1 - Should Have

#### F6: PM Agent Progress Tracking
- Monitor task progress
- Identify risks and blockers
- Dynamic plan adjustment suggestions

#### F6: Team Dashboard
- Project progress visualization
- Human/Agent workload overview
- Blocker issue board

#### F7: Human Approval Workflow
- Human approval at critical checkpoints (PRD, technical design)
- Approval history records
- @mention notifications

### 4.3 P2 - Nice to Have

#### F8: Real-time Inter-Agent Communication
- Agent A completes task → Real-time notification to Agent B
- Conflict detection and automatic coordination

#### F9: Intelligent Retrospectives
- Automatically generate retrospective reports after project completion
- Identify improvement areas

#### F10: Multi-Project Management
- Portfolio view
- Cross-project resource scheduling

---

## 5. Success Metrics

> For technical details (tech stack, system architecture, MCP Server implementation, deployment configuration, etc.), refer to the [Architecture Document](./ARCHITECTURE.md).

### 5.1 North Star Metric
**Reduce Agent context preparation time by 50%**
- Current: Each new session requires 5-10 minutes explaining background
- Target: Auto-inject context, start working in <1 minute

### 5.2 Key Metrics

| Metric | Current Baseline | MVP Target |
|--------|-----------------|------------|
| Context preparation time | 5-10 minutes | <1 minute |
| Task status accuracy | 60% (manual updates lag) | >90% |
| Project information queryability | 30% (scattered across tools) | >80% |
| Agent work conflict rate | Unknown | <5% |

---

## 6. MVP Scope & Milestones

### 6.1 MVP Scope

**Tech stack**: Full-stack TypeScript + PostgreSQL + Docker Compose

**Core deliverables**:

| Module | Functionality | Priority |
|--------|--------------|----------|
| **Ideas** | Human input (text, attachments), CRUD | P0 |
| **Proposals** | Proposal workflow (input → output), approval | P0 |
| **Documents** | PRD, technical design, and other document management | P0 |
| **Tasks** | CRUD, status, Kanban | P0 |
| **Knowledge** | Unified query (Ideas, Documents, Tasks, Proposals) | P0 |
| **MCP Server** | Claude Code integration | P0 |
| **Web UI** | Ideas, Proposal approval, Documents, Kanban | P0 |
| **Activity Stream** | Project-level operation logging | P1 |

**Authentication & multi-tenancy**:
- ✅ Multi-tenancy: Database-level support (company_id field), full multi-tenant auth
- ✅ Super Admin: Configured via environment variables (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD)
  - Manage Companies (create, edit, delete)
  - Configure each Company's OIDC settings
  - Access Super Admin panel (standalone interface)
- ✅ Human auth: Each Company has independent OIDC configuration (stored in database), supporting different login methods
- ✅ Agent auth: API Key (generated at registration)
- ✅ Login flow:
  1. User enters email
  2. System determines: Super Admin email → password login → Super Admin panel
  3. Regular user → match Company by email domain → that Company's OIDC login

**Explicitly out of MVP scope (some implemented later)**:
- ✅ ~~Complex task dependencies (DAG)~~ — Implemented: TaskDependency model + cycle detection + DAG visualization
- ❌ Git integration
- ✅ ~~Complex permissions (RBAC)~~ — Implemented: Three-role MCP tool permissions (PM/Developer/Admin)
- ❌ Multi-PM Agent collaboration

### 6.2 Milestones

> ✅ **All MVP milestones are complete.** Currently in continuous iteration phase — see [AI-DLC Gap Analysis](./AIDLC_GAP_ANALYSIS.md) for upcoming features.

| Phase | Status | Deliverable |
|-------|--------|-------------|
| **M0: Project Skeleton** | ✅ Complete | Next.js project, Docker Compose, Prisma schema |
| **M1: Backend API** | ✅ Complete | Project/Task/Knowledge/Proposal CRUD API |
| **M2: MCP Server** | ✅ Complete | 50+ MCP tools (Public/Session/Developer/PM/Admin) |
| **M3: Web UI** | ✅ Complete | Dashboard, Kanban, Task DAG, Documents, Proposal approval interface |
| **M4: Skill Files** | ✅ Complete | Standalone Skill + Plugin-embedded Skill (dual distribution) |
| **M5: Integration Testing** | ✅ Complete | MCP end-to-end testing, Claude Code Agent Teams integration |
| **M6: Session Observability** | ✅ Complete | Agent Session, Task Checkin, Swarm Mode support |
| **M7: Chorus Plugin** | ✅ Complete | Claude Code plugin, automated Session lifecycle |
| **M8: Task DAG** | ✅ Complete | Task dependency modeling, cycle detection, @xyflow/react + dagre visualization |

**Focus**: Platform development — PM Agent "intelligence" is provided by Claude Code

> For technical implementation details such as data models, auth flow, and directory structure, refer to the [Architecture Document](./ARCHITECTURE.md).

---

## 7. Risks & Challenges

### 7.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| MCP protocol limitations | Medium | High | Research MCP capability boundaries, prepare fallback options |
| LLM costs too high | Medium | Medium | Caching, batching, use smaller models for simple tasks |
| Poor knowledge base quality | Medium | High | Human review mechanisms, incremental refinement |

### 7.2 Product Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Difficult to change user habits | High | High | Start with incremental value, don't require full replacement of existing tools |
| Unclear value perception | Medium | High | Design clear "Aha moments", quantify efficiency improvements |

### 7.3 Market Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Big tech fast followers | High | High | Rapid iteration, deep vertical focus, build community |
| Claude Code builds it natively | Medium | Very High | Maintain compatibility, provide differentiated value |

---

## 8. Open Questions

The following questions require further discussion:

1. **Business model**: Freemium? Per-Agent pricing? Per-project pricing?
2. **Open source strategy**: Core open source + cloud service? Or fully closed source?
3. **First users**: Serve internal projects first? Or go directly to external early adopters?
4. **Competitive positioning**: Replace Jira? Or coexist with Jira as an AI coordination layer?
5. **Agent autonomy boundaries**: Can the Driver Agent auto-assign tasks? Or only make suggestions?

---

## 9. Appendix

### A. Glossary

| Term | Definition |
|------|-----------|
| Chorus | A choir — metaphor for multi-voice (human + Agent) collaboration |
| AI-DLC | AI-Driven Development Lifecycle, an AI-native development methodology proposed by AWS |
| Bolt | Short-cycle iteration unit (hours/days) in AI-DLC, replacing traditional Sprints |
| **Agent Hours** | Effort estimation unit: 1 Agent Hour = output of 1 Agent working continuously for 1 hour, replacing traditional person-days |
| **Story Point** | In Chorus, measured in Agent Hours rather than traditional person-days |
| Reversed Conversation | Interaction pattern where AI proposes and humans verify |
| To Verify | Task status awaiting human verification after completion, embodying AI-DLC's human verification philosophy |
| Agent-First | Chorus design philosophy: Agents are first-class citizens, can perform nearly all operations, only critical decisions are reserved for humans |
| Developer Agent | AI assistant that executes development tasks (e.g., Claude Code), responsible for coding and reporting work |
| PM Agent | Project management Agent, responsible for requirements analysis, task breakdown, and proposal creation |
| **Admin Agent** | Administrative Agent acting as human proxy, can execute human-exclusive operations such as approving Proposals, verifying Tasks, and creating Projects |
| Knowledge Base | Unified information store for a project, including context, decisions, code understanding, etc. |
| MCP | Model Context Protocol, Anthropic's Agent tool protocol |
| Skill | Markdown instruction files that teach Agents how to use the platform |
| Heartbeat | Mechanism for Agents to periodically check in with the platform, maintaining continuous engagement |
| **Persona** | An Agent's role definition and behavior style, automatically injected at checkin, enabling Zero Context Injection |

### B. References

**Methodology:**
- [AWS AI-DLC Blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) - Official AI-DLC introduction
- [AWS re:Invent 2025 DVT214](https://www.youtube.com/watch?v=1HNUH6j5t4A) - AI-DLC launch presentation

**Technical references:**
- [Anthropic MCP Documentation](https://modelcontextprotocol.io/)

**Project documentation:**
- [Architecture Document](./ARCHITECTURE.md)
- [MCP Tools Reference](./MCP_TOOLS.md)
- [Chorus Plugin Design](./chorus-plugin.md)
- [AI-DLC Gap Analysis](./AIDLC_GAP_ANALYSIS.md)

---

**Document History**:
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-02-04 | AI Assistant | Initial draft |
| 0.2 | 2026-02-04 | AI Assistant | Repositioned as platform (non-centralized Agent) |
| 0.3 | 2026-02-04 | AI Assistant | Renamed to Project Chorus |
| 0.4 | 2026-02-04 | AI Assistant | Single-process architecture: MCP integrated into Next.js via HTTP |
| 0.5 | 2026-02-04 | AI Assistant | PM Agent as core feature, Agent role differentiation, separate API Key table |
| 0.6 | 2026-02-04 | AI Assistant | Defined information hierarchy: Project as core container, Knowledge/Activity at project level |
| 0.7 | 2026-02-04 | AI Assistant | Idea→Proposal→Document/Task workflow, added Idea/Document entities, Proposal input/output model |
| 0.8 | 2026-02-04 | AI Assistant | Unified data model with dual ID pattern: numeric id (PK) + uuid (external exposure) |
| 0.9 | 2026-02-04 | AI Assistant | Based on UI design: added To Verify task status, Documents navigation, Agent/Settings page details |
| 0.10 | 2026-02-04 | AI Assistant | Added Agent-First design philosophy: defined Agent vs Human permission matrix, updated architecture diagram and API routes |
| 0.11 | 2026-02-04 | AI Assistant | Redefined three killer features: Zero Context Injection, AI-DLC Workflow, Multi-Agent Awareness |
| 0.12 | 2026-02-04 | AI Assistant | Simplified Agent permission model: read/comment public, PM-exclusive Proposal creation, Developer-exclusive Task updates |
| 0.13 | 2026-02-05 | AI Assistant | Added Idea/Task claim mechanism: 6-stage status flow, claim/release tools, Agent self-service query tools |
| 0.14 | 2026-02-05 | AI Assistant | Refined claim methods: humans can assign to self (all Agents visible) or specific Agent |
| 0.15 | 2026-02-05 | AI Assistant | Added Super Admin auth: env-configured super user, Company-independent OIDC config, email-based login routing |
| 0.16 | 2026-02-05 | AI Assistant | Agent Hours: Story Points in Agent Hours; Agent Persona: defined at creation, auto-injected at checkin |
| 0.17 | 2026-02-06 | AI Assistant | Added Admin Agent role: proxy human approval/verification/project creation, red danger warning at creation, Admin-exclusive MCP tools |
| 0.18 | 2026-02-06 | AI Assistant | Proposal container model refactor: Proposal as container for document drafts and tasks; Task added acceptanceCriteria field; both Agent and human can operate via MCP/UI; approved Documents/Tasks preserve traceability |
| 0.19 | 2026-02-06 | AI Assistant | Strengthened Proposal creation rules: only Idea assignee can create Proposal; Idea can only be used by one Proposal (uniqueness constraint); Ideas list added "Assigned to me" filter |
| 0.20 | 2026-02-06 | AI Assistant | Proposal status flow optimization: added "draft" status, new Proposals default to draft; requires explicit submission for approval to enter "pending" status |
| 0.21 | 2026-02-07 | AI Assistant | Multi-Idea Proposal composition: support selecting multiple Ideas as input sources when creating a Proposal; preserved Idea uniqueness constraint (one Idea per Proposal) |
| 1.0 | 2026-02-18 | AI Assistant | Upgraded from Draft to 1.0: marked all MVP features complete, updated milestone status, fixed outdated references, added Session/Plugin/DAG milestones |
| 1.1 | 2026-02-18 | AI Assistant | Removed technical implementation content (tech design, data models, auth flow, directory structure), keeping PRD focused on product requirements; technical details consolidated in Architecture Document |
