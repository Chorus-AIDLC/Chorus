# Proposal: Container Idea UI Full-Chain

## Why

The `container-idea` capability shipped the mechanism — an explicit `isContainer` flag, the proposal guard, and a detail-panel toggle/badge/child-rollup. But the day-to-day *usage* loop is incomplete. Three gaps, settled via YOLO self-elaboration on idea `794633cc` (a derived child of the container idea itself — the pattern's first real use):

1. **Creating an empty container is clumsy.** You can't easily stand up a bare grouping node from the UI and flag it a container in one step; the create dialog has no container affordance.
2. **A container doesn't *look* different.** Today a container only gets a small badge; users can't tell a grouping node from a deliverable idea at a glance.
3. **The headline intent is missing entirely.** The owner's core ask: create a container from the UI with a "help me decompose" intent, and have the daemon agent propose a set of child ideas the user confirms — the container→children pattern, driven by AI. No such flow exists.

## What Changes

- **Empty-container creation** (Block 1, pure UI): `NewIdeaDialog` gets an `isContainer` checkbox; content stays optional (already is, server-side). Checking it and entering only a title creates a bare container in one step. The whole server chain (`createIdea`, POST route, `createIdeaAction`, MCP tool) already accepts `isContainer` and already treats content as optional — **no backend change**.
- **Container visual distinction** (Block 2, pure UI): a container idea gets a distinct panel-header treatment and a distinct card border/tint (beyond the existing small badge), so a grouping node reads differently from a deliverable idea at a glance. Additive CSS/JSX gated on the already-computed `isContainer`.
- **Daemon-assisted decompose** (Block 3, the core): a container-creation path carries an explicit "help me decompose into child ideas" intent to a daemon agent (reusing the existing conversational-idea-entry: pre-create + assign + wake). The woken agent, per an updated idea/decompose skill, runs a lightweight elaboration to clarify scope, then **proposes a list of child ideas as a structured elaboration round** the user reviews/edits/confirms in the existing elaboration panel. On confirmation the children are created (`chorus_pm_create_idea` with `parentUuid = container`), each starting in `open`. **Minimal-change: reuse the conversational-entry wake + the elaboration round as the propose/confirm surface — no new wake action, no new chat-UI subsystem, no new plugin ports.**

## Capabilities

### New Capabilities

- `container-decompose-ui`: the container UI full-chain — empty-container creation via the create dialog, container visual distinction in panel + card, and the daemon-assisted decompose flow (explicit intent → conversational wake → propose-children-as-elaboration-round → user-confirm → child ideas created under the container).

## Impact

- **Frontend**: `src/app/(dashboard)/projects/[uuid]/dashboard/new-idea-dialog.tsx` (isContainer checkbox + decompose-intent affordance in conversational mode); `panels/idea-detail-panel.tsx` (stronger container header treatment); `dashboard/idea-card.tsx` (container card border/tint). i18n keys in `messages/en.json` + `messages/zh.json`.
- **Backend (Block 3 only, minimal)**: `src/services/daemon-instruction.service.ts` — a decompose variant of `composeConversationalIdeaInstruction` (and a param on `createConversationalIdeaSession` to select it). No new wake action in `notification-turn.ts` / `prompts.mjs` / `notification-listener.ts` — the flow rides the existing `human_instruction` conversational wake.
- **Skill**: the idea skill (4 surfaces) documents the decompose contract — when woken with decompose intent, the agent clarifies scope then proposes child ideas as an elaboration round for user confirmation, then creates them with `parentUuid` on confirm.
- **No schema change**: children use existing lineage (`parentUuid`); the propose/confirm surface reuses `ElaborationRound`/`ElaborationQuestion` (one question per proposed child — single-select, ≤15 per round); children created one-by-one via the existing `chorus_pm_create_idea` (no batch primitive needed for v1). The confirm re-wake reuses the existing `elaboration_answered` action (idea-session-origin upgrade), so no new wake action.
- **Integration checkpoint**: because the headline capability is the end-to-end create→wake→propose→confirm→create loop and it needs a live daemon, a dedicated verification task gates it as a live-daemon/human handoff (headless YOLO can verify Blocks 1 & 2 in-browser and the Block 3 template/skill by unit + inspection, but not the full loop).
- **Docs**: `docs/MCP_TOOLS.md` if any tool contract note is needed (likely none — reuses existing tools). `docs/design.pen` deferred (owner waived design.pen updates for this line of work).
- **Backward compat**: fully additive. Non-container creation and existing ideas are unchanged.

## Out of scope (v1)

- A dedicated batch idea-create MCP tool (v1 uses sequential `chorus_pm_create_idea`).
- A brand-new interactive "structured proposal card" inside the daemon chat transcript (v1 reuses the elaboration panel as the confirm surface).
- Auto-elaborating each child on creation (children start `open`; the user/daemon advances them individually later).
- design.pen mockups (owner-waived for this work).
