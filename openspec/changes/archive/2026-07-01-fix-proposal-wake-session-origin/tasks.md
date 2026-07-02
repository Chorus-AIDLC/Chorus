# Tasks: fix-proposal-wake-session-origin

## 1. Generalize the idea-session-origin wake upgrade
- [ ] 1.1 Rename `resolveElaborationVerifiedTarget` → `resolveIdeaSessionOriginTarget` in `notification-turn.ts`; update its doc comment to the generic idea-session-origin resolver (behavior unchanged)
- [ ] 1.2 Add `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS = { task_assigned, elaboration, elaboration_verified }` set near the trigger map
- [ ] 1.3 Broaden the gate at the upgrade site: from `trigger === "elaboration_verified" && online_first` to `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS.has(trigger) && online_first`; call the renamed helper
- [ ] 1.4 Confirm no daemon-client change needed (directed-delivery transport already keyed off resolved target)

## 2. Tests
- [ ] 2.1 `notification-turn.test.ts`: `proposal_approved` and `proposal_rejected` route to the idea's online session origin (un-pinned idea) and emit `deliver_turn`
- [ ] 2.2 `idea_claimed` routes to the idea's session origin
- [ ] 2.3 Priority preserved: an instance-pinned idea takes the pin, upgrade skipped
- [ ] 2.4 Fallback: no idea session → `online_first`, no target; offline origin → `online_first`, no target
- [ ] 2.5 Exclusions: un-pinned `mentioned` stamps no target (broadcast); `human_instruction` not upgraded by the chokepoint
- [ ] 2.6 Plain idea-anchored `task_assigned` routes to the idea's session origin; standalone (no-lineage) `task_assigned` with `directIdeaUuid === null` stays `online_first` (null-guard exercised)
- [ ] 2.7 `pnpm test` green for the file; `npx tsc --noEmit` clean

## 3. Verify
- [ ] 3.1 Local two-cwd daemon e2e (per idea verification suggestion): advance an idea to a proposal from cwd A, approve/reject → assert the woken connection is A's session origin, not B
