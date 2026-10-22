# Project UI avatar audit

Task: `3120d8c4-f06f-4181-b552-78000303186c`. Scope: `src/app/(dashboard)/projects/**`, `src/components/assign-modal.tsx`, and related UI tests. Paths below are relative to `src/app/(dashboard)/projects/[uuid]/` unless otherwise stated.

## Method and shared contract

Read task acceptance criteria and design sections 3/6. Searched all scoped production files for `AvatarFallback`, `Avatar`, `avatarUrl`, `avatar`, `getInitials`, `getProjectInitials`, `charAt`, `name[0]`, `slice(0, 1)`, `substring(0, 1)`, `User`, `UserPlus`, `Users`, `assignee`, `createdBy`, actor/author names, inline SVGs, images and rounded identity containers. Reviewed contextual branches rather than replacing every icon. Test fixtures and initial-state/initial-selection variables are not identity slots.

All migrated slots use `UserIdentityAvatar as UserAvatar` from `@/components/user-identity-avatar`, forward UUID, name and optional nullable persisted seed, and are decorative because the adjacent text already labels the person. Existing Agent branches are unchanged. No per-avatar request was added. Missing seed reaches the shared safe fallback; no name/UUID-derived seed is invented.

## Migrated identity slots

| File | Existing slot | Disposition / identity source |
| --- | --- | --- |
| `src/components/assign-modal.tsx` (repo-relative) | Self row's circular `User` icon | Shared avatar, 40px; `currentUserUuid` plus the matching existing users entry, with saved-state wrapper supplying current-user data when the entry is absent. |
| `src/components/assign-modal.tsx` (repo-relative) | Each other user's circular `User` icon | Shared avatar, 40px; `user.uuid/name/avatarSeed`; local CompanyUser type extended. Agent choice avatars unchanged. |
| `ideas/assign-idea-modal.tsx` | Human option `User` in SelectItem | Shared avatar, 16px; `user.uuid/name/avatarSeed`; CompanyUser extended. Self/release labels and current-assignee summary remain text-only. Agent options unchanged. |
| `tasks/assign-task-modal.tsx` | Human option `User` in SelectItem | Shared avatar, 16px; `user.uuid/name/avatarSeed`; CompanyUser extended. Self/release labels and current-assignee summary remain text-only. Agent options unchanged. |
| `ideas/idea-detail-panel.tsx` | Human assignee `AvatarFallback` / `name.charAt(0)` | Shared avatar, 28px; `idea.assignee.uuid/name/avatarSeed`; local assignee type extended. Agent/instance branches unchanged. |
| `tasks/task-detail-panel.tsx` | Human assignee `AvatarFallback` / `name.charAt(0)` | Shared avatar, 28px; `task.assignee.uuid/name/avatarSeed`; local assignee type extended. Agent/instance and worker avatars unchanged. |
| `dashboard/panels/assignee-section.tsx` | Human assignee `AvatarFallback` / `name.charAt(0)` | Shared avatar, 28px; `assignee.uuid/name/avatarSeed`; local prop type extended. Agent/instance branches unchanged. |
| `dashboard/panels/task-list-view.tsx` | Compact human assignee `User` icon | Shared avatar, 14px; `task.assignee.uuid/name/avatarSeed`. Agent branch unchanged. |
| `dashboard/utils.ts` | FlatTask assignee identity interface | Added optional nullable `avatarSeed`; no rendered slot. |
| `tasks/kanban-board.tsx` | Inline SVG in human assignee branch (previously a robot-shaped icon) | Shared avatar, 16px; `task.assignee.uuid/name/avatarSeed`; local Task assignee type extended. Agent branch unchanged. |
| `proposals/proposal-kanban.tsx` | Creator `User` icon | Shared avatar, 16px; `proposal.createdBy.uuid/name/avatarSeed`; local creator type extended. Agent creator unchanged. |
| `proposals/[proposalUuid]/page.tsx` | Named human creator's `Monitor` icon beside title metadata | Shared avatar, 16px; `proposal.createdBy.uuid/name/avatarSeed`. Agent creator unchanged. Separate creator-type category is not this slot. |
| `activity/page.tsx` | Human actor `User` icon in activity feed | Shared avatar, 32px; current actor UUID/name/seed from the existing single user batch. User and Agent batches filter UUIDs by raw actorType and explicitly scope both queries to the authorized company. Lookup uses actorType, never cross-type UUID fallback. Repeated historical actors share current user resolution, not event-payload seeds. Unresolved/system actors retain system text with a generic Settings icon; Agent Monitor branch unchanged. |

