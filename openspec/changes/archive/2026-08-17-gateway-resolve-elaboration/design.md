# Design — Gateway resolve/skip of an assigned idea's elaboration

## Context

Elaboration reaches the `resolved` state through three code paths today:

| Path | Entry | Actor gate | Activity emitted | Wakes assignee to write proposal? |
|---|---|---|---|---|
| `resolveElaboration` | `chorus_pm_validate_elaboration` (MCP, `idea:admin`) | **assignee-only** (`isIdeaAssignedToActor`) | `elaboration_resolved` | No (actor == assignee, actor-excluded) |
| `skipElaboration` | `chorus_pm_skip_elaboration` (MCP, `idea:write`) + UI `skipElaborationAction` | **assignee-only** | `elaboration_skipped` (→ collapses to `elaboration_answered`) | No |
| `verifyElaboration` | UI "Verify Elaborate" server action (`user`/`super_admin` only) via `executeStageAdvance(ELABORATION_VERIFIED_STAGE)` | **not** assignee-gated (humans only) | `elaboration_verified` | **Yes** — recipient resolves to the assignee agent |

The desired MCP gateway-resolve is the **agent-actor analogue of `verifyElaboration`**: a non-assignee (here an agent, not a human) resolves and the assignee agent is woken to write the proposal.

## Decision (from elaboration Round 1)

- **Q1 — implementation shape: relax the existing tools** (not a new tool). Branch inside `resolveElaboration` / `skipElaboration`.
- **Q2 — permission scope: any `idea:admin` agent** (parity with the UI, which lets any privileged human verify any idea — no orchestrator/ownership scoping).
- **Q3 — include skip**: apply the same relaxation + wake to `chorus_pm_skip_elaboration`.
- **Q4 — offline: queue** the wake (resolution/skip always succeeds; wake recovered on reconnect).

## Why branch inside the elaboration service, not route through `executeStageAdvance`

`executeStageAdvance` (the machinery behind `verifyElaboration`) hard-rejects any caller whose auth type is not `user`/`super_admin` (`stage-advance.service.ts:140`), and the `stage-advance-wake` spec encodes this as an invariant ("An agent caller is rejected from any stage-advance action"). An `idea:admin` **agent** gateway calls over MCP with `actorType: "agent"`, which that path must reject. Rather than widen the human-only stage-advance gate (which would weaken a deliberate invariant and touch a broad surface), we keep the gateway logic in the elaboration service and **emit the same `elaboration_verified` activity directly**. The wake is driven by the activity's `action` string, so emitting it from the elaboration service triggers the identical notification → turn → daemon-prompt pipeline that the human path uses.

## Contracts

### Service signature change

Both functions gain an `actorIsIdeaAdmin: boolean` field (threaded from the MCP handler); no other signature change.

```ts
resolveElaboration({ companyUuid, ideaUuid, actorUuid, actorType, actorIsIdeaAdmin })
skipElaboration({ companyUuid, ideaUuid, actorUuid, actorType, reason, actorIsIdeaAdmin })
```

### Actor gate (both functions)

```ts
const isAssignee = await isIdeaAssignedToActor(companyUuid, idea, actorUuid);
if (!isAssignee && !actorIsIdeaAdmin) {
  throw new Error("Only the assigned agent or an idea:admin gateway can resolve elaboration"); // / "skip elaboration"
}
```

- For `resolveElaboration` (tool is `idea:admin`-gated) `actorIsIdeaAdmin` is effectively always true at the MCP boundary; the in-service check is belt-and-suspenders and makes the branch testable.
- For `skipElaboration` (tool stays `idea:write`-gated) the check is **load-bearing**: an assignee with only `idea:write` may skip its own idea; a non-assignee must hold `idea:admin`.

### Wake branch (both functions)

```ts
if (isAssignee) {
  // unchanged: resolveElaboration → "elaboration_resolved"; skipElaboration → "elaboration_skipped"
  await activityService.createActivity({ ..., action: <existing>, value: <existing> });
} else {
  // non-assignee idea:admin gateway → wake the assignee to write the proposal
  await activityService.createActivity({
    ..., action: "elaboration_verified",
    value: { ...(reason ? { reason, viaSkip: true } : {}) },
  });
}
```

The state transition is unchanged in every case: `status → elaborated`, `elaborationStatus → resolved` (skip additionally sets `elaborationDepth: "minimal"`). Preconditions are unchanged: resolve requires ≥1 round with none `pending_answers`; skip requires `status === "elaborating"` and no round.

### Why the gateway wakes the *assignee*, not itself

`elaboration_verified` recipient resolution (`notification-listener.ts`) returns only the Idea's assigned agent (resolving `agent_instance` → owning agent), excluding humans, then applies actor-exclusion. When the gateway is a *different* actor from the assignee, the assignee survives exclusion and is woken; when the actor *is* the assignee (the `isAssignee` branch never emits `elaboration_verified` anyway) nothing is woken. This is the same reason the assignee self-resolve path emits `elaboration_resolved` and wakes no one.

### MCP handler change (`src/mcp/tools/pm.ts`)

Both handlers pass `actorIsIdeaAdmin` computed from the authenticated agent's effective permissions (`idea:admin`). Tool descriptions gain a sentence describing the gateway path; the `chorus_pm_validate_elaboration` description **keeps** its existing "human confirmation required (except YOLO)" clause so the `elaboration-resolution` "Human confirmation" requirement's description scenario still holds.

## Risks & mitigations

- **Activity-stream semantics for gateway skip.** A gateway skip emits `elaboration_verified` (not `elaboration_skipped`), so the stream reads "verified" rather than "skipped". Mitigation: carry `{ reason, viaSkip: true }` in the activity `value` for the audit trail. Acceptable — the user-visible outcome (assignee woken to write proposal) is the intent.
- **Human UI skip path (`skipElaborationAction`) is unchanged.** `actorIsIdeaAdmin` is an **optional** parameter defaulting to `false`; the UI server action does not pass it, so the human skip stays assignee-only exactly as before (a non-assignee human is still rejected — no regression, and no new required param to thread through the UI). Giving privileged humans a UI gateway-skip (parity with Verify-Elaborate on the resolve side) is intentionally **out of scope** here — humans already have the Verify-Elaborate gateway for resolve; a UI skip-as-gateway button would be a separate follow-up. The service test file's assignee-gate assertions that referenced the old error string are updated to the new "assignee or idea:admin gateway" message.
- **No new action literal.** By reusing `elaboration_verified` we avoid touching the five wake-registration layers (notification-listener / notification-turn / daemon-session / cli prompts / event-router). This is the deliberately minimal blast radius.

## Test plan

Unit (`src/services/__tests__/elaboration.service.test.ts`):
- resolve: assignee → `elaboration_resolved`, no wake; non-assignee + `idea:admin` → `elaboration_verified`; non-assignee without admin → rejected; existing "requires all rounds answered / ≥1 round" preserved.
- skip: assignee → `elaboration_skipped`; non-assignee + `idea:admin` → `elaboration_verified` with `reason`; non-assignee without admin → rejected; existing "requires elaborating status" preserved; instance-ownership cases updated.

`npx tsc --noEmit` and `pnpm lint` clean. Permission/server MCP tests are unaffected (permission bits unchanged).

Out of scope (human follow-up): live daemon E2E where a gateway agent resolves an idea assigned to a *different* online agent and that agent's daemon wakes to write the proposal.
