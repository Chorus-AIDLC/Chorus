# Tasks

## 1. Skill docs — reference guidance (idea + chorus, 4 roots each)
- [ ] 1.1 Add "External references" guidance to the idea skill in all 4 roots (reflex + inline `references[]` at create + 4-type criteria + one generic example), adapted per root convention
- [ ] 1.2 Add the reference-reflex behavior note to the chorus overview skill in all 4 roots
- [ ] 1.3 Verify semantic parity across roots (same guidance, root-appropriate wording)

## 2. Daemon wake prompts — one-line nudge
- [ ] 2.1 Add the reflex line to `HEADLESS_PREAMBLE` in `cli/prompts.mjs` (no elaboration tool names)
- [ ] 2.2 Add the nudge line to `composeConversationalIdeaInstruction` in `daemon-instruction.service.ts` (covers elaborate + decompose)
- [ ] 2.3 Update wording tests: `wake-orchestration.test.mjs` + `daemon-instruction.conversational.test.ts`
- [ ] 2.4 Confirm the OpenClaw wake-parity guard still passes (no OpenClaw preamble added)

## 3. UI — long-URL/title overflow fix
- [ ] 3.1 Constrain the link anchor (`flex min-w-0`) in `references-section.tsx`
- [ ] 3.2 Same fix in `idea-references-panel.tsx`
- [ ] 3.3 Verify truncation + no overflow in light and dark themes with a pathologically long title
