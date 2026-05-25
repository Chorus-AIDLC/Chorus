# Changelog

## [0.9.0] - Unreleased

### Changed (Breaking)
- **Session lifecycle simplified to `{active, closed}`**: dropped the `inactive` status and the unused `expiresAt` field on `AgentSession`. "Stale" is now a query-time predicate on `lastActiveAt` (cutoff: 1h). Default UI listings (Settings page per-agent sessions, project worker-avatar header) only show active+fresh sessions; MCP-facing reads (`chorus_list_sessions`, `chorus_get_session`) and Activity-stream lookups remain unfiltered so plugin reuse and audit-trail navigation continue to see everything. Every session-touching MCP tool now refreshes `lastActiveAt` as a side effect of success — plugins no longer need standalone heartbeats during normal operation. The standalone `chorus_session_heartbeat` is retained for explicit keep-alives. The `expiresAt` parameter on `chorus_create_session` is removed.

---

## [0.8.2] - 2026-05-21

### Added
- **Cascade-migrate Idea on cross-project move**: `chorus_move_idea` now walks the full AI-DLC pipeline tail in one Prisma transaction — moves the Idea plus all linked Proposals (any status), all materialized Documents and Tasks, and all related Activities — instead of leaving approved-proposal artifacts stranded in the source project. Adds a Move button + dialog with a dry-run preview to the Idea detail panel, and a new `GET /api/ideas/[uuid]/move/preview` endpoint. (#268)
- **Mermaid diagrams in Markdown content**: `mermaid` code blocks now render as diagrams in Documents, Proposals, Ideas, Tasks, and Comments via `@streamdown/mermaid`. Collapses the 14 direct `<Streamdown>` call sites onto a single `MarkdownContent` component. (#266)
- **Delete Document from the dashboard**: New destructive Delete button in the Document detail action bar, backed by a Server Action that reuses `documentService.deleteDocument`. Agents continue to use `chorus_admin_delete_document` via MCP. Also drops the redundant Back button (the breadcrumb already covers it). (#264)

### Fixed
- **Long elaboration option labels truncated**: The shadcn Button ancestor forced `whitespace-nowrap`, so long option labels and unbreakable URLs clipped. Apply `whitespace-normal` + `overflow-wrap:anywhere` and pin the indicator to the top of multi-line content. Also adds an inline ✓ confirm button (and Enter binding) to the Other free-text input, suppressed on the last question to avoid accidental round submission. (#265)

---

## [0.8.1] - 2026-05-18

### Fixed
- **Agent picker dropped non-developer agents**: Task/Idea assign modals filtered agents by the legacy `roles[]` array, so admin-preset and custom-permission agents disappeared from the picker. Replaced with an effective-permission lookup — `getAssignableAgents` now filters by `task:write` / `idea:write` computed from preset + custom bits, and `chorus_pm_assign_task` gates the assignee on the same effective permission. (#259)

---

## [0.8.0] - 2026-05-17

### Added
- **OpenSpec-aware mode (Claude Code only for now)**: Auto-activates when both an `openspec/` directory and the `openspec` CLI are present. Adds a dedicated `openspec-aware` skill in the Claude Code plugin, `/opsx/{explore,propose,apply,archive}` slash commands, four `openspec-*` skills under `.claude/skills/`, an `archive-trigger` spec, and `docs/OPENSPEC_MODE.md`. Includes a `PostToolUse` archive-trigger hook (`on-post-verify-task.sh`) that fires after task verification. (#245)

### Changed
- **`my_assignments` aligned with checkin.ideaTracker**: Extracted a shared `idea-tracker.service.ts` so `chorus_get_my_assignments` and `chorus_checkin` return the same project-grouped idea-tracker shape (derived status + proposal/task counts), replacing the divergent legacy assignments aggregation. (#244)
- **Docs sweep**: Aligned README, ARCHITECTURE, MCP_TOOLS, and PRD with the 0.7.0 permission model and the stateless MCP endpoint. (#254)

### Fixed
- **PGlite cross-handler race**: Pin pg.Pool to `max=1` in PGlite mode so concurrent Next.js route handlers can't race the same connection through PGlite's single-writer engine. (#252)
- **Windows tarball runnable**: Reworked `chorus.mjs` and added `scripts/prepack-pglite.mjs` so the published npm tarball runs cleanly on Windows. (#251)

### Plugin
- **Claude Code plugin → 0.8.3**: OpenSpec-aware mode and reviewer `maxTurns` doubled. (#245, #249)
- **Codex plugin → 0.8.3**: Cross-port maintenance only (no OpenSpec mode yet).

---

## [0.7.1] - 2026-05-04

### Added
- **OpenCode client install guide**: New OpenCode tab in the in-app Install Guide with a 3-step one-shot flow covering env setup, `install-opencode.sh` installer (idempotent JSON merge into `~/.config/opencode/opencode.json`, Bash 3.2 compatible, backup on write), and verify. Adds `docs/CONNECT_OPENCODE` (en + zh) and mirrors the new frame in `docs/design.pen`. (#242)

### Changed
- **Docs aligned with fine-grained agent permissions**: Sweep of README / CLAUDE.md / ARCHITECTURE / AUTH / CONNECT_* to replace references to the legacy `admin/pm/developer` role model with the 5×3 permission matrix shipped in 0.7.0. New `docs/PERMISSIONS.md` as the dedicated permission-model reference. (#241)

---

## [0.7.0] - 2026-05-02

### Added
- **Fine-grained agent permissions**: Replaces the 3-role agent model (admin/pm/developer) with a permission matrix of 5 resources × 3 actions = 15 bits, exposed in the UI as role presets plus a Custom option that freely combines bits. Introduces authz types/presets/permissions library with effective-set computation, wires REST + MCP servers to gate on `Permission[]`, and migrates the Agent/ApiKey schema with a new `permissions` column. Settings create/edit and onboarding share an `AgentPermissionPicker` grid. (#232)

### Changed
- **Checkin response shape**: Returns a resource-aggregated permission object for token-efficient consumption by skills and plugin hooks. (#232)
- **Legacy role aliases rejected at API boundary**: `POST /api/agents` no longer accepts the legacy `pm`/`developer`/`admin` role strings; they now return 422. (#232)
- **Proposal reject/revoke authorization**: `pm_reject_proposal` / `pm_revoke_proposal` gate on `hasPermission(..., "proposal:admin")` instead of ad-hoc role-string checks. Authors can always act on their own proposals. (#232)

### Fixed
- **Settings edit preset derivation**: An agent with `roles=[pm_agent]` plus extra `task:admin` was previously read as preset mode and silently zeroed on save. Now correctly accounts for custom permissions layered on top of a preset. (#232)
- **Claim routes gated on the wrong identity**: `/api/ideas|tasks/[uuid]/claim` now look up the selected agent by UUID and gate on `idea:write` / `task:write`, instead of the legacy pm/developer role strings (which matched zero 0.7.0 agents). (#232)

### Plugin
- **Claude Code plugin → 0.8.0**: Prereq checks switched to permission-based gating. `chorus/SKILL.md` adds a Permissions section and Tool-Access-by-Preset table; `proposal`, `quick-dev`, `yolo`, and `develop` skills updated to reference resource permissions instead of role labels. (#232)
- **Codex plugin → 0.8.0**: Ported all 0.7.0 permission-model updates to `plugins/chorus/` — bumped plugin + every skill (including the two reviewer skills) + the hardcoded `clientInfo` version in `chorus-mcp-call.sh`. Cleaned up stale role-label language in `yolo`/`develop`. Fixed `chorus_create_session` being called with a non-existent `roles` arg. (#233)
- **plugin-maintenance skill → 0.2.0**: Future plugin changes must bump both packages + the `clientInfo` string, and preserve intentional differences (stateless hooks, `$`-prefixed skills, TOML config) when porting content between the two plugins. (#233)

---

## [0.6.7] - 2026-04-28

### Added
- **Codex CLI plugin**: Ported Chorus plugin to Codex CLI under `plugins/chorus/` alongside the existing Claude Code plugin. Includes marketplace manifest, 7 workflow skills (chorus/idea/proposal/develop/review/quick-dev/yolo), 2 reviewer skills, hooks wiring (SessionStart + PostToolUse), one-shot installer `install-codex.sh` with idempotent `~/.codex/config.toml` setup, and 17-assertion regression test. (#222)
- **Workspace picker for multi-company email**: When a user's email resolves to 2+ Companies (via emailDomains ∪ User.email), `/login/pick-workspace` lets them choose which workspace to sign in to. New `GET /api/auth/company-oidc` endpoint, email-gated to block UUID enumeration. (#227)
- **Codex onboarding tab + per-client connect guides**: In-app Install Guide adds a Codex tab between Claude Code and OpenClaw with a 3-step one-shot installer flow. New `docs/CONNECT_CLAUDE_CODE`, `CONNECT_CODEX`, `CONNECT_OTHER_AGENTS` (en + zh) walk through each connection path end-to-end. README points at the setup wizard + per-client guide table. (#224)

### Changed
- **Email domain uniqueness**: Dropped SuperAdmin-side email-domain-uniqueness validation — the same domain can now be attached to multiple Companies (required for the workspace picker). (#227)
- **Logout**: No longer calls `manager.signoutRedirect` — clearing the local session is sufficient, IdP SSO session stays intact for silent re-login. (#227)

---

## [0.6.6] - 2026-04-23

### Added
- **npm one-click install**: `@chorus-aidlc/chorus` now works reliably via `npx` / `npm install` on all platforms (macOS ARM64, Linux, Windows) — replaced `bcrypt` (native C++ bindings) with pure-JS `bcryptjs`, eliminating the last cross-platform blocker. (#192)
- **Document export (MD/PDF/Word)**: Export documents in three formats — Markdown with YAML frontmatter, PDF via remark-pdf with bundled CJK/symbol/emoji fonts, and Word via remark-docx with syntax-highlighted code blocks. Mermaid diagrams rendered as PNG. Available on document detail, document list, and proposal editor pages. (#199)
- **Proposal revoke**: Admin operation to undo proposal approval — resets status to draft, cascade-closes materialized tasks, deletes materialized documents. Frontend dialog with impact preview. (#197)
- **Unified PM reject/revoke tools**: Moved `chorus_admin_reject_proposal` and `chorus_admin_revoke_proposal` into PM tools (`chorus_pm_reject_proposal`, `chorus_pm_revoke_proposal`). PM agents can only reject/revoke own proposals; admin agents bypass ownership guard. (#202)
- **Checkin API refactor**: New `checkin.service.ts` replaces bloated assignments response with project-grouped idea tracker (derived status, proposal/task counts) and 5-item notification summary. Agent-centric 3+1 query batch eliminates per-project N+1. (#203)
- **Onboarding flow improvements**: Back navigation for Copy Key / Install Guide / Test Connection steps, removed 5-minute timeout (SSE listens indefinitely), copyable checkin prompt in waiting state. Agent checkin now emits SSE-only (no DB notification row). (#205)
- **Post-completion reviewer reminder**: Inject review+verify reminder into SubagentStart workflow so subagents include it in their final response. Reviewer agents (proposal-reviewer, task-reviewer) are skipped. (#206)

### Changed
- **Unified 24h datetime display**: Replace all `toLocaleDateString()` with shared `formatDateTime` utility (YYYY-MM-DD HH:mm) across all pages and exports. Server Components use client-side `FormattedDateTime` for local timezone. (#200)

### Fixed
- **Duplicate notifications in multi-container**: EventBus Redis relay now tags re-emitted events with `_remote: true` so notification-listener skips DB writes on non-originating instances. (#204)
- **Proposal revoke skips closed tasks**: Filter already-closed tasks during revoke to avoid stale resource accumulation. (#198)

### Plugin
- **Review skill**: Added shared Review Strategy section and task-reviewer verification step (B2.5). (#201)
- **on-subagent-start.sh**: Post-completion block injected into workflow; on-subagent-stop.sh trimmed to side-effects only. (#206)
- **on-session-start.sh**: Slimmed ~60 lines of redundant static docs, replaced with compact Quick Reference. (#203)

---

## [0.6.4] - 2026-04-18

### Fixed
- **PGlite stale connection auto-retry**: Add Prisma `$extends` middleware to auto-retry queries (up to 3 attempts) when PGlite silently drops idle connections during heavy transactions. Matches both P1017 and "Connection terminated" errors. (#190)
- **PGlite idle connection eviction**: Add `pool.on("error")` handler to silently evict broken connections instead of crashing the process.

### Changed
- **README**: Add PGlite concurrency note (en/zh) recommending external PostgreSQL or Docker Compose for multi-agent use.

---

## [0.6.3] - 2026-04-18

### Added
- **CLI entry and npm publishing**: Added `chorus.mjs` CLI entry point with embedded PGlite support, `--port`, `--data-dir`, `--pglite-port` flags, auto-migration, and graceful shutdown. Enables `npx @chorus-aidlc/chorus` one-command startup. (#185)

### Fixed
- **Proposal approval transaction timeout**: Batch all materialization into 5 SQL calls max (was ~29) using `createManyAndReturn`. Propagates transaction client into child functions. Fixes PGlite and docker-local timeout on proposals with many tasks/docs. (#187)
- **Dashboard PGlite connection exhaustion**: Serialize dashboard data queries to avoid exceeding PGlite's max-connections limit, which caused "Server has closed the connection" errors.
- **Plugin MCP tool compatibility**: Fixed plugin MCP tool to work with stateless MCP servers. (#183)

### Changed
- **README**: Simplified README — removed redundant sections, added What's New. (#181)

---

## [0.6.2] - 2026-04-17

### ⚠️ Breaking Changes
- **Default port changed from 3000 to 8637**: To avoid conflicts with commonly used port 3000 (e.g., React, Next.js dev servers), Chorus now uses a unique default port. All documentation, Docker configs, CDK, and plugin scripts updated. Existing deployments must update port mappings and environment variables.

### Added
- **Embedded PGlite mode**: Zero-dependency deployment option using embedded PostgreSQL (PGlite), eliminating the need for an external database server. (#162)
- **Structured logging with Pino**: Replaced console.log with structured JSON logging via Pino for better observability. (#168)
- **MCP tool call logging**: All MCP tool calls are now logged, including business-level rejections. (#169)

### Changed
- **Stateless MCP route**: MCP endpoint no longer maintains in-memory session state — each request creates a fresh transport+server, enabling horizontal scaling without sticky sessions. (#176)

### Fixed
- **Progress bar completion count**: Closed tasks are now included in project progress bar calculations. (#120, #171)
- **OIDC login unique constraint**: Resolved `oidcSub` unique constraint violation during default login flow. (#164)
- **Task reassignment**: Allow reassigning tasks that are already assigned to another user/agent. (#12)

---

## [0.6.1] - 2026-04-13

### New
- **`/yolo` skill**: Full-auto AI-DLC pipeline skill (Idea → Proposal → Execute → Verify) with Agent Team parallel execution and sequential fallback. Plugin bumped to v0.7.0.

### Changed
- **Unified page width**: Dashboard pages now share a consistent 1200px max-width (kanban excluded for full-width layout).

### Plugin
- **`/proposal` skill**: Updated Step 6 to require reject-before-edit for pending proposals.

---

## [0.6.0] - 2026-04-09

### Added
- **Astro Landing Site**: New marketing site with i18n (en/zh), blog support, scroll animations, mobile hamburger menu, video player, sitemap, and Cloudflare Pages deployment. (#124, #134)
- **IdeaTracker Dashboard**: Replaced project overview with IdeaTracker — idea detail panel with lifecycle views, tab switching, timeline, deep links, execution view, side-by-side layout, and task DAG visualization. (#96, #97, #139, #140)
- **Independent Review Agents**: AI-DLC quality assurance with proposal-reviewer and task-reviewer agents, user config toggles, three-tier verdict system, finding classification, and convergence round limits. (#81, #84, #142)
- **Agent Presence Indicator**: Real-time resource highlighting via SSE showing which agents are actively working on tasks/ideas. (#101, #102)
- **Granular SSE Updates**: Entity-scoped refetch instead of full-page refresh, with toast notification popups on SSE events. (#98, #99)
- **Cross-Column Kanban Animation**: Framer Motion layoutId for smooth card transitions across Kanban columns. (#100)
- **Proposal Detail Redesign**: Discussion drawer with realtime updates, replaced action buttons with dropdown menu. (#104, #105, #122)
- **Unified Comment Component**: Agent delegation support and collapsible threads. (#117)
- **Elaboration Panel Carousel**: Slide navigation UI for elaboration rounds. (#76)
- **Projects Page Onboarding**: SSE realtime for projects page, group delete fix. (#143)
- **OpenClaw Plugin v0.4.0**: Native skills for OpenClaw plugin. (#66)

### Changed
- **Idea Lifecycle Simplified**: Idea state machine now ends at elaboration — removed auto-complete on proposal approval. (#116)
- **Server Actions Migration**: Replaced all client-side fetch with Next.js server actions for data mutations.
- **MCP Session Idle Timeout Removed**: Always-on clients no longer get disconnected. (#70)

### Fixed
- **SSE Realtime Broken for Non-First-Page Projects**: Fixed SSE event routing when project is not on the first page. (#121)
- **Proposal Filter Lost on SSE Refetch**: Preserve proposal filter when SSE refetches kanban tasks. (#103)
- **Kanban Realtime Regression**: Prevent progress regression when opening sidebar. (#108)
- **Presence Indicator Border**: Use outline overlay instead of border to avoid layout shift. (#130)
- **Elaboration UI**: Treat `needs_followup` rounds as answered, open ideas default to elaboration tab. (#118, #141)
- **Inline Code Styling**: Style inline code as orange bold instead of unstyled. (#111)
- **Discussion Drawer**: Restore presence indicator and comment count in drawer. (#110)
- **Detail Panel Badges**: Fix badge status display and done idea content. (#106)
- **Landing Site Fixes**: Language switch via URL param, mobile overflow, Cloudflare Wrangler compatibility, site URL update. (#130, #134)

### Plugin
- Plugin v0.6.2 — enable task reviewer by default, update agent definitions. (#109)

### Docs
- Added AIG implementation plan and presence design documents. (#112)
- Added benchmark research and ProjDevBench setup guide. (#75)
- Added harness engineering blog post. (#68)
- Added cross-module contract and task granularity guidance to proposal skills. (#78, #79)
- Added idea derived status state machine documentation.

---

## [0.5.1] - 2026-03-29

### Added
- **New User Onboarding Wizard**: Full-screen step-by-step wizard at `/onboarding` guides new users through agent creation, API key copy, client install, and connectivity test via real-time SSE detection. (#63)
- **UI Animation System**: Comprehensive framer-motion animations — page transitions, list stagger, sidebar nav indicator, collapsible expand/collapse, notification badge pulse, and form submit feedback. (#57)
- **Quick-Dev Skill**: New skip-proposal workflow skill for both plugin and standalone agents. (#61)

### Changed
- **Projects Page Redesign**: Replaced card grid with compact list view, extracted shared project color utility. (#62)
- **Task Tools Migrated to Public Layer**: `chorus_create_tasks` and `chorus_update_task` moved from role-specific to public MCP tools, enabling all roles to create/edit tasks directly. (#61)
- **Skill Documentation Split**: Monolithic skill docs split into 5 modular skills by AI-DLC stage (chorus, idea, proposal, develop, review) for both plugin and standalone. (#59, #60)

### Fixed
- **OIDC Cookie Expiry Mismatch**: Derive `oidc_access_token` cookie maxAge from JWT `exp` claim instead of hardcoded 1h. (#56)
- **DAG/Kanban Render Issues**: Fix ReactFlow height propagation, remove framer-motion wrapper breaking node measurement, guard duplicate Cmd+K search dialog. (#58)

### Plugin
- Plugin version bumped to 0.5.2 with enhanced quick-dev skill (admin self-verify, AC guidance). (#64)

---

## [0.5.0] - 2026-03-20

### Added
- **Universal Search**: Global search across tasks, ideas, proposals, documents, projects, and project groups with unified MCP tool and UI. (#50)
- **Rich Claim/Assign Response**: `chorus_claim_task` and `chorus_pm_assign_task` now return full task details and dependency hints, eliminating extra round-trips for agents. (#52)

### Changed
- **DEFAULT_USER Session Extended to 365 Days**: Default user sessions no longer expire frequently, reducing unnecessary logouts. (#53)

### Fixed
- **Settings Page Role Badges**: Replaced checkbox role display with Badge components on the settings page. (#54)

### Docs
- Added search technical design document and architecture reference. (#51)

---

## [0.4.2] - 2026-03-20

### Added
- **Multi-project Filtering**: Filter by multiple projects via MCP headers. (#37)
- **Team Lead Verify Reminders**: Auto-remind team leads to verify completed tasks via plugin hooks. (#44)

### Changed
- **MCP Session Sliding Window Expiration**: Sessions now use sliding window expiration instead of fixed timeout. (#39)
- **TypeScript Strict CI**: Added `tsc --noEmit` to CI pipeline and resolved 27 type errors in test files. (#41)
- **Fork PR Coverage Comments**: Enabled coverage PR comments for fork PRs via `workflow_run`. (#42)

### Fixed
- **MCP Draft/Approve UUID Returns**: Draft and approve tools now return created UUIDs, eliminating extra round-trips. (#48)
- **SubagentStop Hook Context Injection**: Removed async from SubagentStop hook to fix context injection. (#47)
- **Verify Reminder Hook Placement**: Moved verify reminder from TaskCompleted to SubagentStop hook for reliability. (#45)

### Docs
- Updated Chorus vs Plane comparison to v2.0 and added Linear AI-DLC plugin report. (#40)

---

## [0.4.1] - 2026-03-15

### Added
- **Proposal-based Task Filtering**: Filter tasks by source proposal across UI, API, MCP tools, and plugins. (#34)
- **Idea Reuse Across Proposals**: An Idea can now be linked to multiple Proposals, enabling iterative refinement. (#29)
- **Delete Proposal Button**: Added frontend button to delete proposals directly from the UI. (#27)
- **Simplified Proposal MCP**: Empty shell proposal creation + relaxed E1 validation for faster PM workflows. (#25)
- **PR Workflow Skill**: New `pr-workflow` skill for branch/PR/CI/merge workflow automation. (#33)
- **Unit Test Coverage**: Added Vitest test suite — Phase 1 (417 tests), Phase 2 (736 tests, 71.5%), Phase 3 (984 tests, 95.3%). (#21, #22, #23)
- **Coverage Badge**: README now displays dynamic test coverage badge via shields.io. (#24)

### Changed
- **OpenClaw Plugin Config**: All config params are now optional with missing-config warnings instead of hard errors. (#31)

### Fixed
- **Legacy Acceptance Criteria**: Removed legacy markdown acceptance criteria from task draft editing. (#32)

---

## [0.4.0] - 2026-03-12

### Added
- **Structured Acceptance Criteria**: Dual-track verification system — developer self-check + admin verification per criterion. New `AcceptanceCriterion` Prisma model as independent table, with `chorus_report_criteria_self_check` and `chorus_mark_acceptance_criteria` MCP tools. Kanban cards show acceptance progress badges, task detail panel displays criterion cards with pass/fail actions. Full i18n support. (#18)
- **Task Dependency Enforcement**: Tasks cannot move to `in_progress` when their dependencies are unresolved. Kanban UI shows lock icon + blocked banner with force-move confirmation dialog for admins. New `checkDependenciesResolved()` service method with enriched blocker info. `chorus_admin_reopen_task` gains `force` parameter for admin bypass. (#16)
- **`COOKIE_SECURE` Environment Variable**: Support `COOKIE_SECURE=false` for HTTP-only deployments. Extracted `getCookieOptions()` helper to eliminate 8 duplicate cookie config blocks. Updated Docker Compose and documentation. (#19)

### Changed
- **Session Management Simplified**: Removed manual session lifecycle management from skill docs. Plugin sessions are fully automated by hooks; standalone skill removes session tools entirely.
- **Unblocked Tasks Rule**: `getUnblockedTasks` now requires dependencies to be `done` or `closed` (previously accepted `to_verify`).

### Fixed
- **Code Block Horizontal Scroll**: Fixed horizontal scroll for code blocks in task draft detail panel by overriding ScrollArea's `display:table` to `display:block`.

### Plugin
- Chorus Plugin bumped to v0.2.1 (session docs clarification, dependency enforcement, acceptance criteria).
- OpenClaw Plugin bumped to v0.2.1: new `admin-tools.ts` module with `chorus_admin_create_project_group` and `chorus_mark_acceptance_criteria`; added `chorus_get_project_groups` / `chorus_get_project_group` to common tools; event router handles `task_verified` / `task_reopened`. (#20)

---

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
