# Design: Human "Verify Elaborate" → daemon writes the proposal

## Overview

This change adds the missing human-side "elaboration is confirmed, move forward" action and wires it to the existing daemon-session wake machinery so the assigned PM daemon agent writes the proposal. It is deliberately thin: it reuses the existing elaboration resolution state transition, the existing notification → turn → daemon-wake pipeline, and the existing proposal-authoring flow. The only genuinely new pieces are (a) a **user-callable** resolution entry point (because the existing one is agent-only) and (b) a **new wake action/trigger** (`elaboration_verified`) so the daemon can tell "go write the proposal" apart from "go answer questions."

The design intentionally avoids:

- a new Idea stored status (reuses the 3-state model + derived `planning`),
- a new Prisma model or migration (`DaemonSessionTurn.trigger` is a free-form string; Idea status is unchanged),
- a new MCP tool (the human path is a Next.js server action, not an agent tool),
- a new permission bit (human authorization is company-scoped, matching existing human server actions),
- changing how proposals are authored (the woken agent uses the existing proposal flow).

## Key decisions (from elaboration)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Human resolves, then wakes** (not wake-only). | Owner choice. The click resolves the elaboration synchronously via a new user-callable path, *then* wakes the agent only to write the proposal. |
| Q2 | **New dedicated trigger** `elaboration_verified`. | The existing `elaboration` wake means "answer the questions." "Human verified → write proposal" is semantically different; conflating them would force the daemon to reverse-engineer intent from idea state. |
| Q3 | **Queue + backfill** when the agent is offline. | Resolution is synchronous and never blocked by daemon liveness; the wake recovers through the existing reconnect notification-backfill. |
| Q4 | **One final verify, all rounds answered.** | Single idea-level button, enabled only when no round is in `pending_answers` — matches the existing resolve precondition. |
| Q5 | **Replace idea-panel button; keep the generic proposals-list entry.** | The idea-panel "Create Proposal" is the dead idea→proposal handoff; the proposals-list entry is a separate from-scratch authoring path, out of scope. |
| Q6 | **Reuse derived `planning`.** | No new stored state; `elaborated` + no proposal already derives `planning`. |
| R2 | **Skip / agent-self-validated ideas are out of scope.** | Owner choice. This change handles only the human-verify main line; other paths to `elaborated`-without-proposal are deferred. |

## Architecture

### End-to-end flow

```
Human answers all elaboration rounds (existing UI)
        │
        ▼
[Verify Elaborate] button   ──(enabled iff: status=elaborating, ≥1 round, every round answered, not resolved)
        │  server action: verifyElaborationAction(ideaUuid)
        ▼
elaborationService.verifyElaboration({ companyUuid, ideaUuid, actorUuid, actorType: "user" })
        │  • precondition: ≥1 round, none pending_answers
        │  • idea.status → elaborated ; elaborationStatus → resolved
        │  • activity: action = "elaboration_verified"
        ▼
notification-listener:  idea:elaboration_verified  →  notification(action="elaboration_verified", recipient = idea's assigned AGENT)
        │
        ▼
notification chokepoint (notification.service.createReturningTurn)
        │  maybeCreateTurnForWakeNotification:
        │    NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_verified"] = "elaboration_verified"
        │    • online origin connection?  →  create pending turn + deliver_turn ping
        │    • offline?                   →  no turn now; notification persists (backfill recovers)
        ▼
Daemon client (cli/event-router → waker → prompts.mjs)
        │  WAKE_ACTIONS includes "elaboration_verified"
        │  buildPrompt → "Idea is elaborated. Write the proposal via the proposal flow."
        ▼
Spawned Claude (PM agent)  →  chorus_pm_create_proposal + proposal skill  →  proposal drafted
        │
        ▼
Idea derived status = planning (elaborated, no proposal yet) → building once tasks exist
```

### Why a new user-callable resolution path (not the existing tool)

`resolveElaboration` (`elaboration.service.ts:275`) guards `idea.assigneeUuid !== actorUuid` and is surfaced only as `chorus_pm_validate_elaboration`, gated on `idea:admin`. The Idea's assignee is the **daemon agent**, and a human user holds neither the assignee identity nor agent permission bits. Chorus has **no project-level user roles** — human authorization in server actions is company-scoped + actor-type-gated (see `criteria-actions.ts`'s `auth.type === "user"` pattern). Therefore the human verify must be its own path:

