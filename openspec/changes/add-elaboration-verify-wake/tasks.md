# Tasks: add-elaboration-verify-wake

## 1. Backend resolution path (human verify)
- [ ] 1.1 Add `verifyElaboration` to `elaboration.service.ts` (user-actor, company-scoped, same precondition as resolve, sets elaborated/resolved, logs `elaboration_verified` activity)
- [ ] 1.2 Add `verifyElaborationAction` server action in `ideas/[ideaUuid]/elaboration-actions.ts` (gated on auth.type user/super_admin)
- [ ] 1.3 Unit tests: precondition, company scope, actor-type rejection, activity action

## 2. Wake wiring
- [ ] 2.1 `notification-listener.ts`: map `idea:elaboration_verified` → notification type, recipient = assigned agent
- [ ] 2.2 `notification-turn.ts`: `NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_verified"] = "elaboration_verified"`
- [ ] 2.3 `daemon-session.service.ts`: add `elaboration_verified` to `TURN_TRIGGERS`
- [ ] 2.4 Tests: notification recipient is agent (not human), turn trigger value

## 3. Daemon prompt
- [ ] 3.1 `cli/prompts.mjs`: add `elaboration_verified` to `WAKE_ACTIONS`
- [ ] 3.2 `cli/prompts.mjs`: add prompt case directing the agent to write the proposal (not answer questions)

## 4. Frontend button
- [ ] 4.1 Shared enable-predicate helper (status elaborating, ≥1 round, no pending_answers, not resolved)
- [ ] 4.2 `/ideas` `idea-detail-panel.tsx`: replace Create Proposal with Verify Elaborate + post-verify/offline states
- [ ] 4.3 dashboard `panels/idea-detail-panel.tsx`: add Verify Elaborate button
- [ ] 4.4 i18n keys (button label, post-verify hint, offline hint) in en + zh
- [ ] 4.5 Keep proposals-list generic Create Proposal

## 5. Integration checkpoint
- [ ] 5.1 E2E: answer rounds → verify → idea elaborated → agent woken with write-proposal prompt (online) / queued (offline)

## 6. Docs & design
- [ ] 6.1 Update `docs/design.pen` idea-detail panel mock(s)
- [ ] 6.2 One-line skill-doc note (public/skill + chorus-plugin) on verify→write-proposal wake
