# Technical Design: Generalize the idea-session-origin wake upgrade

## Overview

`createTurnAndResolveTarget` (`src/services/notification-turn.ts:573`) is the single chokepoint
that turns a wake notification into a `DaemonSessionTurn` and decides which connection to wake.
Its connection selection runs in this order:

1. `resolvePinnedTarget` → a hard mention pin or a soft assignment/idea-instance pin.
2. `selectOriginConnection(connections, pin)` → classifies the result as `directed`,
   `online_first`, `offline_pin`, or `none`.
3. **(today, `elaboration_verified` only)** when the result is `online_first`, an upgrade re-points
   it to the Idea's existing `DaemonSession.originConnectionUuid` if that origin is online.

Step 3 is the fix that routes the "Verify Elaborate" proposal-writing wake to the cwd where the
Idea's conversation already lives. It is gated on `trigger === "elaboration_verified"`
(`notification-turn.ts:625`), so `proposal_approved` / `proposal_rejected` (mapped to
`task_assigned`) never reach it and fall to `online_first` = arbitrary cwd.

This change broadens the gate so step 3 applies to the **autonomous idea-anchored trigger
family**, not just one trigger.

## Architecture

### The trigger taxonomy and which triggers get the upgrade

`DaemonSessionTurn.trigger` is a 6-value enum (`notification-turn.ts:92-106`):
`task_assigned | mentioned | elaboration | elaboration_verified | resume | human_instruction`.

The action→trigger map (`NOTIFICATION_ACTION_TO_TURN_TRIGGER`, `notification-turn.ts:111-131`)
collapses every wake action into one of these. The relevant collapses:

| Notification action | Turn trigger | Idea-anchored? | Gets upgrade? |
|---|---|---|---|
| `proposal_approved`, `proposal_rejected` | `task_assigned` | yes (via `inputUuids[0]`) | **YES (new)** |
| `idea_claimed` | `task_assigned` | yes | **YES (new)** |
| `task_assigned`, `task_verified`, `task_reopened` | `task_assigned` | yes (via task→proposal→idea) | **YES (new)** |
| `elaboration_requested`, `elaboration_answered` | `elaboration` | yes | **YES (new)** |
| `elaboration_verified` | `elaboration_verified` | yes | yes (unchanged) |
| `mentioned` | `mentioned` | maybe | **NO (excluded)** |
| `human_instruction` | `human_instruction` | maybe | **NO (excluded)** |

The upgrade set is therefore the **autonomous idea-anchored triggers**:
`{ task_assigned, elaboration, elaboration_verified }`.

### Why `mentioned` and `human_instruction` are excluded

The owner's Q1=a answer is "generalize regardless of trigger, eliminate the special case." Read
faithfully, that means *eliminate the per-trigger special-casing among the autonomous wakes* — it
does not mean overriding the two triggers that already resolve their own explicit target:

- **`mentioned`**: A pinned mention resolves to `directed` or `offline_pin` in
  `selectOriginConnection`, so it never reaches the `online_first` branch the upgrade guards. An
  **un-pinned** mention is contractually a broadcast → online-first wake — the existing
  `daemon-cwd-instance-addressing` spec has an explicit scenario "An un-pinned mention still wakes
  the online-first daemon" with "no target is stamped." Silently re-pointing an un-pinned mention
  to some idea session origin would violate that contract. So `mentioned` is excluded on both
  branches.

- **`human_instruction`**: `daemon-instruction.service` already resolves the precise target session
  and emits its own origin-pinned `deliver_turn` ping (`deliverTurnPing`). The chokepoint creating
  a second, possibly-different directed target would double-deliver or mis-route. It is excluded.

Excluding these two is not a new special case — it is the same boundary the directed-delivery
design already draws: triggers that carry their own explicit target are never subject to the
heuristic session-origin upgrade.

### Priority is preserved by construction (owner Q5=a)

The upgrade still runs **only inside the `selection.kind === "online_first"` branch**. Any
higher-priority outcome short-circuits before it:

- A **hard mention pin** → `directed` (online) or `offline_pin` (offline). Never `online_first`.
- A **soft assignment / idea-instance pin** that is online → `directed`. Never `online_first`.
- A soft pin whose instance is **offline** → degrades to `online_first` (R2 graceful un-pin) — and
  then the session-origin upgrade legitimately applies, which is the desired "the pinned instance
  is gone, so fall to where the conversation lives" behavior, identical to how
  `elaboration_verified` already behaves for a degraded soft pin.

So the upgrade can only ever replace an *otherwise-arbitrary* `online_first` choice with a
*specific* idea-anchored origin. It never overrides a pin. This is exactly the invariant the
existing `elaboration_verified` upgrade holds; we are widening *which triggers* reach it, not
changing *when within the selection* it fires.

## Implementation

### 1. Rename the helper

`resolveElaborationVerifiedTarget` → `resolveIdeaSessionOriginTarget`
(`notification-turn.ts:477`). Body unchanged: given `directIdeaUuid`, find the idea-anchored
`DaemonSession` (`sessionId === directIdeaUuid`), and return its `originConnectionUuid` connection
iff it is online; else null. Update its doc comment to drop the "elaboration_verified"-specific
language and describe it as the generic idea-session-origin resolver.

