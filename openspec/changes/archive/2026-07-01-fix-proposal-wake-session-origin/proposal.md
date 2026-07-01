# Proposal: Route proposal approve/reject daemon wakes to the idea's existing session origin

## Why

When a Proposal is **approved** or **rejected**, the daemon wake it triggers lands on an
**arbitrary online connection (random cwd)** of the assigned agent — not the connection where
that proposal's Idea conversation is actually running. A session started in cwd `A` to advance
an Idea gets its approval/rejection answered by the agent in cwd `B`, where the context does
not match.

By contrast, `elaboration_verified` (the human "Verify Elaborate" handoff) routes correctly to
the connection that owns the Idea's session. The two paths are inconsistent, and the
inconsistency is not by design — it is an accident of how the upgrade was gated.

Root cause (verified against the code, file:line):

1. **Trigger mapping hides the upgrade from proposal events.** `proposal_approved` and
   `proposal_rejected` are both mapped to the `task_assigned` turn trigger
   (`src/services/notification-turn.ts:129-130`). The session-origin direction — the logic that
   points a wake at the connection owning the Idea's session
   (`resolveElaborationVerifiedTarget`, reading `DaemonSession.originConnectionUuid`) — is gated
   on `trigger === "elaboration_verified"` (`src/services/notification-turn.ts:625`). So a
   proposal event can **never** take that path.

2. **Pin resolution is reachable for proposals but resolves to null in the common case.** The
   lineage resolver **can** walk a proposal → root idea via `inputUuids[0]`
   (`src/services/lineage.service.ts:171-218`; `LINEAGE_ENTITY_TYPES` includes `proposal` at
   `notification-turn.ts:140`), so `resolvePinnedTarget` is reachable. But it only returns a pin
   when the root Idea is **explicitly assigned to an `agent_instance`**
   (`resolveIdeaInstancePin`, `notification-turn.ts:338-355`). Most Ideas are not instance-pinned
   — they are merely being advanced by a daemon session in some cwd — so the pin is null and the
   selection falls to `online_first` = **the agent's first online connection = arbitrary cwd**.

The two facts compound: no pin **and** no session-origin upgrade ⇒ `online_first`. That is the
random-cwd wake the user observed (`selectOriginConnection`, `notification-turn.ts:424`).

The fix the owner approved (elaboration Round 1, all five questions answered): **stop gating the
session-origin upgrade on a single trigger.** Apply it to every **autonomous, idea-anchored**
wake whose selection is still `online_first` and whose entity resolves to an Idea anchor — which
covers `proposal_approved` / `proposal_rejected` and, as a bonus, `idea_claimed` and the task
wakes — eliminating the per-trigger special case rather than bolting on a second one.

## What Changes

- **Generalize the session-origin upgrade beyond `elaboration_verified`.** In
  `createTurnAndResolveTarget`, the upgrade that re-points an `online_first` selection to the
  Idea's existing `DaemonSession.originConnectionUuid` SHALL fire for the **autonomous
  idea-anchored trigger family** — `task_assigned` (into which `proposal_approved`,
  `proposal_rejected`, `idea_claimed`, `task_verified`, `task_reopened` all collapse) and
  `elaboration` / `elaboration_verified` — not only `elaboration_verified`. The gating condition
  becomes "the selection is `online_first` **and** a `directIdeaUuid` resolved **and** the trigger
  is one of the autonomous idea-anchored triggers."

- **Two triggers are deliberately excluded** from the upgrade because they carry their own target
  resolution and have their own directed-delivery contracts:
  - `mentioned` — an un-pinned mention is contractually a broadcast → online-first wake (see the
    existing `daemon-cwd-instance-addressing` "un-pinned mention" scenario). A pinned mention
    never reaches `online_first` (it resolves to `directed`/`offline_pin`). Either way the upgrade
    must not touch it.
  - `human_instruction` — the UI send-box resolves the exact target session and emits its own
    `deliver_turn` ping in `daemon-instruction.service`. Letting the chokepoint also upgrade it
    risks a divergent target / double delivery.

- **Rename the helper to reflect its generalized role.** `resolveElaborationVerifiedTarget` →
  `resolveIdeaSessionOriginTarget` (behavior unchanged: look up the idea-anchored
  `DaemonSession`, return its origin connection iff online). The rename keeps the code honest now
  that the function serves all autonomous idea-anchored wakes.

