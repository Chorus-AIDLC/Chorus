# Tasks: add-stage-advance-start-development

> Chorus task drafts are the source of truth; this file mirrors them for local reference.

## 1. Stage-advance framework + elaboration-verify migration

- [ ] Create `src/services/stage-advance.service.ts` with the per-stage definition shape and shared `executeStageAdvance` helper (actor gate, company-scoped idea lookup, precondition, offline policy, optional transition, activity emit)
- [ ] Migrate `verifyElaboration` onto the framework, behavior-preserving; existing tests pass unchanged
- [ ] Unit tests for the shared helper (actor gate, company scoping, precondition-fails-emit-nothing, offline policies)

## 2. `start_development` server path

- [ ] Precondition service (approved proposal, unfinished tasks, agent assignee, effectively-online agent) with distinguishable error codes
- [ ] `startDevelopmentAction` server action (human-only, company-scoped, revalidatePath)
- [ ] `start_development` activity emit (wake-only, no state transition)
- [ ] Unit tests per precondition branch

## 3. Wake wiring (server + daemon)

- [ ] `notification-listener.ts`: `idea:start_development` mapping + agent-only recipient + message
- [ ] `notification-turn.ts`: dedicated trigger + `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`
- [ ] `daemon-session.service.ts`: `TURN_TRIGGERS`
- [ ] `cli/event-router.mjs`: action map + re-dispatch trigger list
- [ ] `cli/prompts.mjs`: `WAKE_ACTIONS` + execute-all prompt case
- [ ] Server + daemon tests for the mapping/parity

## 4. UI button

- [ ] `src/lib/start-development.ts` shared predicate + tests
- [ ] Both idea-detail panels: header button, AgentPresence gating, offline-disabled hint, error toasts
- [ ] i18n keys (en + zh)

## 5. Integration checkpoint

- [ ] End-to-end: approve → button → click → session-origin wake with execute-all prompt; offline → specific error
- [ ] design.pen update + skill docs note (both roots)
