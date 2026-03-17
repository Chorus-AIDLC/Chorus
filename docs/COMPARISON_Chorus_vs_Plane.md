# Chorus vs Plane: Comparative Analysis & Agent-First Strategy

> **Document Version**: 2.0
> **Date**: 2026-03-15
> **Purpose**: Deep comparison of Plane's mature PM feature set against Chorus's Agent-First architecture. Identify what to learn, what to skip, and how to build a lightweight yet powerful AI-human collaboration platform.

---

## 1. Executive Summary

**Plane** is a mature, open-source (AGPL-3.0) project management platform built for human teams. With 86 Django models, 6 apps (web, admin, api, live, space, proxy), 15 shared packages, and a Turbo monorepo architecture, it is a full-featured Jira/Linear alternative.

**Chorus** is an Agent-First collaboration platform implementing AI-DLC methodology. With 21 Prisma models, 79 MCP tools, and a single Next.js monolith, it is purpose-built for AI Agents as first-class project participants.

**Key Insight**: Plane and Chorus are solving fundamentally different problems. Plane optimizes for *humans managing work*. Chorus optimizes for *agents doing work, humans verifying*. The comparison is not "Chorus needs to catch up to Plane" but rather "what can Chorus selectively learn from Plane to serve its Agent-First mission better."

**What Changed Since v1.0 (2026-02-19)**:
- Chorus grew from 14 to 21 models: added Notification, NotificationPreference, Mention, ElaborationRound, ElaborationQuestion, AcceptanceCriterion, ProjectGroup
- MCP tools grew from 59 to 79
- Elaboration system (AI asks clarifying questions) fully implemented
- Structured acceptance criteria on tasks
- Task dependency validation on status transitions
- Proposal-based task filtering
- Project Groups for organizing projects
- Plugin hooks for Claude Code agent team lifecycle

---

## 2. Architecture Comparison

| Dimension | Chorus | Plane |
|-----------|--------|-------|
| **Philosophy** | Agent-First: AI proposes, human verifies | Human-First: humans plan, optionally use AI assist |
| **Backend** | Next.js 15 (API Routes) | Django 4.2 (REST Framework) |
| **Frontend** | React 19 + Next.js App Router | React 19 + React Router v7 |
| **Database** | PostgreSQL 16 + Prisma 7 (21 models) | PostgreSQL 15 + Django ORM (86 models) |
| **State Management** | React Context | MobX (dedicated `shared-state` package) |
| **Real-time** | SSE (in-memory EventBus + `GET /api/events`) | WebSocket (Hocuspocus live server) |
| **Background Jobs** | None | Celery + RabbitMQ |
| **Cache** | None | Redis |
| **File Storage** | None | S3 / MinIO (FileAsset model) |
| **Search** | Basic SQL queries | Full-text + MongoDB analytics |
| **Monorepo** | Single Next.js app + 1 plugin package | Turbo monorepo (6 apps, 15 packages) |
| **API Style** | REST + MCP (79 tools, HTTP Streamable) | REST only |
| **AI Integration** | MCP native, agents are first-class citizens | Bolted-on LLM text generation (GPT/Claude/Gemini) |
| **Auth** | OIDC + API Keys (`cho_` prefix) + SuperAdmin | OIDC + Email/Password + Magic Links + API Keys |
| **i18n** | next-intl (en, zh) | IntlMessageFormat (en, zh) |
| **UI Library** | shadcn/ui (Radix) | Propel (custom design system, Storybook) |
| **Deployment** | Docker Compose + AWS CDK | Docker Compose + K8s + Swarm + AIO |
| **Soft Delete** | Hard delete | `deleted_at` + SoftDeletionManager on all models |

### Architecture Complexity: 4x Difference

Plane's 86 models vs Chorus's 21 models is a **4:1 ratio**. This is deliberate, not a gap. Plane needs models for:
- Human collaboration primitives: reactions, subscribers, favorites, stickies, recent visits, user properties per context, onboarding state
- Multi-tenant complexity: workspace-level + project-level scoping, member roles at both levels, member invites
- Content richness: description_json + description_html + description_stripped + description_binary (4 formats per issue!)
- Integration surface: GitHub sync, Slack sync, importers, exporters, webhooks with retry logs