## Retained visual hits: specific reasons

| File | Retained hit and reason |
| --- | --- |
| `src/app/(dashboard)/projects/page.tsx` (repo-relative) | Both project card/list `getProjectInitials(project.name)` badges are project identities, not humans. No user initial avatars here. |
| `ideas/idea-detail-panel.tsx` | Footer `User` button means assign/reassign; semantic action icon, not the assigned person. Activity text remains text; timeline dots represent events. |
| `tasks/task-detail-panel.tsx` | Footer `User` means assign; semantic action icon. Worker AgentAvatar and Agent/instance identity remain unchanged. Activity actor text and state icons remain unchanged. |
| `proposals/[proposalUuid]/page.tsx` | Creator-type `User` + localized “User”, paired with Bot + “Agent”, categorizes the creator type rather than showing a person's identity. Keep these category icons. Reviewer text remains text-only. |
| `dashboard/panels/basic-view.tsx` | `UserPlus` is the assign button action; no identity avatar added. |
| `tasks/[taskUuid]/task-actions.tsx` | `UserPlus` is the assign action; unchanged. |
| `dashboard/project-access-tab.tsx` | Existing member rows, selected member, and add-member search results are name/email text, not avatars. `UserPlus` means add member. CompanyUser types, “User not found” error, and selectUser labels are data/action text, not visual identities. |
| `dashboard/project-cwd-summary.tsx` | Both AgentAvatar locations (badge and hover card), avatar comments, and Agent color identity dots are Agent-only. |
| `tasks/task-view-toggle.tsx` | Mobile/list human assignee is already text-only. Only Agent assignees have AgentAvatar; retain both branches without adding human avatars. |
| `tasks/kanban-board.tsx` | Force-move blocker human names are already text-only; blocker AgentAvatar and session Monitor stay unchanged. Other inline SVGs are column/resource/comment/checklist symbols. Typing GIF is active-work animation, not a user image. |
| `graph/mindmap-canvas.tsx` | Agent avatar references occur in Agent-presence paint comments; canvas uses Agent-colored dots. Text `slice` truncates labels, not human initials. No human avatar migration. |
| `graph/resource-graph.tsx` | Agent live-presence graphics and node/entity icons remain unchanged. Author/assignee identifiers route selection or child views; no local human identity slot. |
| `tasks/[taskUuid]/task-status-progress.tsx` | Inline SVG represents task progress/check state, not identity. |
| `documents/[documentUuid]/document-content.tsx` | Inline SVG represents document metadata; no identity avatar. |
| `activity/page.tsx` | Monitor empty state and Agent actor Monitor are not human identities. Settings is the generic unresolved/system actor fallback, not a user avatar. |

## Plain-text identities and data-only hits

