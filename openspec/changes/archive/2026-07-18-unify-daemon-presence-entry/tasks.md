# Tasks — Unify daemon presence into one bottom-right entry

## 1. Merged floating entry (button + roster popover + open-chat)
- [ ] 1.1 Extract the pill's roster popover body (`PopoverBody` / `PopoverAgentGroup` / `PopoverInstanceRow` / `PopoverContentInner`) into a shared roster piece.
- [ ] 1.2 Build `DaemonPresenceEntry`: fixed bottom-right button with the reused `(status, onlineCount)` status dot + online-count badge; on click opens the roster popover with a prominent one-click open-chat action calling `useAgentPresence().setModalOpen(true)`.
- [ ] 1.3 Preserve online-only filter, per-agent collapse, deterministic order, running/queued rows + Interrupt control, interrupted-excluded, and the 0-online `DaemonConnectCta`.
- [ ] 1.4 Remove `AgentPresencePill` from `SidebarContent` (desktop + mobile). Mount `DaemonPresenceEntry` once under `AgentPresenceProvider` in `layout.tsx`.
- [ ] 1.5 i18n both locales; light + dark theme correctness.

## 2. Pixel-canvas as project-scoped secondary view
- [ ] 2.1 Refactor `PixelCanvasWidget`: drop its standalone fixed bottom-right button; make the canvas `Dialog` a controlled secondary view (open-state lifted), keeping its project-scoped active-sessions fetch + `useRealtimeEvent`.
- [ ] 2.2 Bridge open-state across the shell↔project provider boundary so the entry's "View activity" affordance can open the pixel view; the affordance is ABSENT when no project context is active.
- [ ] 2.3 Re-mount in `layout.tsx`: pixel view lives inside the project `RealtimeProvider` branch; global pages show roster + chat only.
- [ ] 2.4 i18n secondary-view label; light + dark theme correctness.

## 3. Integration checkpoint (end-to-end)
- [ ] 3.1 Real-browser e2e: on a project page the entry shows count badge, one click → roster → open-chat opens the chat modal, and "View activity" opens the pixel canvas; on a global page (/projects, /settings) the entry works for roster + chat with NO pixel affordance and NO sidebar pill; verified in both themes.
