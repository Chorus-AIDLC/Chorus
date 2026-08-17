## Why

Chorus agents are shown all over the product, but their visual identity is a single generic `Bot` glyph on a name-hashed background color (`getAgentColor`) — every agent looks nearly the same, and several surfaces that reference an agent (create/onboard flow, API-key list, the project cwd pin, the daemon chat) show no avatar at all. Giving each agent a distinctive, deterministic avatar makes agents recognizable at a glance and makes human↔agent collaboration feel more alive.

## What Changes

- Introduce a shared **`<AgentAvatar>`** React component that renders a **DiceBear "Thumbs" (animated)** avatar for an agent, generated **locally** (no external network) and **deterministically seeded by the agent's name** (the same seed `getAgentColor` already uses, so color and avatar stay in sync).
- Add `@dicebear/core` + `@dicebear/styles` as dependencies (pure JS/WASM, no native bindings — safe for the multi-platform npm publish).
- **Replace** the current `Bot`-glyph agent rendering at every agent surface with `<AgentAvatar>`: comment authors, Idea/Task assignees (detail panels, Kanban cards, assignee section, task list, assign modals), the @mention picker, the presence roster / identity blocks / bottom-right presence entry, the live-edit presence indicator, the mindmap presence ring, and the API-key list icon.
- **Add** an avatar where there is none today: the create-agent / onboarding avatar preview (live, driven by the typed name), the project-top cwd pin hover card (cwd **plus** avatar), and the daemon chat message header.
- Animation plays **always** (looping), degrading to a static avatar when the OS `prefers-reduced-motion` is set (accessibility).
- **Scope: agents only.** Human users keep their current initials/`User` icon this round. No agent/user avatar for users, no reroll, no avatar customization UI, **no schema change**.

## Capabilities

### New Capabilities
- `agent-avatar`: how an agent's avatar is generated (style, seed, animation, accessibility) and the requirement that every agent-rendering surface uses the shared component.

### Modified Capabilities
- _(none — there is no pre-existing `openspec/specs/` capability for agent identity; this is additive.)_

## Impact

- **New dependencies:** `@dicebear/core`, `@dicebear/styles` (DiceBear v10). Small bundle addition (core + the Thumbs style definition).
- **New code:** `src/components/ui/agent-avatar.tsx` (shared component) + a small seed/generation helper alongside `src/lib/agent-color.ts`.
- **Touched UI (agent-identity surfaces only — full list from a two-agent sweep):** `unified-comments.tsx`; `ideas/idea-detail-panel.tsx`; `tasks/task-detail-panel.tsx` (assignee + Active Workers); `tasks/kanban-board.tsx` (assignee + blocker dialog); `tasks/task-view-toggle.tsx`; `dashboard/panels/assignee-section.tsx`, `task-list-view.tsx`; `assign-task-modal.tsx`, `ideas/assign-idea-modal.tsx`, `components/assign-modal.tsx`; `mention-editor.tsx`, `agent-presence/mention-badge.tsx`; `proposals/proposal-kanban.tsx`, `proposals/[proposalUuid]/page.tsx` (single creator identity); `agent-presence/*` (presence-roster, instance-group, identity-block, daemon-presence-entry, connections-view, chat/message.tsx, chat/conversation-list.tsx selector, conversational-entry.tsx); `ui/presence-indicator.tsx`; `graph/mindmap-canvas.tsx` (best-effort); `settings/page.tsx` (API-key list, seed=owning-agent name); `components/project-agent-cwd-settings.tsx`; `dashboard/project-cwd-summary.tsx`; `AgentCreateForm.tsx`, `onboarding/components/CreateAgentStep.tsx` + `TestConnectionStep.tsx` + `CompletionStep.tsx`.
- **Deliberately excluded** (semantic/decorative, not a specific agent): admin "Total Agents" KPI icons, projects onboarding "admin-agent tip" icon, elaboration empty-state Bot. **Deferred (follow-up):** activity-feed + notification actor avatars.
- **No DB / API / migration changes.** Seed is derived at render time from the agent name already present at every site.
- **Docs:** `docs/design.pen` updated for the changed/added surfaces; any new user-facing strings added to both `messages/en.json` and `messages/zh.json`.
