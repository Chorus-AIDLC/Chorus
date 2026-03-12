# Changelog

## [0.3.0] - 2026-03-06

### Added
- **Move Idea Across Projects**: New `chorus_move_idea` MCP tool and UI support to move ideas between projects.
- **RESTful Panel URLs**: Ideas and Tasks side panels now have shareable RESTful URLs for direct linking.
- **Code Syntax Highlighting**: Comments now render code blocks with syntax highlighting.
- **Mobile Responsive Layout**: All dashboard pages are now mobile-friendly with responsive design.
- **Sessionless Pixel Workers**: Agents without active sessions now appear as pixel workers on PixelCanvas.
- **OpenClaw `assign_task` Tool**: Added `assign_task` tool and `reviewNote` approval support to the OpenClaw plugin.

### Changed
- **Chorus Repositioned as Agent Harness**: Updated documentation to reposition Chorus as an Agent Harness platform.

### Fixed
- **Code Block Scroll/Buttons**: Fixed code block overflow scrolling and button display in proposal document view.
- **Detail Panel Flash**: Prevented detail panel flash on comment submit.
- **Wide Content Overflow**: Fixed wide content overflow in comments.
- **Agent Edit Name Persistence**: Agent edit now persists name correctly and keeps API key valid.
- **OpenClaw Plugin entityUuid**: Include `entityUuid` in OpenClaw plugin notification messages.
- **MCP String-encoded Array Params**: Coerce string-encoded array params in MCP tools.

### Plugin
- Bumped plugin versions for `chorus_move_idea` support.

---

## [0.2.0] - 2026-03-01

### Added

- **OpenClaw Integration**: New `@chorus-aidlc/chorus-openclaw-plugin` — an OpenClaw-compatible plugin with SSE + MCP bridge, enabling Chorus to work with any OpenClaw-supported IDE or agent. Includes 12 exploration tools and admin create tools.
- **Edit Agent Modal**: Edit agent name, persona, and system prompt directly from the settings page.
- **Agent Owner Awareness**: Agents are linked to their human owner, enabling owner-scoped `@mention` workflow and new `search_mentionables` MCP tool.
- **@Mention Defaults to Own Agents**: `@mention` dropdown defaults to the current user's own agents for faster tagging.
- **Real-time Comment Updates**: SSE-powered live comment sync for Idea, Task & Proposal detail panels.

### Changed

- **`create_idea` Permission Level**: Moved from Admin-only to PM permission level, allowing PM agents to create ideas directly.

### Fixed

- **Notification Scoping**: Elaboration and task_verify notifications are now scoped to relevant parties instead of broadcasting to all admin agents.
- **Duplicate Event Emission**: Removed duplicate `eventBus.emit` in elaboration service.
- **Missing Activity Events**: Added activity events for idea assign and proposal actions triggered from the UI.
- **Event Router ProjectUuid**: Include `projectUuid` in all event-router trigger messages for proper SSE routing.

---

## [0.1.1] - 2026-02-27

### Added

- **Proposal Validation Checklist**: Pre-submission validation with 12 checks (5 errors, 5 warnings, 2 info) across document completeness, task quality, and DAG structure. New `chorus_pm_validate_proposal` MCP tool for PM agents. Collapsible frontend checklist with error/warning count badges and full i18n support (ICU plurals).
- **`chorus_list_projects` MCP tool**: List all projects regardless of project group — available to all authenticated agents.
- **`ungroupedCount` in project groups**: `chorus_get_project_groups` now returns the count of ungrouped projects.
- **Plugin Bash 3.2 compatibility**: Fixed `${VAR,,}` Bash 4+ syntax in hook scripts for macOS `/bin/bash` 3.2 compatibility. Added `test-syntax.sh` script to verify plugin hook compatibility.

### Fixed

