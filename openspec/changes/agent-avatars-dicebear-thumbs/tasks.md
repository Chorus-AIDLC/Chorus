## 1. Foundation — dependencies + shared `<AgentAvatar>` component

- [ ] 1.1 Add `@dicebear/core` + `@dicebear/styles` (DiceBear v10); confirm no native bindings and that only the Thumbs definition is imported
- [ ] 1.2 Pin the exact installed version and verify the constructor/factory, the animation option name + legal values, the seed option, and the SVG/data-URI output method against that version's docs (do not rely on memory)
- [ ] 1.3 Implement `src/components/ui/agent-avatar.tsx` wrapping shadcn `<Avatar>`/`<AvatarImage>`: seed = name (coordinated with `getAgentColor`), animated by default, `prefers-reduced-motion` static fallback, module-level memo cache, size variants, `<Bot>`/initial fallback
- [ ] 1.4 Unit tests: determinism (same name → same SVG), local generation (no network), reduced-motion fallback, memoization

## 2. Sweep — collaboration surfaces (agents only; users unchanged)

- [ ] 2.1 Comment author avatars (`unified-comments.tsx`) — agent branch only
- [ ] 2.2 Idea/Task assignee displays: `ideas/idea-detail-panel.tsx`, `tasks/task-detail-panel.tsx`, `tasks/kanban-board.tsx`, `dashboard/panels/assignee-section.tsx`, `dashboard/panels/task-list-view.tsx`
- [ ] 2.3 Assign modals (`assign-task-modal.tsx`, `assign-idea-modal.tsx`) and the @mention picker (`mention-editor.tsx`, incl. its raw-DOM avatar markup)

## 3. Sweep — presence & graph surfaces + API-key list (agents only)

- [ ] 3.1 Presence surfaces: `agent-presence/presence-roster.tsx`, `instance-group.tsx`, `identity-block.tsx`, `daemon-presence-entry.tsx`
- [ ] 3.2 Live-edit presence indicator (`ui/presence-indicator.tsx`, `AgentBadge`) and mindmap presence ring (`graph/mindmap-canvas.tsx`, best-effort per design D5 — document treatment)
- [ ] 3.3 API-key list icon in `settings/page.tsx` (seed by key name)

## 4. New avatar surfaces

- [ ] 4.1 Create-agent / onboarding live avatar preview (`AgentCreateForm.tsx`, `onboarding/components/CreateAgentStep.tsx`)
- [ ] 4.2 Project cwd-pin hover card: add avatar next to cwd (`dashboard/project-cwd-summary.tsx`)
- [ ] 4.3 Daemon chat message header avatar (`agent-presence/chat/message.tsx`)

## 5. Integration verification & docs

- [ ] 5.1 End-to-end check across all swept + new surfaces in BOTH light and dark themes; confirm users still render with initials/`User` icon and no external network calls fire
- [ ] 5.2 i18n: any new user-facing strings added to both `messages/en.json` and `messages/zh.json`
- [ ] 5.3 Update `docs/design.pen` for changed/added surfaces (human/online-session step)