Chorus intentionally avoids this complexity. Agents don't need emoji reactions, sticky notes, or onboarding wizards. The challenge is knowing *which* Plane features genuinely help agents work better.

---

## 3. Plane's AI: Surface-Level Integration

This is the most important finding. Plane's entire AI capability is **two REST endpoints**:

```python
# apps/api/plane/app/views/external/base.py
class GPTIntegrationEndpoint(BaseAPIView):
    def post(self, request, slug, project_id):
        # Just sends text to OpenAI/Anthropic/Gemini and returns response
        text, error = get_llm_response(task, prompt, api_key, model, provider)
        return Response({"response": text})
```

- `POST /api/workspaces/{slug}/ai-assistant/` — Generic LLM prompt-response
- `POST /api/workspaces/{slug}/rephrase-grammar/` — Text editing tasks

That's it. No agent identity, no structured workflows, no MCP, no session observability, no context injection. Plane treats AI as a text transformation utility, not as a team member.

**Chorus's 79 MCP tools** represent a fundamentally different paradigm:
- Agents have identity (roles, personas, API keys)
- Agents have workflow (claim tasks, report work, submit for verify)
- Agents have observability (sessions, heartbeats, task checkin/checkout)
- Agents have collaboration (comments, notifications, @mentions)
- Agents have structure (elaboration questions, acceptance criteria, proposals)

This is Chorus's moat. No amount of feature additions to Plane will close this gap because it requires rearchitecting from the data model up.

---

## 4. Feature Gap Analysis (Updated)

### 4.1 Gaps Closed Since v1.0

| Feature | Status | How |
|---------|--------|-----|
| Notification System | **Implemented** | `Notification` + `NotificationPreference` + `Mention` models, MCP tools `chorus_get_notifications`, auto-mark-read |
| Elaboration System | **Implemented** | `ElaborationRound` + `ElaborationQuestion` models, PM tools for start/validate/skip elaboration |
| Project Groups | **Implemented** | `ProjectGroup` model, admin tools for group CRUD, dashboard |
| Structured Acceptance Criteria | **Implemented** | `AcceptanceCriterion` model, self-check workflow |
| Task Dependency Validation | **Implemented** | Status transitions blocked when upstream dependencies incomplete |

### 4.2 Remaining Gaps Worth Closing (Agent-Relevant)

These are features that directly improve agent productivity or AI-human collaboration quality:

| # | Feature | Why It Matters for Agents | Effort | Priority |
|---|---------|--------------------------|--------|----------|
| 1 | **Labels/Tags** | Agents need to categorize and filter work. Essential for routing tasks to specialized agents. | Low | P0 |
| 2 | **Search** | Agents querying "find all tasks related to auth" is a core workflow. PostgreSQL FTS is sufficient. | Medium | P0 |
| 3 | **Sub-tasks (parent_id)** | Agents naturally decompose work. A PM agent creates a parent task, developer agents create sub-tasks. | Low | P0 |
| 4 | **File Attachments** | Agents need to share artifacts — build logs, screenshots, generated code. | Medium | P1 |
| 5 | **Webhooks** | External systems (CI/CD, GitHub) need to push events into Chorus. | Medium | P1 |
| 6 | **Issue Relations** | "relates_to" and "duplicates" help agents understand context. Plane has 6 relation types. | Low | P1 |
| 7 | **Background Jobs (BullMQ)** | Notification delivery, session cleanup, analytics. Required for scale. | High | P1 |
| 8 | **Soft Deletes** | Safety net. Agents sometimes make mistakes. `deletedAt` allows recovery. | Medium | P2 |

### 4.3 Gaps to Deliberately NOT Close

These Plane features are human-centric and would add complexity without serving the Agent-First mission:

