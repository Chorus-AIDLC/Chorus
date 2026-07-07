# Tasks: Sync OpenClaw plugin wake events with the daemon

## 1. Route the three stage-advance wake actions in the plugin
- [ ] 1.1 Add `elaboration_verified`, `start_development`, `yolo_requested` cases to `ChorusEventRouter`'s `switch` in `packages/openclaw-plugin/src/event-router.ts`, plus a `handleElaborationVerified` / `handleStartDevelopment` / `handleYoloRequested` method each, following the existing `handleElaborationAnswered` shape (idea-anchored, `buildMentionGuidance(n, "idea")`, `contextKeyFor(action, n.entityUuid)`). Preserve each action's instructional contract (write-proposal / execute-all-tasks / yolo-to-done-never-merge) in the plugin's own prompt voice; do not port the CLI `HEADLESS_PREAMBLE`.

## 2. Plugin-side unit tests
- [ ] 2.1 Extend `packages/openclaw-plugin/src/__tests__/event-router.test.ts` — add the three actions to the routing `it.each` table asserting the wake message carries the action's distinctive instruction and the `contextKey` is `chorus:<action>:<entityUuid>`; run the plugin Vitest green.

## 3. Lockstep parity guard (repo CI)
- [ ] 3.1 Add `cli/__tests__/openclaw-plugin-wake-parity.test.mjs` asserting the plugin router's handled-action set ⊇ `WAKE_ACTIONS` (from `cli/prompts.mjs`) minus `{resource_resumed, human_instruction}`; failure names the missing action(s). Run the root Vitest green.
