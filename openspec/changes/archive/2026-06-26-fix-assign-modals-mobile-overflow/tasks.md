# Tasks

## 1. Build the reusable scrollable-dialog skeleton

- [ ] 1.1 Add `src/components/ui/scrollable-dialog.tsx` composing shadcn `Dialog`:
      flex-column `DialogContent` with `max-h-[85svh]`, `overflow-hidden`,
      `sm:max-w-[400px]`; `shrink-0` header & footer slots; `min-h-0 flex-1
      overflow-y-auto` body slot.
- [ ] 1.2 Self-driving open contract: accept `open` / `onOpenChange`; keep shadcn
      Esc / overlay / focus-trap / close button.
- [ ] 1.3 Unit tests: body scrolls while header/footer pinned; `min-h-0` present;
      `onOpenChange(false)` fires on close paths.

## 2. Adopt the skeleton in both assign modals

- [ ] 2.1 `assign-idea-modal.tsx`: replace the backdrop + fixed card shell with the
      skeleton, mapping `onOpenChange(false) → onClose`; keep all hooks, state,
      `handleSubmit`, `canSubmit`, `resolvePinLabel`, RadioGroup, Select,
      InstancePicker, error block verbatim.
- [ ] 2.2 `assign-task-modal.tsx`: same migration; business logic unchanged.
- [ ] 2.3 Confirm all four call sites compile unchanged (no `open` prop added).

## 3. Verify

- [ ] 3.1 `pnpm lint`, `npx tsc --noEmit`, `pnpm test` all green.
- [ ] 3.2 Playwright real-viewport checks: 375×667, 360×420 (soft keyboard), and
      ≥3 instances + already-assigned — title + Cancel/Assign always visible &
      clickable, body scrolls to any row, for both modals.
- [ ] 3.3 Update `docs/design.pen` for the two assign-modal screens.