### 2. Define the upgrade-eligible trigger set

A module-level constant adjacent to the trigger map:

```ts
// The autonomous, idea-anchored triggers eligible for the idea-session-origin upgrade.
// `mentioned` (carries its own pin / un-pinned-broadcast contract) and `human_instruction`
// (resolves its own target + ping in daemon-instruction.service) are deliberately excluded.
const IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS = new Set<TurnTrigger>([
  "task_assigned",
  "elaboration",
  "elaboration_verified",
]);
```

### 3. Broaden the gate

At `notification-turn.ts:625`, replace:

```ts
if (trigger === "elaboration_verified" && selection.kind === "online_first") {
  const ideaTarget = await resolveElaborationVerifiedTarget(...);
  if (ideaTarget) selection = { kind: "directed", connection: ideaTarget };
}
```

with:

```ts
if (
  IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS.has(trigger) &&
  selection.kind === "online_first"
) {
  const ideaTarget = await resolveIdeaSessionOriginTarget(
    ctx.companyUuid,
    ctx.recipientUuid,
    directIdeaUuid,
    connections,
  );
  if (ideaTarget) selection = { kind: "directed", connection: ideaTarget };
}
```

`directIdeaUuid` is already resolved at `notification-turn.ts:608-615` for any lineage-walkable
entity, and `resolveIdeaSessionOriginTarget` already returns null when it is null — so a
non-idea-anchored `task_assigned` (e.g. a standalone task with no idea lineage) naturally
no-ops and stays `online_first`. No extra guard needed.

## Module Contracts

- **Selection state machine unchanged.** `OriginSelection` kinds (`directed` / `online_first` /
  `offline_pin` / `none`) and their downstream meaning are untouched. The change only adds more
  transitions from `online_first → directed` via the existing upgrade path.
- **Directed-delivery transport unchanged.** When the upgrade promotes to `directed`, the existing
  step-7 logic emits the `deliver_turn` ping and surfaces `targetConnectionUuid`, so daemon-side
  broadcast suppression already works for the newly-directed proposal/idea wakes — no daemon
  client change.
- **Cross-cwd per-instance session rule unchanged.** Step 5 (`notification-turn.ts:660-686`) only
  forks a per-instance session when the `directed` target differs from the idea's existing session
  origin. For the session-origin upgrade the target **is** that origin, so `existing.originConnectionUuid
  === origin.uuid` and no fork happens — the wake lands on the canonical idea session. (Verified:
  the upgrade sets `connection` to the very origin connection it looked up.)

## Risks & Mitigations

- **Risk: an autonomous `task_assigned` for a task whose idea session lives on a different,
  now-online cwd than where the task "should" run.** Mitigation: this is the intended behavior —
  the idea's conversation is the authoritative place for idea-anchored work; a task with its own
  instance override takes the higher-priority soft pin and never reaches the upgrade.
- **Risk: regressing the un-pinned mention broadcast contract.** Mitigation: `mentioned` is
  explicitly excluded from `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`; a dedicated test asserts an
  un-pinned mention with a resolvable idea session still stamps no target.
- **Risk: double-delivery of `human_instruction`.** Mitigation: `human_instruction` is excluded;
  its own `deliverTurnPing` remains the sole delivery.
- **Risk: the idea session origin is online but stale (transcript moved).** Out of scope — this is
  the same assumption the existing `elaboration_verified` upgrade already makes; the origin is the
  recorded transcript owner and `claude --resume` correctness is governed by the existing
  origin-pinning requirement.

## Test Plan

Extend `src/services/__tests__/notification-turn.test.ts`:

1. `proposal_approved` (entity `proposal` whose `inputUuids[0]` → idea with an online session
   origin, agent un-pinned) → selection becomes `directed` on that origin; `deliver_turn` fired.
2. Same for `proposal_rejected`.
3. `idea_claimed` (entity `idea` with an online session origin) → `directed` on the origin.
4. **Priority:** idea is instance-pinned to an online instance → selection is `directed` on the
   **pin**, not the session origin (upgrade skipped).
5. **No session:** idea has no `DaemonSession` → stays `online_first`, no target.
6. **Offline origin:** session origin connection offline → stays `online_first`, no target.
7. **Exclusion:** un-pinned `mentioned` with a resolvable idea session → stays `online_first`, no
   target stamped.
8. **Exclusion:** `human_instruction` is not upgraded by the chokepoint (its target comes from
   `daemon-instruction.service`).
9. **Plain idea-anchored `task_assigned`** (entity resolves to an idea with an online session
   origin) → `directed` on that origin, confirming the family is not proposal-only.
10. **No-lineage no-op:** a `task_assigned` whose entity has NO idea lineage (`directIdeaUuid ===
    null`) → stays `online_first`, no target — `resolveIdeaSessionOriginTarget`'s null-guard is
    exercised so the widened gate cannot mis-fire for non-idea-anchored work.