- **Server action** `verifyElaborationAction(ideaUuid)` — rejects unless `auth.type === "user"` (or `super_admin`); passes `auth.companyUuid` + `auth.actorUuid`.
- **Service** `verifyElaboration({ companyUuid, ideaUuid, actorUuid, actorType })` — scopes the Idea by `companyUuid`, enforces the **same** structural precondition as resolve (≥1 round, no `pending_answers`), performs the **same** state transition (`elaborated` / `resolved`), but does **not** require the actor to be the assignee. It logs activity `action = "elaboration_verified"` (distinct from the agent path's `elaboration_resolved`) so the wake can be distinguished downstream.

The existing agent-only tool and its `elaboration_resolved` activity are untouched.

### The `elaboration_verified` wake — server side

The daemon-session pipeline (PRs #332–#334) keys daemon prompts off the **notification action** (`cli/prompts.mjs` `WAKE_ACTIONS`), while the server collapses actions into `TURN_TRIGGERS` for the turn row. Adding `elaboration_verified` therefore touches both layers:

1. `notification-listener.ts` — `resolveNotificationType` maps `idea:elaboration_verified` → notification type `elaboration_verified`; recipient resolution sends it to the **Idea's assigned agent** (the daemon), not a human. (Distinct from `elaboration_requested`/`elaboration_answered`.)
2. `notification-turn.ts` — `NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_verified"] = "elaboration_verified"`.
3. `daemon-session.service.ts` — `TURN_TRIGGERS` gains `"elaboration_verified"`.

Everything else on the server (chokepoint turn creation, origin-only `deliver_turn`, offline persistence, reconnect-backfill) is reused unchanged — this is exactly the symmetry the chokepoint was built for.

### The `elaboration_verified` wake — daemon side

`cli/prompts.mjs`:

- Add `"elaboration_verified"` to `WAKE_ACTIONS` so the event router treats it as a wake.
- Add a prompt case: roughly *"[Chorus] Elaboration for idea '{title}' was verified by a human. The idea is now elaborated. Proceed to write the proposal: use chorus_get_idea + chorus_get_elaboration for context, then create the proposal via the proposal flow (chorus_pm_create_proposal …)."* The agent then runs the normal proposal skill in that woken turn.

The session anchor / resume contract is unchanged — the wake is keyed to the Idea's session like every other idea-rooted wake, so the woken turn is the same conversation that ran elaboration.

### Button gating & placement

A single idea-level "Verify Elaborate" button. Enabled iff **all** hold:

- `idea.status === "elaborating"`,
- `idea.elaborationStatus !== "resolved"`,
- the Idea has ≥1 elaboration round,
- no round is in `pending_answers` (every required question answered).

When disabled-because-unanswered, the surrounding copy directs the human to finish answering. After a successful click, the button is replaced by the derived `planning` status indicator ("agent is writing the proposal"). If the assigned agent is offline at click time, the action still succeeds and the UI shows an "agent will pick this up when it reconnects" hint.

Placement (per Q5 + R2 button-location = both panels):

- `/ideas` route `idea-detail-panel.tsx` — **replace** the existing "Create Proposal" button (`:582`).
- Dashboard `dashboard/panels/idea-detail-panel.tsx` footer — **add** the button (today only Assign/Delete live there).

The proposals-list `proposals/page.tsx` "Create Proposal" stays.

### Data the button needs

The elaboration data (rounds + per-round status) is already loaded into the idea-detail panels (it powers `elaboration-panel.tsx`). The "all rounds answered" predicate is computed client-side from that data; no new fetch is required. Server-side, `verifyElaboration` re-checks the precondition authoritatively (never trust the client's enable state).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Client enables the button when a round is actually still pending (stale data). | Service re-validates "no `pending_answers`" authoritatively and rejects; the button enable state is a UX hint only. |
| A human verifies but the assigned agent never comes online → proposal never written. | Accepted per Q3/Q5 (no manual fallback on the idea panel). Resolution still succeeds; the wake waits in backfill. The generic proposals-list entry remains as a last resort outside this idea's scope. |
| Two surfaces (both panels) drift in gating logic. | Extract the enable predicate + verify call into one shared helper/hook used by both panels. |
| Daemon `WAKE_ACTIONS` and server action enum diverge (new trigger added one place, not the other). | Spec scenarios assert both the server mapping and the daemon `prompts.mjs` case; the verify task's AC lists all touch-points. |
| Recipient mis-targeting (human gets the wake notification instead of the agent). | `elaboration_verified` notification recipient is the Idea's **assigned agent**; spec scenario asserts it does not surface in a human's bell. |
| Confusing `elaboration_verified` with `elaboration_answered` on the daemon. | Distinct action string + distinct prompt case; daemon prompt explicitly says "write the proposal," not "answer questions." |

## Implementation order

1. **Backend resolution path** — `verifyElaboration` service + `verifyElaborationAction` server action + `elaboration_verified` activity. (Unblocks everything; independently testable via the action.)
2. **Wake wiring** — notification-listener mapping + recipient, `notification-turn` trigger map, `TURN_TRIGGERS` value. (Depends on the activity action existing.)
3. **Daemon prompt** — `cli/prompts.mjs` `WAKE_ACTIONS` + case. (Depends on the trigger/action name being fixed.)
4. **Frontend button** — shared enable predicate + both panels + i18n + post-verify/offline states. (Depends on the server action.)
5. **Integration checkpoint** — end-to-end: answer rounds → click verify → idea elaborated → agent woken with write-proposal prompt (or queued when offline). (Depends on 1–4.)
6. **design.pen + skill-doc note.**
