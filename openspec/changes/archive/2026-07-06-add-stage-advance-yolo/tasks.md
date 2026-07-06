# Tasks

## 1. Backend `yolo_requested` event + full wake registration
- [ ] 1.1 New `src/services/yolo-request.service.ts` (`YOLO_REQUESTED_STAGE` definition + `requestYolo` wrapper), cloning `start-development.service.ts` but with an assignee-only precondition (no proposal/task lookup) and `require_online` offline policy.
- [ ] 1.2 New server action `yoloRequestedAction` + `YoloRequestedErrorCode` union (no proposal/task sub-codes).
- [ ] 1.3 Register the literal at all six surfaces: `notification-listener.ts` (map + recipient case + message), `notification-turn.ts` (trigger map + session-origin-upgrade set), `daemon-session.service.ts` `TURN_TRIGGERS`, `cli/event-router.mjs` (mirror + re-dispatch OR-chain), `cli/prompts.mjs` (`WAKE_ACTIONS` + stage-adaptive `buildPromptBody` case pointing at the yolo skill, no PR-merge), and refresh the stale `prisma/schema.prisma` trigger comment.
- [ ] 1.4 Drift-guard integration test (clone the `elaboration_verified` one) + service/action/listener/turn/prompt unit tests.

## 2. Yolo button UI + shared predicate + i18n
- [ ] 2.1 New shared predicate `src/lib/yolo-request.ts` (assignee resolution + `yoloPreconditionsMet`/`canRequestYolo` on `derivedStatus !== "done"`), with unit tests.
- [ ] 2.2 New `src/components/yolo-button.tsx` with an AlertDialog confirm step, presence gating, per-error-code toasts, cloning `start-development-button.tsx`.
- [ ] 2.3 Render the button in both idea-detail panels' header action slot; add the `yolo` i18n block to `messages/en.json` + `messages/zh.json`; component render/gating tests.

## 3. Remove the teaching-style elaboration hint
- [ ] 3.1 Delete the `elaboration.elaborationRequiredHint` render (and dead `showHelpText`) in both panels; remove the key from both locale files; keep status-feedback hints. Update/adjust affected panel tests.

## 4. Skill documentation
- [ ] 4.1 Document the Yolo handoff in the idea + develop skills across all four skill surfaces (CC plugin, Codex plugin, standalone, OpenClaw), mirroring the existing Start-Development handoff notes.

## 5. Integration checkpoint
- [ ] 5.1 Live end-to-end verification (real server + local daemon) that a Yolo button click wakes the idea's assigned agent with the `yolo_requested` prompt on the idea's session origin; update `docs/design.pen` for the new button + confirm dialog and removed hint.
