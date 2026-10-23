# Design

## Context

The latest human answer explicitly overrides the parent theme's company-template assumption. YOLO self-elaboration chooses creator-only visibility and own-agent candidates as the least-privilege interpretation; this is recorded as an agent decision, not a human answer. Empty roles and retaining downgraded members were explicitly accepted by the human.

Effective permissions are the union of presets and custom bits in `src/lib/authz/permissions.ts`; admin/write do not implicitly grant read. `src/mcp/tools/permission-map.ts` gates Idea assignment/resolution on idea:admin and Task assignment on proposal:write. Comments have no dedicated bit but still require project Editor access. Team membership cannot grant project access.

## Goals / Non-Goals

Goals: private CRUD, fixed roles, actionable eligibility, robust ownership checks, persisted multi-role bindings and understandable Settings UI.

Non-goals: project application, auto-assignment, routing/load balancing, wakes, changes to existing agent authority, custom roles, shared/public templates, agent-key template APIs.

## Decisions

### Data and ownership

Add AgentTeam with uuid, companyUuid, ownerUuid, name (trimmed 1–100 characters), description (trimmed, at most 1000 characters, default empty), createdAt and updatedAt. Add AgentTeamMember with uuid, teamUuid, agentUuid and fixed role string, unique on (teamUuid, role, agentUuid). Index ownership and relation fields. Use existing Prisma relation-mode conventions and an additive SQL migration; generated client artifacts follow repository policy. Team deletion removes memberships transactionally; agent deletion cascades its memberships through Prisma, allowing empty roles. No changes to unrelated assignments/deletion policy.

Every service operation scopes by companyUuid AND ownerUuid derived from authenticated user context, never request fields. Every selected agent must match both. No Workspace Admin override. Cross-owner/tenant team IDs return 404; foreign/missing agent IDs get a generic invalid-member error, without disclosing foreign metadata. Duplicate names are allowed; duplicate identical memberships are rejected. A single agent in several roles is valid. Unknown fields, invalid roles/UUIDs, malformed JSON and overlong payload fields get validation errors. Limit a write to 200 role-agent bindings.

### Fixed permission requirements

All four roles require the five read bits (idea/proposal/document/task/project). Additional required bits:

| Role ID | Additional bits | Responsibility |
| --- | --- | --- |
| product | idea:write, proposal:write, document:write | Elaborate and author proposals/documents; lead handles admin resolution |
| development | task:write | Execute and submit tasks |
| review | None | Independent verdict comments; actual project Editor access still required |
| lead | idea:write, idea:admin, proposal:write, proposal:admin, task:write, task:admin, document:write | Assign/resolve Ideas, delegate Tasks, gate proposals/tasks, write completion reports |

Use one shared pure role-definition/eligibility module and effective permission computation; do not alter presets. Display responsibilities and exact missing bits. Eligibility is necessary, not a promise that later project actions are authorized or an agent is online.

### CRUD and drift semantics

GET `/api/agent-teams` returns the current user's templates with latest member eligibility. POST creates. GET `/api/agent-teams/[uuid]` reads. PATCH updates supplied name/description and optionally replaces memberships atomically. DELETE deletes. GET `/api/agent-teams/candidates` returns only own agents (uuid/name plus effectivePermissions), and role definitions can be imported by the UI. Existing response envelopes use success/data and error/code/message/details.

Writes use `{name, description, members: [{role, agentUuid}]}`; name is required on POST, members default to []. PATCH requires at least one recognized field. DTOs expose team fields plus members `{role, agentUuid, agentName, eligible, missingPermissions}`. New tuples must be eligible at write-time; an unchanged existing tuple can remain after downgrade, even in a full-list PATCH, so editing names or removing other members never forces deleting invalid bindings. Removing then re-adding an invalid tuple is rejected. Transactions cover membership validation and replacement; reads recompute eligibility, never persist stale eligibility. Concurrent permission changes after a valid bind are treated as drift, not privilege grants. Concurrent replacements serialize per team (or equivalent safe transaction handling) to avoid merged membership sets. Agent deletion removes its bindings; template deletion never deletes agents.

Return 401 unauthenticated, 403 for agent-key callers, 404 for unavailable team IDs, 422 for invalid fields/members and role failures (details include each own agent's role, agentUuid, missingPermissions), and generic 500 for unexpected server failures. No secret/API-key material in candidates or template DTOs. List/candidate reads must include all owned entries (no silent first-page truncation); pagination is optional, but UI must consume all pages if implemented.

### UI

Add discoverable Teams link from Settings. `/settings/teams` shows private-template explanation, list, create/edit dialog, delete confirmation, four role groups with description/required bits and own-agent multi-selection. Invalid unselected candidates are disabled with missing-bit reasons; existing invalid members stay visible/removable. Refresh candidates and templates on reload and before editing to surface drift. Preserve form input on validation/network failure; refresh after successful mutations; disable duplicate submissions. Clearly distinguish loading, empty teams, no agents and request failures. Use existing components, accessible labels and keyboard-operable controls. English/Chinese translations and semantic theme tokens support both themes; update design.pen with both frames.

### UI correction — 2026-10-23

Felix rejected the initial checkbox-wall UI before PR submission. Follow-up task `6a8fa493-b4e9-4125-a18f-e802d70f3303` replaces it with a two-column role-card editor (one column on mobile), selected-agent avatar chips and explicit remove buttons, and compact list-page role summaries. Extract the existing assignment Avatar + Radix Select into `src/components/agent-select.tsx`; Teams, task assignment and Idea assignment all import this component. Keep Radix keyboard navigation/name typeahead, z-index above the existing dialog, disabled eligibility explanations, and optional empty roles. Permission requirements use native collapsed details; drift warnings stay visible beside affected members. No backend, candidate ownership, or assignment-instance semantics change. The dialog keeps the existing ScrollableDialog pinned footer and scrollable body. Design frames are top-level siblings, not nested in another screen's navigation. Pencil tooling is unavailable in this session; validate JSON/IDs and inspect actual browser screenshots without claiming a Pencil render.

## Risks / Trade-offs

- Private template ownership does not settle how a future project consumes a template: deferred to Idea ② and explicitly not implemented now.
- Read-time eligibility avoids mutating agent edit paths and allows repairs without data loss; future consumers MUST recheck rather than trust old DTOs.
- Read bits plus role-specific actions are stricter than the initial shorthand, but reflect actual tools. No special comment permission exists.
- Agent deletion relies on Prisma cascades in relationMode=prisma; include a regression test and exercise real database migration/cascade where practical.

## Validation and Rollout

Backend tests cover ownership/tenant/agent-key denial, role matrix, malformed inputs, atomic rejection, multi-role membership, empty templates, drift retention/removal/re-add rejection and deletion. UI tests cover CRUD, role selections, missing permissions, errors, labels and invalid-member removal. Run focused Vitest, typecheck and lint, then full suite where feasible. Real-browser acceptance uses local development data: create own fixture agents/templates, verify invalid eligibility and both themes, reload to check persistence, clean up fixtures. Apply additive migration to local development database, never reset data. Verify spec/document byte equality and archive only after task and aggregate reviews pass.
