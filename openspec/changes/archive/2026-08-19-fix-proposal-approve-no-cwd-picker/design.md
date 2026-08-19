# Technical Design: Approve / Reject without a cwd picker

## Overview

Two coordinated layers:

1. **Client** — proposal approve/reject stop running the pin-then-wake
   orchestration (which opens the dialog and, on single-online, persists a pin)
   and instead call `approveProposalAction` / `rejectProposalAction` directly.
2. **Server** — the wake chokepoint `createTurnAndResolveTarget` gains a
   proposal-review-specific step that, for an un-pinned `proposal_approved` /
   `proposal_rejected` wake, wakes **only** when exactly one connection is
   online and otherwise **suppresses** (notify-only), replacing the
   single-active narrow's "direct to the first online connection" for these two
   actions.

Both are required: removing the client dialog alone would leave the ≥2-cwd case
falling to the server's single-active narrow (first-online, arbitrary) — the
exact behavior the owner rejected.

## Current wiring (grounding — verified in code)

- **Client** `proposal-actions.tsx`: `handleApprove` / `handleReject` call
  `startPinThenWake({ ideaUuid: inputIdeaUuid, wake })` (`use-pin-then-wake.ts`).
  The hook fetches `GET /api/ideas/[uuid]/wake-preview`
  (`wake-preview.service.ts` → `previewIdeaWakeTarget`) and branches:
  - `direct` (already `agent_instance`-pinned, OR 0 online, OR no agent) → wake now.
  - `auto_pin` (exactly 1 online) → `reassignBestEffort` (persist the sole
    instance as an `agent_instance` pin), then wake.
  - `pick` (≥2 online, bare agent) → open `WakeCwdPickerDialog`; on confirm,
    `reassignBestEffort` the chosen instance, then wake.
  The same hook backs five surfaces: Verify Elaborate, Start Development, Yolo,
  and the two proposal actions.