- **Project group completion rate always showing 0%**: `getGroupStats` was hardcoding `completedTasks: 0` instead of summing from each project. Group dashboard also now counts both "done" and "closed" tasks.
- **Tasks page performance storm**: Batch DB queries reduce ~82 queries to ~4 for task listing. Added `batchGetActorNames()`, `batchFormatCreatedBy()`, `formatTaskResponsesBatch()`, and `batchGetWorkerCountsForTasks()`. SSE throttled to 3s + 1s debounce to limit `router.refresh()` during active agent work.

### Plugin

- Bumped Chorus Plugin from v0.1.7 to v0.1.9.

---

## [0.1.0] - 2026-02-26

First public release of Chorus — an AI Agent & Human collaboration platform implementing the [AI-DLC (AI-Driven Development Lifecycle)](docs/PRD_Chorus.md) methodology.

**Core philosophy: "Reversed Conversation" — AI proposes, humans verify.**

### Zero Context Injection

Agents automatically know "who I am" and "what to do" — no manual onboarding.

- Agent persona with predefined role, expertise, and work style
- `chorus_checkin` returns pending assignments, project context, and notifications
- Chorus Plugin for Claude Code auto-injects session context on sub-agent spawn
- Downloadable Skill documentation for agent self-onboarding

### AI-DLC Workflow

Complete closed-loop pipeline from idea to delivery:

```
Idea → Elaboration → Proposal → [Document + Task DAG] → Execute → Verify → Done
```

- **Ideas**: Capture requirements, assign to PM agents or humans
- **Requirements Elaboration**: Structured multi-round Q&A with stakeholders before proposal creation
- **Proposals**: PM Agent drafts PRD + task breakdown → human reviews → approve/reject/close
- **Documents**: PRD, tech design, ADR, spec, guide — versioned Markdown with proposal linkage
- **Task DAG**: Directed acyclic graph with dependency management, cycle detection, and topological ordering
- **Task Lifecycle**: open → assigned → in_progress → to_verify → done with optimistic locking on claim/release
- **Agent Hours**: New effort metric replacing traditional story points — 1 AH = 1 Agent working for 1 hour

### Multi-Agent Awareness

All agent work is visible in real-time — no more isolated sessions.

- **Agent Sessions**: Track sub-agent swarm activity with checkin/checkout, heartbeat, and auto-expiry
- **Activity Stream**: Audit log of all actions with session attribution for full traceability
- **SSE Real-time Updates**: Live Kanban, Ideas, and Proposals sync across all connected clients
- **Pixel Art Workers**: Animated typing indicators on Kanban cards showing which agents are actively working
- **@Mentions**: Tag users and agents in comments with notification delivery
- **Work Reports**: Progress updates stored as comments for team-wide visibility

### Web UI

- Project dashboard with grouped projects, completion rates, and aggregated stats
- Kanban board with drag-and-drop task management
- Interactive DAG visualization ([@xyflow/react](https://reactflow.dev/) + dagre)
- Proposal detail with document/task draft review workflow
- Rich Markdown rendering in Ideas, Tasks, and Proposals
- Full i18n support (English and Chinese)

### MCP Server

40+ tools across three agent roles via HTTP Streamable Transport:

| Role | Tools | Responsibility |
|------|-------|---------------|
| PM Agent | `chorus_pm_*` | Analyze ideas, create proposals, manage documents, assign tasks |
| Developer Agent | `chorus_*_task`, `chorus_report_work` | Claim tasks, report progress, submit for verification |
| Admin Agent | `chorus_admin_*` | Create projects/ideas, approve proposals, verify tasks |

Compatible with Claude Code, Cursor, Kiro, and any MCP client.

### Auth

- OIDC authentication for human users
- API Key authentication (`cho_` prefix, SHA-256 hashed) for agents
- Default username/password auth mode for quick setup
- Multi-tenant company isolation

### Deployment

- Docker image with standalone Next.js build (multi-arch: amd64/arm64)
- Docker Compose full-stack setup (app + PostgreSQL + Redis)
- AWS CDK infrastructure-as-code package
- `.env.example` for all required configuration
