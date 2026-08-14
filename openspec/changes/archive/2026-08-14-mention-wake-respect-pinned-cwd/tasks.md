# Tasks

## 1. Audit + failing tests for the mention gap
- [x] Codify a behavior matrix over every `NOTIFICATION_ACTION_TO_TURN_TRIGGER` value × {instance pin, online idea session-origin, project-owner pin, none}, documenting which cwd each resolves to today.
- [x] Add unit tests encoding the DESIRED post-fix behavior for an un-pinned `mentioned` wake (session-origin upgrade when the mentioned agent owns the root idea's live session; project-owner-pin fallback otherwise) — these fail against current code (red).
- [x] Add regression tests pinning the unchanged behavior: `task_assigned` ladder, explicit-pin mention, `human_instruction` exclusion, and the no-pin/no-session → online-first path.

## 2. Implement the fix
- [x] In `src/services/notification-turn.ts`, add `RESIDUAL_CWD_UPGRADE_TRIGGERS` (the autonomous idea-anchored family ∪ `mentioned`) and gate the session-origin-upgrade and project-owner-pin steps on it; keep `human_instruction` / `resource_resumed` excluded.
- [x] Audit correction: an un-pinned mention already pre-resolves the direct-idea instance pin and the mentioner-owner project pin at notification-creation time; the genuine gaps closed are the idea session-origin upgrade for `mentioned` and a target-agent-owner project-pin fallback.
- [x] Make task 1's mention tests pass (green); full unit/integration suite green; no schema migration, new permission, or new endpoint.

## 3. Live e2e with Codex
- [x] Multi-agent daemon already served Claude + Codex (no separate daemon needed); re-tested on a FRESH daemon after each fix.
- [x] (a) Directed pinned wake → confirmed lands in the resolved pinned cwd (RETEST-A2: explicit pin → strands → codex `pwd` = strands).
- [x] (b) Un-pinned `@mention` → server session-origin/project-pin upgrade confirmed directing correctly (broadcast→directed flip); physical landing confirmed by the shared directed-delivery path.
- [x] (c) Codex `@mention`s the assigner back → return-wake landed in the assigner's pinned cwd (Codex → Admin Claude → ai-pm instance pin).
- [x] Captured daemon-log evidence of the landed cwd per case (deliver_turn → resolved connection; codex `pwd` matches).

## 4. Fix the daemon-seam surfaced by the e2e (directed wake spawn cwd)
- [x] Root-caused: a cross-cwd directed wake re-pointed the session origin but left `session.runtimeCwd` stale, which the server then stamped and the daemon honored over the receiving connection's own cwd — so codex spawned in the old cwd despite correct routing.
- [x] In `src/services/notification-turn.ts`, stamp the RESOLVED target connection's own cwd (`origin.cwd`) for a directed wake instead of the stale `session.runtimeCwd`, and refresh `session.runtimeCwd` on the cross-cwd re-point (owner rule: an explicit pin is fixed to that pin, no fallback). project-fixed / temporary / task-runtime pins keep their explicit `pin.runtimeCwd`; non-directed wakes unchanged.
- [x] Red→green regression test for the stale-session-cwd case; 109 wake-service tests green; `tsc` clean.
- [x] Deployed to live (ECS) and re-verified end-to-end (RETEST-A2).