| Feature | Plane's Implementation | Why Chorus Should Skip It |
|---------|----------------------|--------------------------|
| **Cycles/Sprints** | Time-boxed iterations with burn-down charts | Agents don't work in 2-week sprints. AI-DLC uses continuous flow. |
| **Modules** | Feature grouping with lead/members/progress | Project Groups + Proposals already provide sufficient structure. |
| **Custom Workflow States** | Per-project configurable state groups with colors | Agents need simple, predictable states (open/assigned/in_progress/completed). Custom states add cognitive load for AI. |
| **Rich Text Editor** | Prosemirror with mentions, embeds, media | Agents communicate in Markdown. Rich text adds overhead without value for MCP. |
| **Reactions/Emoji** | Emoji reactions on issues and comments | Zero value for agent workflows. |
| **Stickies** | Sticky notes on workspace home | Human-only UX feature. |
| **Favorites/Bookmarks** | User favorites for quick access | Agents don't browse — they query via MCP tools. |
| **Onboarding Flow** | Step-by-step human onboarding | Agent onboarding is via API key + persona config. |
| **Gantt Charts** | Timeline visualization with drag-and-drop | Agents don't look at Gantt charts. DAG view is more useful. |
| **Estimation Points** | Fibonacci/linear estimation scales | Estimation is a human ritual. Agents don't estimate — they do. |
| **Calendar View** | Calendar layout for date-based planning | Agents work on priority/dependency order, not calendar dates. |
| **User Properties per Context** | Per-user display preferences at each scope | Agents don't have display preferences. |

### 4.4 Chorus Advantages Plane Cannot Replicate

| # | Feature | Chorus | Plane Equivalent |
|---|---------|--------|-----------------|
| 1 | **79 MCP Tools** | Role-based tool registration, structured schemas | 2 text generation endpoints |
| 2 | **AI-DLC Pipeline** | Idea -> Elaboration -> Proposal -> Tasks materialization | Issues created directly, no review gate |
| 3 | **Elaboration System** | AI generates clarifying questions, human answers, AI refines | Nothing |
| 4 | **Agent Sessions** | Swarm mode, heartbeats, task checkin/checkout, real-time worker badges | Nothing |
| 5 | **Zero Context Injection** | Agents auto-receive persona + project context on checkin | Nothing |
| 6 | **Acceptance Criteria Workflow** | Structured criteria with self-check + human verification | Nothing (unstructured description only) |
| 7 | **Proposal Materialization** | Draft documents + tasks reviewed as a package, then materialized | Nothing |
| 8 | **Plugin Lifecycle Hooks** | SubagentStart/Stop auto-manage sessions and context | Nothing |
| 9 | **Reversed Conversation** | AI proposes, human approves/rejects | Human instructs, AI assists |
| 10 | **Multi-Agent Coordination** | PM agent creates proposals, developer agents claim tasks | Single-user AI assist |

---

## 5. Agent-First Strategy: Learning from Plane the Right Way

### 5.1 Principle: Lightweight Multiplier, Not Feature Parity

Plane has 86 models because it serves humans who need visual customization, personal preferences, and social features. Chorus should stay at **~30 models** by asking one question for every potential feature: **"Does this help an agent do better work?"**

The target is not "Plane minus AI features" but "the minimal PM surface that maximizes agent productivity."

### 5.2 What to Adopt from Plane (Adapted for Agents)

#### A. Labels — Agent Routing Tags

Plane uses labels for human categorization. Chorus should use labels as **agent routing metadata**.

```
Example: A PM agent creates tasks with labels like:
  - "frontend", "backend", "infra" → routes to specialized agents
  - "needs-human-review" → flags for human attention
  - "blocked-external" → signals dependency on non-agent work
```

