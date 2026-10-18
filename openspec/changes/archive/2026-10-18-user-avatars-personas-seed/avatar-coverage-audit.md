# User avatar coverage audit

## Search method

Search `src` (excluding tests and generated code) for `AvatarFallback`, `charAt(0)`, `getInitials`, `name[0]`, `name.slice`, `User`, `UserIcon`, `UserCircle`, `CircleUser`, `avatarUrl`, `assignee` and `createdBy`. Classify specific human identities separately from semantic icons, Agent identities and plain text. Project-specific findings are recorded in `project-avatar-audit.md` beside this file.

## Shared shell and comments

| File / surface | Classification and disposition |
| --- | --- |
| `src/app/(dashboard)/layout.tsx` sidebar profile, desktop and mobile | Existing human initials replaced with `UserIdentityAvatar`; current AuthContext seed overrides the layout's independent session snapshot. |
| `src/components/unified-comments.tsx` current author input | Existing generic human avatar replaced with current authenticated identity; no extra seed fetch. |
| `src/components/unified-comments.tsx` human comment author | Existing initials replaced with current resolved author seed; `AgentAvatar` branch unchanged. |
| `src/components/mention-editor.tsx` raw DOM suggestion rows | Existing human glyph replaced with shared local Personas data-URI helper; image-load/generation failure retains the existing safe icon. Agent motion and liveness unchanged. |
| `src/components/mention-renderer.tsx` rendered user mention | Plain text styled mention, no human avatar slot; intentionally unchanged. No seed is persisted in mention markup. |
| `src/components/user-identity-avatar.tsx` | Shared saved-state wrapper, no network request; pure `ui/user-avatar.tsx` remains usable for isolated draft previews. |
| `src/components/user-avatar-settings.tsx` | Settings-only pure preview, independent UUID draft, explicit self-save/cancel, shared saved-state publication and visible linked attribution. |

## Intentionally unchanged surfaces

| File / surface | Reason |
| --- | --- |
| `src/components/ui/presence-indicator.tsx`, `src/hooks/use-presence.ts` | Presence entries contain agentUuid/agentName and display Agent avatars only. |
| `src/components/agent-presence/{identity-block,presence-roster,mention-badge,connections-view,instance-group,conversational-entry}.tsx` | Agent identity slots, not human avatar slots. |
| `src/components/active-session-indicator.tsx`, `src/components/AgentFormFields.tsx`, `src/components/AgentCreateForm.tsx` | Agent-only identity/preview controls. |
| `src/app/(dashboard)/settings/users/page.tsx` | Account-management text rows; no existing human avatar slot. Do not add avatars. |
| `src/app/(dashboard)/project-groups/[uuid]/page.tsx` | Initials belong to projects, not users. |
| `src/components/workspace-users-navigation.tsx` | Users icon denotes a navigation destination, not a particular human. |
| `src/contexts/notification-context.tsx` | UserCheck denotes an event/action category, not a human identity. |
| `src/app/admin/page.tsx`, `src/app/admin/companies/[uuid]/page.tsx` | Users icon denotes aggregate counts, not a particular human. |
| `src/app/(dashboard)/settings/page.tsx` pre-existing `charAt(0)` | Session-status translation key construction, not avatar initials. Settings now embeds the dedicated avatar editor separately. |
| `src/components/ui/avatar.tsx` and `ui/user-avatar.tsx` fallback | Shared primitive and deliberate rendering-failure/missing-identity fallback, not an unmigrated normal identity surface. |

## Validation boundaries

`user-identity-avatar.test.tsx` exercises two simultaneous current-user avatars, another user's avatar, a separate unsaved preview, foreign-user update rejection, normal session refresh and missing-context fallback. Save revisions prevent an older in-flight session response from reverting saved avatars, while later refreshes still accept server truth; two delayed-ordering regressions cover both cases. `mention-editor-popup.test.tsx` verifies a saved user seed passes through the real local generator and loads into the existing picker slot. Existing AuthProvider session-recovery and unified-comments tests remain part of regression verification.

In an isolated PostgreSQL-backed browser instance, the task sidebar, Kanban card, assignee detail, comment input and historical comment author rendered five identical loaded data-URI avatars for one user. A real self-avatar PATCH returned the exact requested seed; subsequent task and historical-comment reads both returned that new seed. Screenshot: `.playwright-mcp/user-avatar-task-integration.png`.

Final scan on 2026-10-18 leaves only shared fallback primitives, TypeScript User type references, proposal actor-type category icons, assign-action icons and session translation key construction. The related audit lists each retained project surface. No Agent renderer/style/motion source changes exist in the diff.

Browser visual coverage, editor save/failure flow and final source scan are recorded in `acceptance-evidence.md`. This file is an execution audit, not a replacement for the approved specifications or their Chorus mirrors.
