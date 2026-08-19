# Tasks

## 1. Server: proposal-review ambiguity suppression
- [ ] Add the `(4a-bis)` proposal-review block to `createTurnAndResolveTarget` in `src/services/notification-turn.ts` (gated on `ctx.action ∈ {proposal_approved, proposal_rejected}` and `selection.kind === "online_first"`; ≥2 online → `suppressWake` notify-only; exactly 1 → fall through to the step-4b directed narrow).
- [ ] TDD red→green in `src/services/__tests__/notification-turn.test.ts` (approve/reject × {2 online → suppress, 1 online → directed}; regressions: instance pin / session-origin / project-owner pin still directed; offline → none; non-proposal `task_assigned` + 2 online still narrows).

## 2. Client: remove the approve/reject cwd picker
- [ ] `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-actions.tsx` — approve/reject call the server actions directly; remove `usePinThenWake`, `WakeCwdPickerDialog`, `reassignIdeaInstanceNoWakeAction`, and the now-unused `inputIdeaAssigneeName` / `inputIdeaUuid` props; drop `isResolving` from the button disabled state; clean up the parent page that passes the dropped props.
- [ ] Confirm the shared hook / preview service / route / dialog remain intact for Verify Elaborate / Start Development / Yolo.
- [ ] Update `docs/design.pen` to drop the approve/reject cwd picker.
- [ ] Local Playwright verification (e2e-verification skill): a pending proposal → Approve shows no dialog and succeeds.
