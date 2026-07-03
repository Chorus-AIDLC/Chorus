# Design: Generic stage-advance wake framework + Start Development button

## Overview

This change generalizes the "human clicks one button → the idea's daemon agent wakes and drives the next AI-DLC stage" pattern that `elaboration_verified` (change `add-elaboration-verify-wake`, PR #335/#381 lineage) proved out, and adds the second concrete stage event: `start_development` (approve → develop).

The framework is a **server-side convention plus one shared helper**, not a new runtime subsystem. The existing pipeline — activity → notification-listener → notification chokepoint (`createTurnAndResolveTarget`) → session-origin-pinned wake → daemon prompt — already handles everything downstream of the activity emit generically. What is duplicated today (and what a third stage button would duplicate again) is the **upstream** half: the human-only server action, the company-scoped idea lookup, the per-stage precondition check, the offline policy, and the activity emit. That is what the framework extracts.

Deliberately avoided:

- No new Prisma model or migration (`Notification.action` and `DaemonSessionTurn.trigger` are free-form strings).
- No new Idea stored status and **no state transition at all** for `start_development` — the derived status already renders the execute stage; the event is wake-only.
- No new MCP tool or permission bit — stage-advance is a human affordance (server action), agents keep their existing paths.
- No offline queue for `start_development` (Q5 = validate-online-or-error), unlike `elaboration_verified` which keeps its queue+backfill policy. The framework makes the offline policy a per-stage strategy instead of forcing one behavior.

## Key decisions (from elaboration round 1)

| # | Decision | Rationale |
|---|----------|-----------|
| Q6 | **Generic stage-advance framework; migrate `elaboration_verified` onto it.** | Two stage buttons already exist/are needed; a third (e.g. "verify all tasks") is foreseeable. One code path = one place for actor gating, preconditions, wake wiring. Migration is behavior-preserving. |
| Q1 | **Woken agent executes ALL remaining tasks** in dependency order, one wake for the whole execute stage. | Matches the yolo develop segment; the human's click means "go build it", not "advance one notch". |
| Q2 | **Session-origin pinning, strictly.** `start_development` joins `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS` with its own trigger value. | The 0.13.0 random-cwd bug came from `proposal_approved` collapsing into `task_assigned` and missing the upgrade set. A dedicated trigger makes the pinning explicit instead of incidental. |
| Q3 | **Unfinished = status not in (`done`, `closed`).** | `open`, `assigned`, `in_progress`, `to_verify` all count — the button stays until the stage is actually complete. Consistent with `computeDerivedStatus`'s `allDone` predicate. |
| Q4 | **Panel-only button, same slot as Verify Elaborate; AgentPresence for online state.** | No list-row button. Presence data is already polled shell-wide by `AgentPresenceProvider` ((dashboard)/layout.tsx:515). |
| Q5 | **Optimistic button, server-side online validation, error on offline.** | Wake-only events with no state transition would be confusing to queue — a human clicking "start development" expects development to start now or a clear "agent offline" error. |

## Architecture

### The stage-advance framework

A stage-advance event is described by a static per-stage definition consumed by one shared execution helper (`src/services/stage-advance.service.ts`):

```
StageAdvanceDefinition {
  action:        string                       // activity action, e.g. "elaboration_verified", "start_development"
  precondition:  (ctx) => Promise<void|Error> // per-stage check, throws a typed error with an i18n-able reason
  transition:    (ctx) => Promise<void>       // optional state mutation (elaboration_verified: set elaborated/resolved; start_development: none)
  offlinePolicy: "queue" | "require_online"   // elaboration_verified: "queue"; start_development: "require_online"
}

executeStageAdvance(definition, { companyUuid, ideaUuid, actorUuid, actorType }):
  1. actor gate: actorType must be "user" | "super_admin"   (shared)
  2. idea lookup scoped by companyUuid                       (shared)
  3. definition.precondition(ctx)                            (per-stage)
  4. if offlinePolicy === "require_online":
       resolve assignee agent → daemonConnection isEffectivelyOnline; throw AGENT_OFFLINE if not (shared)
  5. definition.transition(ctx)                              (per-stage, optional)
  6. createActivity({ targetType: "idea", action: definition.action, ... })  (shared)
```

Everything after step 6 is the **existing** pipeline, untouched in shape: `notification-listener` maps `idea:{action}` to a notification action with agent-only recipient resolution; `notification-turn` maps the action to its turn trigger and the session-origin upgrade applies; the daemon's `event-router`/`prompts` render the wake.

**Migration of `verifyElaboration`:** the service function keeps its exported name and signature (callers in `elaboration-actions.ts` unchanged); its body becomes a `executeStageAdvance(ELABORATION_VERIFIED_DEFINITION, …)` call. Preconditions (≥1 round, none `pending_answers`), the state transition (`elaborated`/`resolved`), the activity action string, and the queue-when-offline behavior are all byte-compatible with today. Existing unit tests must pass unmodified (only mock wiring may move).

**Registration surfaces stay explicit.** The framework does NOT auto-register notification/turn mappings — `notification-listener.ts`, `notification-turn.ts`, `daemon-session.service.ts` `TURN_TRIGGERS`, `cli/event-router.mjs`, and `cli/prompts.mjs` each get the new literal, same as every previous trigger. A magic cross-layer registry spanning server TS and daemon MJS is not worth the indirection; the spec's parity scenarios are the drift guard.

### `start_development` — server side

Precondition (Q3 wording, all must hold, checked in one place):

1. Idea exists in caller's company and its assignee is an `agent` or `agent_instance` (resolve `agent_instance` → owning agent, same as `resolveAssigneeRecipient` in notification-listener.ts:412).
2. An **approved** proposal exists whose `inputUuids` contains the idea (same query shape as `getIdeaWithDerivedStatus`, idea.service.ts:1295).
3. That proposal has ≥1 materialized task with `status NOT IN ("done", "closed")`.
4. (offlinePolicy `require_online`) the assignee agent has ≥1 daemon connection with `isEffectivelyOnline` (daemon-connection.service.ts:232 — `status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS`).

Each failed precondition returns a distinct error code so the UI can toast a precise message (`no approved proposal`, `no unfinished tasks`, `assignee is not an agent`, `agent offline`).

No transition step. Activity: `action = "start_development"`, `targetType = "idea"`, value carries `{ proposalUuid, remainingTasks }` for observability.

Server action `startDevelopmentAction(ideaUuid)` sits next to `verifyElaborationAction` (elaboration-actions.ts pattern): `"use server"`, `getAuthContext`, human-only, passes company + actor to the service, `revalidatePath` on success.

### `start_development` — wake wiring

| Layer | Change |
|---|---|
| `notification-listener.ts` | `"idea:start_development": "start_development"` in the action map, deliberately NOT preference-gated (same comment rationale as `elaboration_verified`, :39). Recipient case mirrors `elaboration_verified` (:397-421): resolve idea assignee → agent recipient only; humans never receive it. Message: "{actor} started development for idea "{title}" — claim and execute the remaining tasks". |
| `notification-turn.ts` | `NOTIFICATION_ACTION_TO_TURN_TRIGGER["start_development"] = "start_development"` (own trigger, NOT `task_assigned` — the :129 collapse is the documented anti-pattern). Add `"start_development"` to `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS` (:163) so an `online_first` selection upgrades to the idea's session origin (`resolveIdeaSessionOriginTarget`, :512). |
| `daemon-session.service.ts` | `TURN_TRIGGERS` (:47) gains `"start_development"`. |
| `cli/event-router.mjs` | `ACTION_TO_TURN_TRIGGER` (:19) gains `start_development: "start_development"`; the autonomous re-dispatch trigger list (:286-290) gains `"start_development"` so a directed pending turn found by backfill sweep can be re-dispatched (this covers the race where the agent flaps offline between server validation and delivery — the turn is directed, so only the origin connection picks it up). |
| `cli/prompts.mjs` | `WAKE_ACTIONS` gains `"start_development"`; new prompt case (below). |

Because the server rejects when the agent is offline (Q5), the `offline_pin`/`suppressWake` path should be unreachable for this trigger in the normal flow; if the connection drops in the validation-to-chokepoint window, the chokepoint's existing `offline_pin → suppressWake` handling is the safe fallback (notification persists; no crash). This is accepted residual behavior, not a queue feature.

### `start_development` — daemon prompt (execute-all contract, Q1)

The prompt case in `cli/prompts.mjs` instructs the woken agent:

> [Chorus] Development was started by a human for idea '{title}' (ideaUuid, projectUuid). The idea's proposal is approved and unfinished tasks remain. Claim and execute ALL remaining tasks of that proposal in dependency order: repeatedly pick up unblocked tasks (chorus_get_unblocked_tasks / chorus_claim_task), implement, self-check acceptance criteria, and chorus_submit_for_verify each one, following the develop skill — until no claimable task remains. Do not stop after one task. Tasks in to_verify are awaiting human verification — leave them.

The loop terminates when no task is claimable (`open`/`assigned` with satisfied dependencies). Tasks already `in_progress`/`to_verify` (e.g. held by another session) are not stolen — the develop skill's claim semantics already enforce this atomically (task.service.ts:666).

### UI button — gating and placement (Q4)

New shared predicate `src/lib/start-development.ts`, mirroring `elaboration-verify.ts`:

```
canStartDevelopment({ assignee, proposals, tasks, agentOnline }): boolean
  - assignee?.type is "agent" | "agent_instance"
  - proposals include one with status === "approved" (idea-linked)
  - tasks (of the approved proposal) include one with status !== "done" && !== "closed"
  - agentOnline === true      // from AgentPresence
```

- **Dashboard idea-tracker panel** (`dashboard/panels/idea-detail-panel.tsx`): already lifts `proposals` + `tasks` into state (:165-167) — the predicate is computable from existing data.
- **`/ideas` route panel** (`ideas/idea-detail-panel.tsx`): does not load proposals/tasks today. It adds the same lightweight fetch the dashboard panel uses (approved proposals for the idea + their task statuses), or a small dedicated endpoint returning the derived-status context. Implementation task decides; predicate stays shared.
- **Online state**: `useAgentPresence()` (agent-presence-context.tsx:519) exposes `connections` with per-agent effective status; match on the assignee's `agentUuid` (for `agent_instance`, the owning agent — any online connection qualifies, since the server's session-origin upgrade picks the right cwd). The provider wraps the whole dashboard layout, so both panels can consume it.
- **Button**: header action area, same slot/pattern as Verify Elaborate (ideas panel :629, dashboard panel :917). Visible when assignee is an agent and an approved proposal with unfinished tasks exists; disabled with a tooltip when the agent is offline (presence says offline) — optimistic display still applies since presence lags ≤15s + 90s staleness; the server is authoritative. Error toast on server rejection (distinct message per error code). Success state shows a transient "development started / agent woken" hint.

