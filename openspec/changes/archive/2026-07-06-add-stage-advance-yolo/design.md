# Design: Yolo stage-advance button + wake event

## Overview

`yolo_requested` is the third human stage-advance event, built on the same generic framework as `elaboration_verified` and `start_development`. This design reuses that framework end-to-end and enumerates the concrete edit at every registration surface, so the implementation is a mechanical clone-and-adapt with two intentional deviations from `start_development`:

1. **Render gating is stage-agnostic** — the button shows at *any* incomplete stage, not only when an approved proposal + unfinished tasks exist.
2. **The wake prompt points at the yolo skill** (full AI-DLC pipeline, self-selecting the entry phase) rather than only the develop loop.

## Architecture

Data flow (identical topology to `start_development`):

```
Yolo button (both panels, shared predicate)
      │ click → confirm dialog → server action
      ▼
yoloRequestedAction (server action, human-only)
      ▼
requestYolo() → executeStageAdvance(YOLO_REQUESTED_STAGE)
      │  actor gate → company-scoped idea lookup → precondition
      │  → offline policy (require_online) → NO transition → emit activity
      ▼
Activity{ action: "yolo_requested", targetType: "idea" }  ──emitChange──►
      ▼
notification-listener  (idea:yolo_requested → "yolo_requested";
                        recipient = idea's assigned agent ONLY; message text)
      ▼
notification-turn      (action→trigger "yolo_requested";
                        in IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS → session-origin pin)
      ▼
daemon TURN_TRIGGERS   (trigger enum member "yolo_requested")
      ▼
cli/event-router.mjs   (ACTION_TO_TURN_TRIGGER mirror; directed re-dispatch OR-chain)
      ▼
cli/prompts.mjs        (WAKE_ACTIONS; buildPromptBody case → yolo prompt)
      ▼
headless `claude -p`   drives the idea via the yolo skill
```

## Module Contracts

### Shared render predicate — `src/lib/yolo-request.ts` (new, mirrors `src/lib/start-development.ts`)