- **Server** `notification-turn.ts` `createTurnAndResolveTarget`:
  `proposal_approved` / `proposal_rejected` map to the `task_assigned` trigger
  (`NOTIFICATION_ACTION_TO_TURN_TRIGGER`), which is in
  `RESIDUAL_CWD_UPGRADE_TRIGGERS`. The resolution ladder:
  - **(3)** `resolvePinnedTarget` → `selectOriginConnection`: an instance/mention
    hard pin online → `directed`; offline → `offline_pin` (notify-only); else
    `online_first`.
  - **(4)** idea session-origin upgrade (`resolveIdeaSessionOriginTarget`): if
    still `online_first` and the idea has an ONLINE session origin → `directed`.
  - **(4a)** agent-owner project-cwd pin (`resolveProjectOwnerCwdPin`): if still
    `online_first` → re-select against the project pin (`directed` /
    `offline_pin`).
  - **(4b)** single-active-session narrow: if still `online_first`, promote to
    `directed` on the first online connection (deterministic; the fix for
    duplicate work across an agent's multiple cwds).
  - `offline_pin` → `{ turn:null, targetConnectionUuid:null, suppressWake:true }`
    (notify-only, every connection suppresses). `none` (no online connection) →
    no turn, `suppressWake:false`.
- The raw action survives on `ctx.action` even though `trigger` collapses to
  `task_assigned` — so proposal actions are distinguishable at the chokepoint.
- `suppressWake:true` is threaded by `notification.service` onto each recipient's
  `new_notification` SSE event and consumed by `cli/event-router.mjs`
  (`transport.suppressWake === true` → suppress on every connection). This is the
  existing, well-tested mechanism the offline-pin case uses.

## Client change (`proposal-actions.tsx`)

- `handleApprove` / `handleReject` → call `runApproveWake(note)` /
  `runRejectWake(reason)` directly (identical to the existing `!inputIdeaUuid`
  branch), for all cases.
- Remove: the `usePinThenWake({...})` call and its destructured
  `startPinThenWake` / `pickerState` / `confirmPick` / `cancelPick` /
  `isResolving`; the `<WakeCwdPickerDialog>` mount; the `usePinThenWake`,
  `reassignIdeaInstanceNoWakeAction`, and `WakeCwdPickerDialog` imports; the
  `isResolving` term from the approve/reject buttons' `disabled` conditions.
- Remove the now-unused `inputIdeaAssigneeName` prop (used only by the picker);
  `inputIdeaUuid` becomes unused too — drop it and update the parent proposal
  page that passes these props.
- Net effect: **no dialog** (pick removed), **no durable pin write** (auto_pin
  reassign removed → elaboration Q4=a), **no toast** (Q6=a).
- The shared hook / preview service / route / dialog component stay — the three
  idea-panel surfaces still use them.

## Server change (`notification-turn.ts` `createTurnAndResolveTarget`)

Insert a new step **after 4a (project-owner pin) and before 4b (single-active
narrow)**:

```
// (4a-bis) Proposal-review ambiguity suppression (idea 146a7a9b). Approving or
// rejecting a proposal must resolve the assignee wake WITHOUT a cwd picker:
// honor a pin / online session-origin / agent-owner project pin (steps 3/4/4a
// above), else wake ONLY when the online target is unambiguous. With NO such
// resolution AND two-or-more online connections, SUPPRESS the wake (notify-only)
// rather than narrowing to an arbitrary first-online (the removed dialog's job).
const isProposalReviewAction =
  ctx.action === "proposal_approved" || ctx.action === "proposal_rejected";
if (isProposalReviewAction && selection.kind === "online_first") {
  const onlineCount = connections.filter(c => c.effectiveStatus === "online").length;
  if (onlineCount >= 2) {
    // Ambiguous: no single determinable cwd → notify-only, no wake, suppress on
    // every connection. Same shape as offline_pin; the notification stands.
    return { turn: null, targetConnectionUuid: null, runtimeCwd: null, suppressWake: true };
  }
  // Exactly one online → fall through; step 4b promotes it to `directed`.
}
```

- **Gate** on `selection.kind === "online_first"` so any hard pin (step 3), online
  session-origin (step 4), or agent-owner project pin (step 4a) already
  short-circuited to `directed` / `offline_pin` and is never overridden —
  elaboration Q5's "reuse existing pin precedence" holds exactly.
- **Exactly-1** online → deliberately fall through to the existing step 4b, which
  promotes `online_first` → `directed` on the sole connection (wakes it). No pin
  is persisted — the server never writes an idea pin; the client `reassign` was
  the only persist and it is removed (Q4=a).
- **≥2** online → return the offline-pin shape (`suppressWake:true`, no turn).
- **Offline** (`selection.kind === "none"`) → unchanged (no turn,
  `suppressWake:false`; the notification stands).
- Non-proposal residual triggers are untouched — the block is gated on
  `ctx.action`, so `task_assigned` (real assignment), `elaboration`,
  `mentioned`, etc. still reach step 4b and narrow as today.

## Module Contracts

- **Suppress signal:** `{ turn:null, targetConnectionUuid:null, runtimeCwd:null,
  suppressWake:true }` — identical to the offline-pin return. Downstream:
  `notification.service` stamps `suppressWake` on the per-recipient SSE event;
  `cli/event-router.mjs` suppresses the wake on every connection. The
  `Notification` row is still created upstream by `notification-listener`
  (notify-only = Q3=a: keep notification, suppress wake).
- **Action discrimination:** use `ctx.action ∈ {proposal_approved,
  proposal_rejected}` — NOT `trigger` (which is `task_assigned` for both).

## Final precedence ladder (proposal_approved / proposal_rejected)

1. idea `AgentInstance` pin (step 3) → directed / offline_pin(notify-only)
2. online idea session-origin (step 4) → directed
3. agent-owner project fixed cwd (step 4a) → directed / offline_pin
4. **[new] no pin, exactly 1 online → directed (that one, no persisted pin)**
5. **[new] no pin, ≥2 online → notify-only (suppressWake)**
6. fully offline → notify-only

## Risks & Mitigations

- **Shared wake code touched.** Mitigation: the new block is gated on
  `ctx.action` (proposal-only) AND `selection.kind === "online_first"`; all
  other triggers/paths are byte-identical.
- **exactly-1 no longer persists a pin.** Intended (Q4=a); the case still wakes
  via the step-4b directed narrow.
- **Spec conflict with the single-active narrow** (which currently mandates
  narrowing residual `online_first` to one). Mitigation: MODIFY
  daemon-single-active-session to carve out the two proposal actions.
- **Recipient is `proposal.createdByUuid`, not necessarily the idea worker.**
  Unchanged and out of scope; pin resolution still walks lineage to the root
  idea regardless of recipient identity, so pin/session-origin honoring is
  correct for the common case (proposal creator == idea assignee).

## Test Plan

- **Server unit** (`notification-turn.test.ts`, mocked connections — the file's
  existing pattern):
  - `proposal_approved` + no pin + 2 online → `turn:null`, `targetConnectionUuid:null`, `suppressWake:true`.
  - `proposal_approved` + no pin + 1 online → `directed` to it, `suppressWake:false`, turn created.
  - `proposal_rejected` symmetric to both above.
  - Regression: `proposal_approved` + online idea instance pin → directed to the pin (gate skipped).
  - Regression: `proposal_approved` + online session-origin → directed there.
  - Regression: `proposal_approved` + agent-owner project pin → directed there.
  - Regression: `proposal_approved` + offline agent → `none`, no turn, `suppressWake:false`.
  - Control: non-proposal `task_assigned` + no pin + 2 online → still narrows to one (single-active unchanged).
- **Client**: `proposal-actions` renders no `WakeCwdPickerDialog`; approve/reject
  invoke the action directly; the three idea-panel surfaces are unaffected.
  Local Playwright (e2e-verification skill): open a pending proposal → Approve →
  no dialog, action succeeds.
- **design.pen** updated to drop the approve/reject cwd picker.