### Failure modes

| Risk | Mitigation |
|------|------------|
| Presence says online, agent actually gone (≤90s staleness window) | Server re-validates with `isEffectivelyOnline` at click; UI toasts the offline error. Residual: connection drops between validation and delivery → directed pending turn persists, re-dispatched on reconnect by the backfill sweep. |
| Framework migration silently changes `elaboration_verified` behavior | Spec scenario pins behavior-preservation; existing elaboration service/action tests must pass unchanged. |
| Trigger added on server but not daemon (or vice versa) | Parity scenarios enumerate all five registration surfaces; integration checkpoint task exercises the wake end-to-end. |
| Double-click / repeated clicks spawning duplicate wakes | Each click emits one activity → one notification → one turn; the daemon's per-key serialized queue (event-router waker key = direct idea) runs them sequentially, and a second turn on an already-running session is the normal queued-turn case. Acceptable; no dedup needed beyond what exists. |
| Button shown for a proposal whose tasks are all `to_verify` (nothing claimable) | Q3 explicitly includes `to_verify` in "unfinished" — the human may still want the wake (agent can re-check, report, or pick up rejected-back tasks). The prompt tells the agent to leave `to_verify` tasks alone; a wake with nothing claimable ends benignly with a status comment. |

## Implementation order

1. **Framework + migration** — `stage-advance.service.ts`, `verifyElaboration` onto it, behavior-preserving (existing tests green).
2. **`start_development` server path** — precondition service + server action + activity, unit tests for every precondition branch incl. company scoping and offline rejection.
3. **Wake wiring** — listener/turn/TURN_TRIGGERS + daemon `event-router`/`prompts` + daemon tests.
4. **UI button** — shared predicate + both panels + presence gating + i18n + toasts.
5. **Integration checkpoint** — end-to-end: approve proposal → button appears → click → agent session-origin wake with execute-all prompt; offline agent → error.
6. **design.pen + skill docs.**
