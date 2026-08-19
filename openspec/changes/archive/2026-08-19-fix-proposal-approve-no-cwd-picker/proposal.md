# Proposal: Approve / Reject a proposal without a cwd picker

## Why

When a human approves (or rejects) a proposal in the UI, Chorus currently pops a
cwd/instance picker dialog (`WakeCwdPickerDialog`) whenever the proposal's input
idea is assigned to a **bare agent** that is online in **two or more** cwds. This
forces the reviewer to hand-pick a working directory just to approve — and, when
the agent is online in exactly **one** cwd, the flow silently rewrites the idea's
assignee into a durable `agent_instance` pin.

Neither is what the reviewer wants at this gate. Approving/rejecting is a
review decision, not a cwd-placement decision. The wake target should resolve
**automatically**, mirroring the un-pinned `@mention` model, and MUST NOT
interrupt the reviewer with a dialog under any circumstance at this stage.

## What Changes

**Scope: proposal Approve and Reject only.** Revoke / Close / Delete already do
not prompt. The three idea-panel wake surfaces (Verify Elaborate, Start
Development, Yolo) keep their existing pin-then-wake picker — this change does
not touch them.

After this change, the assignee wake fired by approving/rejecting a proposal
resolves its target with **no dialog, ever**, using this ladder (owner-locked in
elaboration round 1):

1. **Has a pin** — the idea-level `AgentInstance` pin OR a project-level fixed
   cwd (`ProjectAgentCwdPreference`) — → follow the pin (directed wake; an
   offline pin stays notify-only). Existing precedence, reused verbatim.
2. **The idea's existing online session-origin** → directed there (existing
   behavior, unchanged).
3. **No pin, exactly ONE online cwd** → wake that cwd (directed), **without
   persisting a durable pin** on the idea.
4. **No pin, TWO OR MORE online cwds** (ambiguous) → **notify-only**: the
   notification is created but the daemon wake is suppressed on every connection
   — no picker, no arbitrary online-first pick.
5. **Fully offline** → notify-only (unchanged).

"No notification" from the idea description is interpreted (per elaboration Q3)
as **"no daemon wake"**: the in-app notification / activity record is preserved,
matching an un-pinned offline `@mention`. No toast is shown after the action
(elaboration Q6) — the approve/reject simply succeeds.

## Capabilities (spec deltas)

- **pin-cwd-before-wake** (MODIFIED) — the resolve-before-wake button flow drops
  the two proposal entry points; only Verify Elaborate / Start Development / Yolo
  consult the wake-target preview and pick/persist a cwd.
- **daemon-single-active-session** (MODIFIED) — the deterministic
  single-connection narrow carves out `proposal_approved` / `proposal_rejected`:
  those follow the proposal-review resolution (suppress on ambiguity) instead of
  being narrowed to the first-online connection.
- **daemon-cwd-instance-addressing** (ADDED) — a new requirement specifying the
  proposal approve/reject wake resolution: no picker; honor pin + online
  session-origin + agent-owner project cwd; wake only on an unambiguous single
  online connection; suppress (notify-only) on two or more online connections;
  notify-only when offline.

## Impact

- **Client:** `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-actions.tsx`
  — approve/reject call `approveProposalAction` / `rejectProposalAction`
  directly (removing `usePinThenWake` + `WakeCwdPickerDialog`); its parent page
  drops the now-unused `inputIdeaAssigneeName` (and `inputIdeaUuid`) props. The
  shared `usePinThenWake` hook, `wake-preview.service`,
  `/api/ideas/[uuid]/wake-preview` route, and `WakeCwdPickerDialog` component
  **remain** (still used by the three idea-panel surfaces).
- **Server:** `src/services/notification-turn.ts` `createTurnAndResolveTarget`
  — a proposal-review ambiguity-suppression step before the single-active
  narrow. ECS-deployable; no schema, migration, or permission change.
- **design.pen:** the proposal-detail actions no longer show a cwd picker on
  approve/reject.

## Out of Scope

- Verify Elaborate / Start Development / Yolo keep the picker.
- The proposal-wake **recipient** (`proposal.createdByUuid` vs. the idea worker)
  is unchanged — a separately-tracked concern.
- No change to the online-first fallback for non-proposal triggers.
