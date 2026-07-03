# Proposal: Generic stage-advance wake framework + 「开始开发」(Start Development) button

## Why

The "Verify Elaborate" button proved out a valuable interaction: **a human clicks one button, and the idea's daemon agent wakes up and drives the next AI-DLC stage**. But that pattern currently exists only for the elaboration → proposal handoff, hand-rolled as a one-off (`verifyElaborationAction` → `elaboration_verified` activity → agent notification → session-origin-pinned wake).

The execute stage has no such entry point. After an admin approves a proposal, the tasks materialize as `open` and… sit there. The `proposal_approved` notification does wake the proposal's authoring agent, but its turn trigger is collapsed into `task_assigned` (`notification-turn.ts:129`) — a semantic mismatch that already caused one bug (the 0.13.0 "proposal approve wakes a random cwd" issue, fixed in PR #381 by widening the upgrade set) and leaves no human-initiated way to say "the plan is approved, **go build it**" when the wake was missed, the agent restarted, or the human simply wants to kick off execution now.

Elaboration for this idea (c3568bf3, round 1, all 6 answers in) decided to solve this generically:

- **Q6 = b**: don't ship a one-off `start_development` event — abstract a **generic "human one-click stage-advance" framework** and migrate `elaboration_verified` onto it, so elaboration→proposal and approve→develop share one code path and future stage buttons are additive.
- **Q1 = a**: the woken agent claims and executes **all** remaining tasks in dependency order (one wake runs the whole execute stage, like the yolo develop segment).
- **Q2 = a**: wake targeting strictly reuses the `elaboration_verified` session-origin pinning — the wake lands on the idea's originating daemon session/cwd, not an arbitrary online connection.
- **Q3 = a**: "unfinished tasks" means any task whose status is not `done`/`closed` (includes `open`, `assigned`, `in_progress`, `to_verify`).
- **Q4 = a**: the button lives where Verify Elaborate lives (idea detail panel header action area, both panels); online status uses the existing AgentPresence realtime mechanism.
- **Q5 = a**: the button is shown optimistically; the server validates agent liveness at click time and returns an error when the agent is offline (no offline queue/backfill for this event — unlike `elaboration_verified`).

## What Changes

- **New shared stage-advance module (backend).** Extract the common shape of a human stage-advance action into one reusable server-side helper: human-only actor gate → company-scoped idea lookup → per-stage precondition check → per-stage offline policy → activity emit (per-stage action string). `verifyElaboration` migrates onto it with **zero behavior change** (same preconditions, same state transition, same `elaboration_verified` activity, same queue-when-offline policy).

- **New `start_development` stage-advance event.** A human-callable server action (`startDevelopmentAction`) that validates: the idea has an approved proposal, that proposal has at least one task with status not in `done`/`closed`, the idea's assignee is an agent (or pinned `agent_instance`), and the assignee agent has an effectively-online daemon connection. On success it emits an `idea:start_development` activity. It performs **no state transition** — the idea's derived status already reflects the execute stage; the event's only job is the wake.

- **Wake wiring with a dedicated trigger.** `start_development` gets its own notification action, its own `DaemonSessionTurn.trigger` value, and membership in `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS` — deliberately NOT collapsed into `task_assigned`, so turns stay observable and the session-origin upgrade applies by design rather than by side effect. Recipient resolution mirrors `elaboration_verified`: agent-only, never a human bell notification.

- **Daemon executes the whole remaining task set.** `cli/prompts.mjs` gains a `start_development` wake prompt instructing the woken agent to claim and execute ALL remaining unblocked tasks of the idea's approved proposal in dependency order (loop until none remain), submitting each for verify per the develop skill. `cli/event-router.mjs` maps the action to the trigger and includes it in autonomous re-dispatch.

- **「开始开发」button on both idea detail panels.** Rendered in the header action area (same slot as Verify Elaborate), enabled iff: approved proposal exists ∧ some task not `done`/`closed` ∧ assignee is an agent ∧ that agent shows online via AgentPresence. Clicking calls the server action; an offline-agent rejection surfaces as an error toast. Both panels share one gating predicate (`src/lib/` helper, mirroring `elaboration-verify.ts`).

- **i18n** for the button label, success hint, and offline error in `messages/en.json` + `messages/zh.json`.

- **design.pen** updated for the new button state on the idea detail panel.

- **Skill docs**: one-line note in `public/skill/` and `public/chorus-plugin/skills/chorus/` that a `start_development` wake means "claim and execute all remaining tasks".

## Capabilities

### New Capabilities

- `stage-advance-wake`: The generic human one-click stage-advance framework (shared precondition/offline-policy/activity pipeline, migration of the elaboration-verify path onto it) and its second concrete event `start_development` — server action, preconditions, agent-only notification, dedicated turn trigger with session-origin pinning, daemon execute-all-tasks behavior, and the UI button with AgentPresence gating.

### Modified Capabilities

- `daemon-session-conversation`: Extend the `DaemonSessionTurn.trigger` enumeration with `start_development` (alongside the pending `elaboration_verified` extension from change `add-elaboration-verify-wake`).

## Impact

- **Schema**: zero migrations. `DaemonSessionTurn.trigger` and `Notification.action` are free-form strings; no new model, no new Idea status.
- **Backend**:
  - `src/services/stage-advance.service.ts` (new) — shared framework helper + per-stage definitions.
  - `src/services/elaboration.service.ts` — `verifyElaboration` refactored onto the framework (behavior-preserving).
  - `src/services/idea.service.ts` or new service — `startDevelopment` preconditions (reuses approved-proposal + task-status queries already used by `computeDerivedStatus`).
  - `src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions.ts` (or sibling) — `startDevelopmentAction` server action.
  - `src/services/notification-listener.ts` — `idea:start_development` → notification action `start_development`, agent-only recipient.
  - `src/services/notification-turn.ts` — `start_development: "start_development"` in `NOTIFICATION_ACTION_TO_TURN_TRIGGER` + add to `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`.
  - `src/services/daemon-connection.service.ts` — liveness check reused (`isEffectivelyOnline`), no change expected.
  - `src/services/daemon-session.service.ts` — `TURN_TRIGGERS` gains `"start_development"`.
- **Daemon client** (`cli/`): `event-router.mjs` (`ACTION_TO_TURN_TRIGGER`, re-dispatch trigger list), `prompts.mjs` (`WAKE_ACTIONS` + prompt case), tests.
- **Frontend**: `src/lib/start-development.ts` (new shared predicate), both idea-detail panels, AgentPresence consumption, i18n keys.
- **Docs**: skill docs note (both roots), `docs/design.pen`.
- **Backward compat**: fully additive externally. `elaboration_verified` behavior is unchanged (its internals move onto the framework); `proposal_approved`/`proposal_rejected` wake mappings are untouched.

## Out of Scope

- Migrating `proposal_approved` / `proposal_rejected` (or any other existing wake) onto the stage-advance framework — they are agent-recipient reactions to admin actions, not human one-click buttons. Only `elaboration_verified` migrates now.
- A list-row (idea tracker table) button — Q4 chose panel-only.
- Offline queue/backfill for `start_development` — Q5 chose validate-online-or-error.
- Changing how tasks are claimed/executed/verified — the woken agent uses the existing develop flow.
- Per-task "run just the next task" mode — Q1 chose run-all.

OpenSpec change slug: add-stage-advance-start-development