- `assigneeOwningAgentUuid(assignee)` — reuse the identical helper shape (a plain `agent` is itself; an `agent_instance` resolves to `instance.agentUuid`). Both panels + the button import from here so the two surfaces cannot drift (the spec's "one shared predicate" scenario).
- `yoloPreconditionsMet({ assignee, proposals, tasks })` — RENDERED iff the assignee is an agent/agent_instance **and** the idea is not already done. "Done" is computed from the same primitives `start_development` uses: an idea counts as done ONLY when an approved Proposal exists AND every one of its materialized tasks is `done`/`closed`. At every earlier stage (no approved proposal yet, or unfinished tasks remain) the idea is NOT done, so the button shows — this is exactly the "any incomplete stage" behavior of Q1. This is the deliberate deviation from `start_development`, whose predicate is the *stricter* "approved proposal AND ≥1 unfinished task"; Yolo relaxes it to "not fully done".
- `canRequestYolo({ assignee, proposals, tasks, agentOnline })` — `yoloPreconditionsMet && agentOnline`.

> **Contract note (this is the fix for review round 1's BLOCKER):** the predicate takes `proposals: {status}[]` and `tasks: {status}[]` — the SAME primitives both panels already load and pass to `<StartDevelopmentButton>` (dashboard panel: `proposals`/`tasks`; `/ideas` route panel: `sdProposals`/`sdTasks`, fetched by its existing `reloadStartDevData` loader at ~L184–208). It does NOT depend on `idea.derivedStatus`, because the `/ideas` panel's local `Idea` type (L47–64) has no `derivedStatus` field and no "done" status vocabulary — reading it there would be a tsc error. Basing the predicate on the shared `proposals`/`tasks` primitives means zero new data plumbing and no panel-type widening: both panels feed the Yolo button the exact arrays they already feed Start Development.

### Server action — `.../ideas/[ideaUuid]/stage-advance-actions.ts` (extend, or a sibling file)

- `yoloRequestedAction(ideaUuid): Promise<{ success, errorCode? }>` — clone `startDevelopmentAction`: `getServerAuthContext`, human-only gate (`user | super_admin`), call `requestYolo(...)`, `revalidatePath` both idea routes, map `StageAdvanceError` → a `YoloRequestedErrorCode` union.
- Error-code union: `unauthorized | not_human | idea_not_found | assignee_not_agent | agent_offline | unknown`. Note there is NO `no_approved_proposal` / `no_unfinished_tasks` sub-code — the Yolo precondition does not check proposal/task state, so those failure modes do not exist for this event.

### Service — `src/services/yolo-request.service.ts` (new, mirrors `start-development.service.ts`)

- `YOLO_REQUESTED_STAGE: StageAdvanceDefinition`:
  - `action: "yolo_requested"`
  - `precondition`: assert `idea.assigneeType` is `agent` or `agent_instance`; else throw `StageAdvanceError("ASSIGNEE_NOT_AGENT", …)`. Return a small activity payload (e.g. `{}` or best-effort context) — the wake does not depend on it. No proposal/task lookup.
  - no `transition` (wake-only, like `start_development`).
  - `offlinePolicy: "require_online"` — inherited directly from `start_development`: a Yolo click expects the agent to wake now or return a clear agent-offline error, never a silent queue.
- `requestYolo({ companyUuid, ideaUuid, actorUuid, actorType })` wrapper → `executeStageAdvance(YOLO_REQUESTED_STAGE, …)`.

### Wake registration surfaces (each adds the `yolo_requested` literal alongside `start_development`)

| File | Edit |
|---|---|
| `src/services/notification-listener.ts` | `resolveNotificationType` map: `"idea:yolo_requested": "yolo_requested"`. `resolveRecipients`: add `case "yolo_requested":` to the existing `elaboration_verified`/`start_development` agent-only block (recipient = idea's assigned agent resolved to owning agent; `[]` for a human/absent assignee). `buildMessage`: add a `yolo_requested` case. Do NOT add to `PREF_FIELD_MAP` (agent wake is never preference-gated). |
| `src/services/notification-turn.ts` | `NOTIFICATION_ACTION_TO_TURN_TRIGGER`: `yolo_requested: "yolo_requested"`. Add `"yolo_requested"` to `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`. |
| `src/services/daemon-session.service.ts` | Add `"yolo_requested"` to the `TURN_TRIGGERS` const array (the `TurnTrigger` type is derived from it). |
| `cli/event-router.mjs` | `ACTION_TO_TURN_TRIGGER` mirror: `yolo_requested: "yolo_requested"`. Add `pending.trigger === "yolo_requested"` to the directed re-dispatch OR-chain (so a directed Yolo turn takes the `deliver_turn` path like the other session-pinned wakes). |
| `cli/prompts.mjs` | Add `"yolo_requested"` to `WAKE_ACTIONS`. Add a `case "yolo_requested":` in `buildPromptBody` returning the yolo prompt (below). It rides the shared `HEADLESS_PREAMBLE` via `buildPrompt` automatically. |
| `prisma/schema.prisma` | Refresh the stale inline comment on the `trigger` column to list the current set (`… | start_development | yolo_requested | human_instruction`). Comment-only; no migration. |

### Wake prompt (`cli/prompts.mjs` `buildPromptBody` `case "yolo_requested"`)

The prompt must:
- name the idea + ideaUuid + projectUuid (same interpolation shape as the other cases),
- state a human requested a full-auto YOLO run of this idea,
- instruct the agent to drive the idea to done following the **yolo skill** (`/yolo` full AI-DLC pipeline), self-selecting the entry phase from the idea's current state (elaboration not resolved → self-elaborate then proposal; proposal approved with open tasks → execute; etc.),
- honor the "Yolo never merges" rule: complete through done + completion report, but do NOT merge or push a PR without explicit human approval,
- append `mentionGuidance(n, "idea")`.

It must NOT hard-code a single stage (that's the `start_development` mistake for this event) and must NOT re-embed the headless preamble (buildPrompt prepends it).

### UI — Yolo button component `src/components/yolo-button.tsx` (new, mirrors `start-development-button.tsx`)

- Props: `ideaUuid`, `assignee`, `proposals`, `tasks`, optional `onStarted` — the SAME prop shape as `StartDevelopmentButton` so both panels wire it identically.
- Uses `useAgentPresenceOptional()` for the online flag; computes `yoloPreconditionsMet` / `canRequestYolo` from the shared predicate.
- Renders inside an `AlertDialog` (shadcn) — the trigger is the Yolo button; confirming runs `yoloRequestedAction`. Copy: title/description explain Yolo drives the whole idea automatically (both locales).
- Presence: when preconditions hold but the agent is offline, the confirm button is disabled with the offline hint (same optimistic-display contract as Start Development).
- On success: transient "started" hint + success toast + `onStarted?.()`. On failure: `toast.error` keyed by the error code.
- Rendered in BOTH panels in the same header action slot as Start Development, fed the same arrays that panel already passes to `<StartDevelopmentButton>`:
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` (~L955, alongside `<StartDevelopmentButton>`) — pass `proposals={proposals}` `tasks={tasks}`, and
  - `src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx` (~L706) — pass `proposals={sdProposals}` `tasks={sdTasks}` (the arrays its existing `reloadStartDevData` loader already populates).

### Teaching-hint removal

- Delete the `elaboration.elaborationRequiredHint` render block in both panels (dashboard panel `showHelpText` at ~L552/L964; `/ideas` panel inline condition at ~L715). Remove the now-dead `showHelpText` local if nothing else uses it.
- Remove `elaboration.elaborationRequiredHint` from `messages/en.json` and `messages/zh.json`.
- Keep `elaboration.verifiedQueuedHint`, `startDevelopment.startedHint`, `startDevelopment.offlineHint` (status feedback, not teaching).

### i18n — new `yolo` block in both locales

`button`, `confirmTitle`, `confirmDescription`, `confirmCta`, `cancel`(reuse `common.cancel`), `starting`, `startedHint`, `offlineHint`, `errorAgentOffline`, `errorAssigneeNotAgent`, `errorGeneric`. English + Chinese.

## Risks & Mitigations

- **`/ideas` panel has no `derivedStatus` (review round-1 BLOCKER).** Resolved by basing the shared predicate on `proposals`/`tasks` primitives instead of `derivedStatus` (see the shared-predicate contract note above) — both panels already thread those exact arrays to `StartDevelopmentButton`, so no panel-type widening and no new fetch is needed.
- **Two overlapping buttons (Yolo + Start Development) on a building idea.** Intentional per Q1. Mitigation: distinct labels/icons and confirm copy; each still routes to its own event. Documented in the proposal so reviewers don't flag it as a bug.
- **Woken agent lacks admin permissions the yolo skill needs.** The yolo skill already front-loads a permission check and the headless preamble routes the "missing permission" decision to a Chorus comment + end-turn. The wake prompt does not need to duplicate that; it just points at the skill.
- **Parity drift between server and daemon literal sets.** Mitigation: a drift-guard integration test (clone of the `elaboration_verified` one) asserts `yolo_requested` is present in the activity action, `NOTIFICATION_ACTION_TO_TURN_TRIGGER`, `TURN_TRIGGERS`, `triggerForAction`, the listener key, `WAKE_ACTIONS`, and `buildPrompt` — one test fails loudly if any surface is missed.
- **Idea assigned to an `agent_instance` vs a plain `agent`.** Reuse the exact resolution helpers the other stage events use (`resolveAssigneeAgentUuid` server-side, `assigneeOwningAgentUuid` client-side) so instance-pinning + session-origin upgrade behave identically.

## Implementation Plan

Order (each builds on the prior; task granularity in `tasks.md`):
1. Backend event + full wake registration (service, server action, all 6 registration surfaces, drift-guard test).
2. Shared predicate + Yolo button component + both-panel wiring + confirm dialog + i18n.
3. Teaching-hint removal (both panels + both locales).
4. Skill-doc updates (idea + develop skills, all four surfaces).
5. Integration checkpoint: live end-to-end wake verification (server + local daemon) + design.pen update.
