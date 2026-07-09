# Design: Container Idea UI Full-Chain

## Guiding constraint

Same as the parent container-idea work: **minimal code + interaction change**. The exploration confirmed Blocks 1 & 2 need only UI (all server capability already exists on this branch), and Block 3 has a reuse path that avoids the expensive parts (new wake action across 3 files + plugin ports, and a new structured-chat-UI subsystem). YOLO self-elaboration picked the smallest viable option for each open question.

## Block 1 — Empty-container creation (UI only)

`NewIdeaDialog` (`new-idea-dialog.tsx`) already: accepts `parentUuid`, labels `content` optional, requires only `title` (client + server), and POSTs to `/api/projects/[uuid]/ideas` (which already accepts `isContainer`).

Change: add an `isContainer` checkbox (shadcn `Checkbox`) near the content textarea; include `...(isContainer ? { isContainer: true } : {})` in the POST body. That's the whole of Block 1 — check the box, type a title, get a bare container. (Elab Q2 = "放宽必填 + 在对话框暴露 isContainer".)

## Block 2 — Container visual distinction (UI only)

`isContainer` is already computed in both `idea-detail-panel.tsx` (`const isContainer = idea?.isContainer === true`) and `idea-card.tsx` (`idea.isContainer`), and both already render the small badge. Add a stronger, additive visual treatment gated on that flag (elab Q7 = "容器态视觉区分为主"):

- **Panel**: tint/border the header bar (or the outer panel left border) when `isContainer`, using the existing container accent palette (`#F3E7DD` / `#B26B3D`) already used by the badge — so a container panel reads distinctly.
- **Card**: a container-accent left border or subtle background on the card root when `idea.isContainer`.
- Keep the existing badge; this is an *additional* whole-element cue, not a replacement.
- Also keep/confirm the existing `containerHint` copy shown where the proposal CTA is hidden. (A dedicated "this idea already has a proposal, converting to container only blocks new ones" warning is optional polish — include a short i18n hint if cheap.)

All new strings via i18n in both `en` and `zh`.

## Block 3 — Daemon-assisted decompose (the core; reuse-driven)

### Trigger (elab Q3 = explicit intent)
The create dialog's **conversational mode** already pre-creates an idea, assigns it to an online daemon instance, and wakes it (via `createConversationalIdeaSession`, which creates the first turn as a `human_instruction` turn). Block 3 adds a **"help me decompose into child ideas"** intent to that path (e.g. a checkbox/toggle in conversational mode, or a distinct dispatch flag). No new wake/notification **action type** is introduced — the initial dispatch reuses the existing conversational `human_instruction` turn, and the later confirm re-wake reuses the existing `elaboration_answered` action (see "Re-wake on confirm" below). When the intent is set, the pre-created idea is flagged `isContainer = true` and the dispatched instruction selects the decompose template.

### Re-wake on confirm (no new action)
When the user answers the propose-children elaboration round, the existing `elaboration_answered` activity fires; `notification-turn.ts` maps it to the `elaboration` trigger and it is in `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`, so the answer re-wakes **exactly the container's idea-anchored daemon session** — the same agent that proposed the round. This is the mechanism that lets step 6 (create the confirmed children) run without inventing a new wake action. Precise wording: the *initial* dispatch is a `human_instruction` turn; the *confirm* re-wake is `elaboration_answered`. Neither is new.

### Instruction template (elab Q4 = elaborate-then-split)
Add a decompose variant to `composeConversationalIdeaInstruction` in `daemon-instruction.service.ts` (select via a param on `createConversationalIdeaSession`). Instead of "edit title, start elaboration, end turn", the decompose instruction directs the agent to:
1. Edit the container's title/content from the user's description.
2. Ensure it is a container (`isContainer = true`).
3. Run **one lightweight elaboration round** to clarify decomposition scope/dimension (may self-answer in headless, or ask the user) — reusing the container's elaboration as the shared context the parent-idea design already established.
4. **Propose the child ideas as a structured elaboration round** — **one elaboration question per proposed child** (title as the question text, a short rationale as the option/description), so the user reviews/edits/confirms each in the existing elaboration panel. Elaboration questions are single-select and a round is capped at 15 questions, so the round is one-question-per-child (accept / edit-title-via-custom-text / drop-by-declining), NOT a single multi-select — and a decomposition is bounded to ≤15 candidates per round (propose more across rounds if needed). (elab Q5 = preview-confirm.)
5. End the turn; the user's confirmation answer wakes the agent again.
6. On the confirm wake, create each accepted child via `chorus_pm_create_idea` with `parentUuid = container` (sequential — no batch primitive needed for v1). Children start in `open` (elab Q6 = stop at open); no auto-elaboration.

### Why reuse the elaboration round as the confirm surface
The exploration found there is **no** structured/interactive message type in the daemon chat transcript (flat Markdown), so a "proposed children → confirm" affordance would otherwise be a new subsystem. The **elaboration round** already IS a "agent writes a structured round → user reviews/edits/confirms in a panel → confirmation wakes the agent" round-trip, with a persisted entity (`ElaborationRound`/`ElaborationQuestion`), an agent-write MCP tool (`chorus_pm_start_elaboration`), a human-confirm action, and a wake-on-answer. Reusing it for the propose/confirm step is the single biggest change-size reduction in this proposal. The proposed-children list is expressed as a round the user answers (accept / edit-title / drop per child).

### Agent contract lives in the skill
The behavior in steps 1-6 is an **agent/skill contract**, documented in the idea skill (all 4 surfaces): "when woken via the container-decompose conversational intent, clarify scope, propose children as an elaboration round, and on confirmation create them under the container with `chorus_pm_create_idea`." Keeping it in the skill (not hardcoded server logic) matches how conversational-idea-entry already delegates the turn's work to the agent.

### Container terminal status
The container's own lifecycle status is unchanged by decomposition: after its (lightweight) elaboration resolves it sits at `elaborated`, exactly as the parent container-idea design specifies (status derived from elaboration; a container has no proposal/task of its own). Creating children does not advance or alter the container's status — the children are independent AI-DLC units, and the container surfaces their progress only via the existing read-only "N/M children done" rollup.

## What we explicitly do NOT build (v1)

- No new wake action / notification type (no `notification-turn.ts` / `prompts.mjs` / `notification-listener.ts` / plugin-port changes) — rides the existing conversational `human_instruction` wake.
- No batch idea-create MCP tool — sequential `chorus_pm_create_idea`.
- No new interactive card inside the daemon chat transcript — the elaboration panel is the confirm surface.
- No auto-elaboration of children.
- No design.pen (owner-waived).

## Risks

- **Live-daemon round-trip is hard to e2e headlessly.** The full create→wake→propose→confirm→children loop needs a live daemon; a headless YOLO run can verify Blocks 1 & 2 in-browser and the instruction-template/skill wiring by unit/inspection, but the end-to-end daemon loop is a human/live-daemon verification handoff (documented, not faked). [[project_headless_yolo_integration_blocked]]
- **Elaboration-as-child-proposal is a metaphor stretch.** Using an elaboration round to carry "proposed children" is reuse, not a perfect semantic fit; the skill must phrase the round clearly (accept/edit/drop per child). If it proves awkward, a dedicated confirm surface is a future enhancement — but v1 favors minimal change.
- **Conversational mode requires an online daemon.** The decompose intent is only offered when a daemon connection is online (same gate as existing conversational mode); the static form path still creates a plain (optionally container) idea with no decomposition.
