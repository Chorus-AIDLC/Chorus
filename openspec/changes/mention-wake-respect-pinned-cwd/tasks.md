# Tasks

## 1. Audit + failing tests for the mention gap
- [ ] Codify a behavior matrix over every `NOTIFICATION_ACTION_TO_TURN_TRIGGER` value × {instance pin, online idea session-origin, project-owner pin, none}, documenting which cwd each resolves to today.
- [ ] Add unit tests encoding the DESIRED post-fix behavior for an un-pinned `mentioned` wake (session-origin upgrade when the mentioned agent owns the root idea's live session; project-owner-pin fallback otherwise) — these fail against current code (red).
- [ ] Add regression tests pinning the unchanged behavior: `task_assigned` ladder, explicit-pin mention, `human_instruction` exclusion, and the no-pin/no-session → online-first path.

## 2. Implement the fix
- [ ] In `src/services/notification-turn.ts`, remove `mentioned` from the session-origin-upgrade and project-owner-pin exclusion sets; keep `human_instruction` / `resource_resumed` excluded.
- [ ] Resolve the mention's root-Idea anchor (shared root-idea resolver) and apply the session-origin upgrade only when the mentioned agent is that root Idea's assignee agent.
- [ ] Apply the project-owner-pin fallback for the un-pinned mention `(mentioned agent, mention target's project)`.
- [ ] Make task 1's mention tests pass (green); full unit/integration suite green; no schema migration, new permission, or new endpoint.

## 3. Live e2e with Codex (separate test daemon)
- [ ] Stand up a separate daemon serving Claude + Codex (do NOT restart the daemon serving the working session).
- [ ] Pin Codex at the idea and project level to a chosen cwd.
- [ ] (a) Assign a task to Codex → confirm the wake lands in the pinned cwd.
- [ ] (b) Un-pinned `@mention` of Codex → confirm the wake lands in the pinned cwd (primary fix).
- [ ] (c) Codex `@mention`s the assigner back → confirm the return-wake lands in the assigner's pinned cwd.
- [ ] Capture daemon-log / transcript evidence of the landed cwd per case; hand final sign-off to the human if the live wake cannot be fully closed headlessly.