Implementation: `Label` model + `TaskLabel` junction. Expose via MCP: `chorus_add_label`, `chorus_list_tasks` with label filter. **Skip**: label colors, hierarchical labels (agent routing doesn't need visual hierarchy).

#### B. Search — Agent Memory

Plane uses search for human navigation. Chorus should use search as **agent contextual memory**.

```
Example: A developer agent working on "auth" can search:
  chorus_search("authentication bug") → finds related tasks, past proposals, documents
```

Implementation: PostgreSQL full-text search (tsvector) on Task, Idea, Document, Comment. MCP tool: `chorus_search`. **Skip**: MongoDB analytics, faceted search (overkill for current scale).

#### C. Sub-tasks — Agent Work Decomposition

Plane uses parent/child for human work breakdown. Chorus should use it for **agent-driven decomposition**.

```
Example: PM agent creates parent task "Implement user auth"
  Developer agents create sub-tasks:
  - "Set up JWT middleware"
  - "Create login endpoint"
  - "Add token refresh logic"
  Parent auto-tracks completion % from children.
```

Implementation: Add `parentUuid` to Task model. MCP tools: `chorus_create_subtask`, `chorus_list_subtasks`. **Skip**: unlimited nesting depth (agents work best with 1 level of decomposition).

#### D. Soft Deletes — Agent Safety Net

Plane uses soft deletes for data recovery. Chorus should use it as **agent mistake protection**.

```
Example: An agent accidentally closes the wrong task.
  With soft delete: admin can recover in seconds.
  Without: data is gone.
```

Implementation: Add `deletedAt` to Task, Idea, Document, Proposal. MCP tool: `chorus_admin_restore_task`. **Skip**: per-user trash view, scheduled permanent deletion (keep it simple).

#### E. External Source Tracking — Integration Bridge

Plane tracks `external_source` + `external_id` on all entities. Chorus should adopt this for **bidirectional sync with developer tools**.

```
Example: A task created from a GitHub issue:
  externalSource: "github"
  externalId: "makeplane/plane#1234"
  → Agents can reference the original issue
  → Status sync becomes possible
```

Implementation: Add `externalSource` + `externalId` to Task, Idea. **Skip**: full import/export system (premature for current stage).

#### F. Webhooks — Outbound Event Bridge

Plane fires webhooks on entity changes. Chorus should adopt this for **CI/CD integration and external agent triggers**.

```
Example: Task status → "completed" fires webhook to:
  - GitHub: close linked issue
  - CI/CD: trigger deployment
  - Slack: notify human stakeholders
```

Implementation: `Webhook` model + `WebhookLog`. Leverage existing EventBus — add webhook delivery as a listener. **Skip**: per-event-type subscription granularity in v1 (fire all events, let consumers filter).

### 5.3 Unique Agent-First Features to Build (No Plane Equivalent)

These features have no parallel in Plane because they serve agent-specific needs:

#### A. Agent Skill Registry

```
Problem: How does a PM agent know which developer agent to assign a "React frontend" task to?
Solution: Agents declare skills (tags) on registration. Task assignment considers skill matching.

Model: AgentSkill { agentUuid, skill, proficiency }
MCP: chorus_list_agents_by_skill("react", "typescript")
```

#### B. Context Window Budget Tracking

```
Problem: Agents have finite context windows. Long tasks drain context and quality degrades.
Solution: Track context consumption per session. Warn agents when approaching limits.

Model: Session.contextTokensUsed (updated via heartbeat)
MCP: chorus_session_heartbeat({ contextTokensUsed: 45000 })
UI: Show context usage % on worker badges
```

#### C. Agent Handoff Protocol

```
Problem: When an agent's session ends mid-task (context exhaustion, error), work is lost.
Solution: Structured handoff — agent writes a "handoff note" before stopping. Next agent picks up.

Model: Task.handoffNote (JSON: { completedSteps, nextSteps, blockers, artifacts })
MCP: chorus_handoff_task({ taskUuid, note: { ... } })
```

#### D. Automated Quality Gates

```
Problem: Human verification is a bottleneck. Agents submit work, humans take hours to verify.
Solution: Automated pre-verification checks before human review.

Flow: Agent marks task complete → System runs acceptance criteria self-check →
      If all pass: auto-verify (or flag for quick human approval)
      If any fail: bounce back to agent with specific failures
```

#### E. Agent Performance Analytics

```
Problem: Which agents are most effective? Which task types take longest?
Solution: Track agent-level metrics derived from session and activity data.

Metrics:
  - Tasks completed per session
  - Average time from claim to completion
  - Acceptance criteria pass rate on first submission
  - Human revision rate (how often work is bounced back)
```

#### F. Proposal Templates

```
Problem: PM agents create similar proposals repeatedly for common patterns.
Solution: Reusable proposal templates with pre-defined task structures.

Model: ProposalTemplate { name, documentDrafts (JSON), taskDrafts (JSON) }
MCP: chorus_create_proposal_from_template(templateUuid, overrides)
```

### 5.4 The "30 Model" Target Architecture

Current (21 models) + recommended additions to reach the sweet spot:

```
Existing (21):
  Company, User, Agent, ApiKey
  ProjectGroup, Project
  Idea, ElaborationRound, ElaborationQuestion
  Proposal, Document, Task, TaskDependency, AcceptanceCriterion
  Comment, Activity, Notification, NotificationPreference, Mention
  AgentSession, SessionTaskCheckin

Add (9):
  Label, TaskLabel, IdeaLabel                    — Agent routing tags
  Webhook, WebhookLog                            — Outbound events
  AgentSkill                                     — Skill registry
  ProposalTemplate                               — Reusable blueprints
  TaskRelation                                   — relates_to, duplicates
  SearchIndex                                    — FTS materialized view

Total: 30 models
```

Compare: Plane's 86 models. Chorus achieves **comparable agent utility at 1/3 the complexity**.

---

## 6. Infrastructure Evolution

```
Current:   PostgreSQL + Next.js (monolith) + In-memory EventBus + SSE
    |
    v  Phase 1 (agent productivity)
    +  Labels, Sub-tasks, Search (FTS), Soft Deletes
    +  External source tracking on Task/Idea
    |
    v  Phase 2 (integration)
    +  Redis (cache + EventBus pub/sub for multi-instance)
    +  S3/MinIO (agent artifacts)
    +  Webhooks (outbound events via EventBus listener)
    |
    v  Phase 3 (scale)
    +  BullMQ Worker (notification delivery, webhook retry, session cleanup)
    +  Agent Skill Registry + intelligent task routing
    +  Performance analytics dashboard
```

Docker Compose target:
```yaml
services:
  app:        # Next.js (API + Web + MCP)
  worker:     # BullMQ job processor
  db:         # PostgreSQL
  redis:      # Cache + Queue + EventBus pub/sub
  minio:      # File storage (optional, for agent artifacts)
```

---

## 7. Competitive Positioning

### 7.1 Plane's Trajectory

Plane is moving toward being a "better Jira" — more features, more customization, more integrations. Their AI additions will likely follow the "AI copilot for PM" pattern: auto-triage, smart suggestions, AI-generated summaries. This is AI-as-assistant, not AI-as-participant.

### 7.2 Chorus's Trajectory

Chorus should move toward being the **"operating system for AI agent teams"** — not a PM tool that supports agents, but an agent collaboration platform that humans can observe and guide.

The positioning matrix:

```
                    Human-Operated              Agent-Operated
                    ────────────────────────────────────────────
Feature-Rich    │   Jira, Plane, Linear    │   (nobody yet)   │
                │                          │                   │
Lightweight     │   Trello, Notion         │   Chorus          │
                    ────────────────────────────────────────────
```

Chorus's strategic target is the **Agent-Operated + Lightweight** quadrant. Stay lightweight. Stay agent-first. Don't drift toward the Feature-Rich Human-Operated quadrant where Plane lives.

### 7.3 Risks of Over-Learning from Plane

1. **Feature bloat**: Every Plane feature adds UI complexity that slows human verification
2. **Human-centric bias**: Optimizing for human browsing experience at the cost of MCP efficiency
3. **Architecture creep**: Moving toward microservices before the scale demands it
4. **Lost identity**: Becoming "Plane + agents" instead of "agent platform + human oversight"

### 7.4 The Litmus Test

Before adding any feature, ask:

1. **Does an agent need this?** If only humans benefit, deprioritize.
2. **Does this need a new model?** Prefer extending existing models over adding new ones.
3. **Can this be an MCP tool?** If yes, the feature serves agents. If it's UI-only, question it.
4. **Does this simplify the agent's workflow?** Features should reduce agent decisions, not add them.

---

## 8. Conclusion

Plane is an excellent reference for PM feature design — its 86-model architecture represents years of iteration on what humans need from project management tools. But Chorus is not building a PM tool. Chorus is building an **agent collaboration platform** that happens to have PM-like features for human observability.

The updated strategy:

1. **Protect the moat**: 79 MCP tools, AI-DLC pipeline, elaboration system, agent sessions, proposal materialization — these are unreplicable advantages
2. **Selectively adopt**: Labels, search, sub-tasks, soft deletes, webhooks — the ~9 models that genuinely help agents work better
3. **Invent new**: Agent skills, handoff protocols, context budgets, quality gates — features that only make sense in an agent-first world
4. **Stay lightweight**: Target 30 models (vs Plane's 86). Every model must justify its existence through agent utility
5. **Resist drift**: Don't become "Plane for agents." Be "the OS for AI agent teams that humans can trust"

The goal is not to catch up to Plane. The goal is to define a category that Plane cannot enter without rebuilding from scratch.
