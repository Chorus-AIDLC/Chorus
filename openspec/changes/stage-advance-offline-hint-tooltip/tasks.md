# Tasks

## 1. Move offline hint into a tooltip on both stage-advance buttons

- [ ] 1.1 Shorten `offlineHint` copy in all four locale files (`messages/en.json`, `messages/zh.json`, `messages/ko.json`, `messages/ja.json`), preserving the key name
- [ ] 1.2 In `StartDevelopmentButton`, replace the inline offline `<span>` with a Tooltip whose trigger is a focusable wrapper around the disabled button
- [ ] 1.3 In `YoloButton`, do the same — but handle the nested `asChild`: on the offline path render the disabled button inside the focusable TooltipTrigger (not as the AlertDialogTrigger); on the online path keep the button as AlertDialogTrigger with no tooltip wrapper
- [ ] 1.4 Update `start-development-button.test.tsx` and `yolo-button.test.tsx` to assert the tooltip mechanism (focusable wrapper, no persistent inline text) while keeping the disabled-state and online/click/error-code assertions
- [ ] 1.5 Verify: `pnpm test` for both suites green, `npx tsc --noEmit` clean, `pnpm lint` clean; confirm both light/dark themes visually