| File | Disposition |
| --- | --- |
| `dashboard/panels/idea-detail-panel.tsx` | Assignee object passes intact to AssigneeSection; FlatTask mapping passes `task.assignee` intact, preserving seed. Assign-modal current-assignee projection is only a text summary. Presence components remain out of scope. |
| `dashboard/panels/activity-timeline.tsx` | Actor names are interpolated into activity text next to event timeline dots; no avatar added. |
| `dashboard/idea-tracker-stats.tsx` | Recent-activity actor names are text next to activity/resource symbols; no avatar added. |
| `dashboard/panels/overview-timeline.tsx` | Creator and actor summaries are plain text; status circles, task/content slices and timeline milestones are not human avatars. |
| `dashboard/idea-tracker.tsx` | Actor names are data for stats; current-user UUID is passed to panels. No local avatar. |
| `dashboard/dashboard-content.tsx` | Current-user identity props route to tracker; no local avatar. |
| `dashboard/new-idea-dialog.tsx` | Creator/current-user references are submission data, not avatar UI. |
| `dashboard/panels/idea-actions-menu.tsx` | Assignee names/types gate and describe actions; no identity slot. |
| `dashboard/panels/move-idea-dialog.tsx` | Actor/creator metadata supports moving; no identity slot. |
| `dashboard/panels/elaboration-view.tsx` | Assignee/activity references control elaboration and messages; state icons are not avatars. |
| `proposals/new/create-proposal-form.tsx` | CreatedBy/assignee data and form state are not avatar slots. |
| `proposals/new/page.tsx` | Creator UUID is submission context; no avatar slot. |
| `proposals/[proposalUuid]/proposal-actions.tsx` | Creator identity supports ownership/action checks; no avatar slot. |
| `proposals/[proposalUuid]/source-ideas-card.tsx` | Assignee/creator and current-user identity are data passed to nested panels. |
| `proposals/[proposalUuid]/discussion-drawer.tsx` | Current-user UUID is passed to shared comments; comments migration belongs to parent worker. |
| `documents/[documentUuid]/page.tsx` | `createdByName` is document/export metadata, no local avatar. |
| `tasks/tasks-page-content.tsx` | Passes listTasks results intact to TaskViewToggle; no user-field projection drops seeds. |
| `tasks/actions.ts`, `tasks/[taskUuid]/actions.ts` | Assignee/current-user data is authorization/mutation and DTO pass-through. getDeveloperAgentsAction returns getCompanyUsers results intact. No UI identity slot. |
| `ideas/actions.ts`, `ideas/[ideaUuid]/actions.ts` | Creator/current-user data is authorization/mutation; getPmAgentsAction returns getCompanyUsers results intact. No UI identity slot. |

Other server actions, route wrappers, local data interfaces and tests with assignee/createdBy/currentUser/initial-state references do not render identities. No remaining production human `AvatarFallback`, `charAt(0)`, `name[0]`, `getInitials`, `avatarUrl`, or single-character slice/substring identity slots were found. All remaining rendered User icons are the category/action exceptions above. Layout, settings, AuthContext, services/lib/API, unified comments, mention and shared presence components were not edited by this slice. Project-group UI outside projects is outside this audit.

## DTO handoff

Reported required fields on the active task before finishing migration: nested task/idea assignee.avatarSeed (including tracker/overview data), proposal.createdBy.avatarSeed (list/detail), and CompanyUser.avatarSeed from getCompanyUsers used by both assignment actions and generic AssignModal callers. Backend worker owns those shared service changes; confirmed their current fields match these consumers with no shape mismatch. Local activity query selects current seed without additional queries; both identity queries are company-scoped after requireProjectPageAccess. listActivities returns raw actorType and actorUuid, which discriminate identity lookup even when user and Agent tables contain the same UUID. Existing pass-through objects retain the additional seed.

## Verification

- Existing project regression suite: 49 files, 477 tests passed.
- Added project-user-avatars rendering regressions for saved-state propagation to two mounted self slots, independent other-user seed, task-list nested identity, Agent/instance preservation, and missing-seed forwarding.
- Added activity-page regressions for one tenant-scoped current-user batch, repeated historical actors, generic deleted-user fallback, unchanged Agent icon, same-UUID user/Agent/system collisions, tenant-scoped Agent batch, and missing-actor cross-type fallback rejection.
- Added audited-slot source contract regressions for all nine other project avatar consumers and retained semantic/text-only exceptions.
- All three added test files pass: 19 tests after the collision regression additions. Combined with the existing suite, 496 tests passed across the runs. The saved-state UI test uses the real wrapper with a controlled auth snapshot and a renderer test double; it verifies consumer propagation, not AuthProvider's save implementation.
- Targeted production ESLint: zero errors; 15 existing warnings (unused imports/variables, existing effect dependencies and typing GIF img guidance). Test paths are excluded by repository ESLint configuration.
- Collision follow-up activity-page ESLint: no warnings/errors; Settings import now supplies the system fallback rather than remaining unused.
- Scoped `git diff --check` passes. Full `tsc --noEmit --pretty false` reports no project/assign-modal errors, but reports TS2769 tuple inference errors in concurrent backend test edits at `src/services/__tests__/activity.service.test.ts:22:119` and `src/services/__tests__/comment.service.test.ts:50:119`; reported to parent/backend worker without editing those files.
- Browser acceptance remains the separate end-to-end verification task.