- **Priority semantics preserved (owner Q5=a).** The upgrade still applies **only** when the
  selection is `online_first` — i.e. only when no higher-priority pin matched. A hard mention pin
  or a soft assignment / idea-instance pin still wins and the upgrade is skipped, exactly as
  today. The resolved order remains: hard mention pin → soft assignment/idea-instance pin → idea
  session origin → agent online-first.

- **No-session / offline-origin fallback (owner Q4=a).** When the Idea has no existing daemon
  session (e.g. it was elaborated entirely in the UI and the daemon was never woken on it), or
  the session's origin connection is offline, the wake falls back to the existing `online_first`
  selection — byte-identical to the pre-change behavior and identical to today's
  `elaboration_verified` fallback.

- **Scope: both `approved` and `rejected` (owner Q3=a).** Both proposal review outcomes share the
  same root cause and are fixed together.

## Capabilities

### Modified Capabilities

- `daemon-cwd-instance-addressing`: The existing requirement "The proposal-writing wake SHALL be
  directed to the idea's existing session origin" is generalized to "The autonomous idea-anchored
  wake SHALL be directed to the idea's existing session origin" — the session-origin direction now
  covers `proposal_approved` / `proposal_rejected` / `idea_claimed` / task wakes (the autonomous
  idea-anchored trigger family), not only the `elaboration_verified` proposal-writing wake, while
  preserving the pin-priority order and explicitly excluding the directed `mentioned` /
  `human_instruction` triggers.

## Impact

- **Schema**: **zero migrations.** No model, column, enum, or permission-bit change. This is a
  pure routing-logic change in one service function.
- **Backend code**:
  - `src/services/notification-turn.ts` — broaden the upgrade gate in
    `createTurnAndResolveTarget` from `trigger === "elaboration_verified"` to the autonomous
    idea-anchored trigger set; rename `resolveElaborationVerifiedTarget` →
    `resolveIdeaSessionOriginTarget` and update its callers and doc comments.
- **Tests**:
  - `src/services/__tests__/notification-turn.test.ts` — add coverage asserting
    `proposal_approved` / `proposal_rejected` / `idea_claimed` wakes route to the Idea's session
    origin when `online_first`; that an instance-pinned Idea still takes the pin (priority
    preserved); that the no-session and offline-origin cases fall back to `online_first`; and that
    `mentioned` (un-pinned) and `human_instruction` are unaffected.
- **Recipient resolution unchanged (owner Q2=a).** `proposal_approved` / `proposal_rejected`
  continue to notify `proposal.createdByUuid` (`notification-listener.ts:277-287`). The
  creator≠worker divergence is real but out of scope for this fix (see Out of Scope).
- **Daemon client code**: none. The daemon's broadcast-suppression logic already keys off the
  transport-only resolved target; a newly-directed proposal wake reuses that machinery with no
  client change.
- **Frontend / i18n / docs**: none.
- **Backward compat**: additive and narrowing-safe. Un-pinned proposal/idea/task wakes that
  previously fanned out to `online_first` are now directed to the idea's session origin **when one
  exists and is online**; when none exists or it is offline, behavior is byte-identical to today.
  Instance-pinned wakes, un-pinned mentions, and human instructions are unchanged.

## Out of Scope

- **Changing the proposal-event recipient** from `proposal.createdByUuid` to the Idea's worker
  (owner chose Q2=a: keep `createdByUuid`). The session-origin query uses `recipientUuid` as the
  `agentUuid`, so if a future scenario routinely has creator≠worker, both the woken agent and the
  session lookup would be wrong — that is a separate behavior change, deliberately deferred to
  avoid mixing two concerns in one bugfix.
- **Adding an Idea pin column / instance picker for Ideas.** The Idea entity intentionally has no
  pinned-instance columns; routing is derived from the existing session origin.
- **The `mentioned` and `human_instruction` directed-delivery paths.** Their contracts are
  unchanged.
- **A durable queue / backfill for offline session origins.** Consistent with the existing
  online-only wake policy, an offline origin falls back to `online_first`; there is no new
  queue.
