# Add a human-initiated Yolo stage-advance button + wake event

## Why

The idea-detail panels already expose two human one-click "stage-advance" affordances built on the shared `stage-advance.service.ts` framework: **Verify Elaborate** (`elaboration_verified` → wake the assigned agent to write the proposal) and **Start Development** (`start_development` → wake the assigned agent to execute all remaining tasks). Both fire a dedicated, session-origin-pinned wake at the idea's assigned daemon agent.

There is no one-click way to tell that agent "just drive this whole idea to done autonomously." Today a human has to either babysit each stage button in turn, or manually type a free-text `human_instruction` telling the agent to run the yolo pipeline. A first-class **Yolo** button removes that friction: one click wakes the idea's assigned agent to pick up the full-auto AI-DLC pipeline (Idea → Proposal → Execute → Verify) from wherever the idea currently sits, following the existing `yolo` skill.

Separately, the idea-detail panel's action area still carries a teaching-style workflow hint — "Complete or skip elaboration to create a proposal" (`elaboration.elaborationRequiredHint`). In the current reversed-conversation workflow (agent proposes, human verifies via the stage buttons) this "claim first, then elaborate, then open a proposal" instruction no longer reflects how work flows and just adds noise. It should be removed while the real status-feedback strings (offline hint, started hint, verified-queued hint) stay.

## What Changes

1. **New `yolo_requested` stage-advance event.** A new `StageAdvanceDefinition` (cloning `start_development`) exposed as a Next.js server action — NOT an MCP tool. Precondition: the idea's assignee is an agent (or `agent_instance` resolved to its owning agent). Offline policy `require_online` (inherited from `start_development`: a Yolo click expects the agent to wake now or a clear offline error, never a silent queue). The event performs NO idea state transition — on success it emits only the `yolo_requested` activity.

2. **New `yolo_requested` wake, registered across every server + daemon surface.** The literal is added to: `notification-listener.ts` (activity→type map, agent-only recipient resolution, message text), `notification-turn.ts` (action→trigger map + idea-session-origin-upgrade set), `daemon-session.service.ts` `TURN_TRIGGERS`, `cli/event-router.mjs` (action→trigger mirror + directed re-dispatch OR-chain), and `cli/prompts.mjs` (`WAKE_ACTIONS` + a new `buildPromptBody` case). The recipient is ONLY the idea's assigned agent (no human bell); the trigger is its own value, never collapsed into `task_assigned` (the anti-pattern behind the 0.13.0 random-cwd defect).

3. **Stage-adaptive wake prompt.** Unlike `start_development` (always the execute stage), the Yolo wake can land at any incomplete stage (elaboration decision Q1 = "any incomplete stage"). The prompt instructs the woken agent to drive the idea to done via the **yolo skill**, self-determining which phase to enter from the idea's current state, and — consistent with the "Yolo never merges" rule — to stop at done/report and never merge or push a PR without explicit human approval.

4. **New Yolo button in both idea-detail panels.** A shared client predicate (mirroring `src/lib/start-development.ts` / `src/lib/elaboration-verify.ts`) gates one button rendered identically by both the `/ideas` route panel and the dashboard idea-tracker panel. It shows at any incomplete stage (assignee is an agent and the idea is not already done), presence-gated (visible-but-disabled with a hint when the agent is offline). Clicking opens a confirmation dialog (elaboration decision Q5 = confirm) explaining that Yolo drives the whole idea automatically; on confirm it invokes the server action and surfaces per-error-code toasts. Because the button is not gated on an approved proposal, it can appear alongside Start Development on a building-stage idea — both are shown; the human picks one.

5. **Remove the teaching-style workflow hint.** Delete the `elaboration.elaborationRequiredHint` render in both panels and remove the key from both locale files. Status-feedback strings (offline / started / verified-queued) are unchanged (elaboration decision Q4 = delete teaching hint only).

## Capabilities

- `stage-advance-wake` — extended with the Yolo stage-advance event, its wake pipeline, the Yolo button UI, and the teaching-hint removal.

## Impact

- **No DB migration.** `DaemonSessionTurn.trigger` and `Activity.action` / `Notification.action` are free-text `String` columns, not DB enums. The new literal flows through the existing tables. (The stale inline comment on `prisma/schema.prisma`'s `trigger` column is refreshed for accuracy only.)
- **No new MCP tool and no new agent permission.** Like the other stage buttons, this is a human-only server action; agents never call it.
- **Additive to the existing wake pipeline.** All edits register a new literal alongside `start_development` / `elaboration_verified`; no existing wake behavior changes. A drift-guard integration test (cloning the `elaboration_verified` one) proves the literal survives every server→daemon hop.
- **Skill docs updated** in all four skill surfaces (idea + develop skills) to document the Yolo handoff, mirroring the existing Start-Development handoff notes.
- **Permissions caveat (surfaced, not blocked):** the yolo skill needs an admin-preset key (idea/proposal/task admin) to run unattended. A woken agent lacking those permissions follows the yolo skill's own prerequisite check + the headless preamble — it posts a comment explaining the missing permission and ends the turn rather than failing silently.
