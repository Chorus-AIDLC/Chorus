# Design — Fix @mention cwd instance-picker dialog mobile overflow

## Context

`MentionInstancePickerDialog` (`src/components/mention-editor.tsx`, ~lines 438–497) is a
Radix `Dialog` shown when an `@`-mentioned agent has 2+ online `(host, cwd)` instances.
Its current shape:

```tsx
<Dialog open={open} onOpenChange={...}>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>{t("title")}</DialogTitle>
      <DialogDescription>{t("subtitle", {...})}</DialogDescription>
    </DialogHeader>
    <InstancePicker instances={...} selectedConnectionUuid={...} onSelect={...} />
    <DialogFooter>
      <Button variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
      <Button disabled={!selected} onClick={...}>{t("confirm")}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

The shared `DialogContent` (`src/components/ui/dialog.tsx`) is `position: fixed`, centered
via `top-[50%] left-[50%] translate-x/y-[-50%]`, `z-50`, and grids its children with
`gap-4`. It has **no** `max-height` and **no** `overflow`, so the content box grows to its
intrinsic height and is centered against `window.innerHeight` (the layout viewport, which
ignores the mobile soft keyboard).

## Measured failure (Playwright, develop)

| Viewport | Instances | Dialog height | Dialog top | Footer (Pin) bottom | Result |
|---|---|---|---|---|---|
| 390×844 | 2 | 314 px | 265 | 510 (≤ 844) | OK — no repro |
| 360×420 (keyboard) | 2 | 314 px | 53 | 298 (≤ 420) | OK |
| 360×420 (keyboard) | 8 | **573 px** | **−76** | **429 (> 420)** | **Pin off-screen, no scroll → unreachable** |

`overflow-y: visible`, `max-height: none` confirmed on the content node in all cases. So
the defect is purely "content taller than the visible viewport, with no internal scroll
and no viewport-aware cap."

## Approach

Constrain the picker's `DialogContent` and restructure its body into three bands so the
**list** is the only thing that scrolls:

```tsx
<DialogContent
  className="flex max-h-[85svh] flex-col gap-0 sm:max-w-md"
>
  <DialogHeader className="shrink-0">…</DialogHeader>
  {/* the ONLY scroll region */}
  <div className="min-h-0 flex-1 overflow-y-auto py-1">
    <InstancePicker … />
  </div>
  <DialogFooter className="shrink-0 pt-3">…</DialogFooter>
</DialogContent>
```

Key decisions:

1. **Dynamic-viewport unit.** Use `max-h-[85svh]` (small-viewport-height). `svh` is the
   *smallest* visible viewport (URL bar + soft keyboard expanded), so the dialog is
   capped to a height that always fits even with the keyboard open. This directly fixes
   the root cause (`vh`/layout-viewport ignores the keyboard). The repo already relies on
   the dynamic-viewport family (`h-dvh max-h-dvh`) in `connections-modal.tsx` for the
   exact "keyboard pushes content off-screen" problem, so this is consistent precedent.
   `85svh` leaves a margin so the overlay is visibly a modal, not a full-bleed sheet.

2. **`flex flex-col` + `min-h-0 flex-1 overflow-y-auto` on the list band.** This is the
   canonical "fixed header + scrolling body + fixed footer" CSS. `min-h-0` is required so
   the flex child may shrink below its content height and actually scroll (without it the
   child refuses to shrink and overflow returns). Header and footer are `shrink-0` so they
   are never compressed and always visible/tappable.

3. **`gap-0` on the content** (overriding the primitive's `gap-4`) plus explicit padding
   on the bands, so the scroll region's edges are clean and the footer hugs the bottom.
   The dialog keeps the primitive's padding (`p-6`) and rounded border.

4. **Scope: this dialog only.** `ui/dialog.tsx` is intentionally untouched — adding a
   global `max-height` there would regress every dialog in the app. `assign-task-modal`
   and `assign-idea-modal` embed `InstancePicker` inline inside their own modals (which
   already manage their own height/scroll), so they are unaffected and need no change.

## Module contract

`MentionInstancePickerDialog` keeps its exact props (`open`, `agentName`, `instances`,
`onConfirm`, `onCancel`) and behavior:

- `selected` state, single-instance auto-select (via `InstancePicker`), the 2+ trigger
  upstream in `selectMentionableRef`, Cancel-discards, and Pin-enabled-on-selection are
  all unchanged.
- The only change is the `DialogContent` className + wrapping the `InstancePicker` in a
  scroll `<div>`. No prop, callback, or i18n key changes.

## Testing strategy

- **Unit/DOM test** (Vitest + Testing Library) on `MentionInstancePickerDialog`: render
  with N instances and assert (a) the dialog content node carries the mobile-safe
  max-height + `flex-col` classes, (b) the `InstancePicker` list sits inside an
  `overflow-y-auto` region, and (c) the footer (Cancel + Pin) is a sibling of that
  region, not inside it — so it cannot be scrolled away. Assert the Pin button enables
  after selecting a row.
- **Live browser verification** (Playwright, mobile) on the running dev server across the
  three scenarios in the table above: standard mobile viewport, keyboard-shortened short
  viewport, and many instances. Confirm with `getBoundingClientRect` + `elementFromPoint`
  that the header and the Pin button stay inside the viewport and the Pin button is the
  top element at its own center (clickable), and that the list scrolls.

## Risks

- **`svh` browser support.** `svh`/`dvh` are supported in all modern mobile browsers
  (iOS Safari 15.4+, Chrome/Android 108+). The repo already ships `dvh`. On a browser
  without support the declaration is ignored and behavior degrades to today's (no cap) —
  no worse than the status quo, never a hard break.
- **Very short viewport + 1 row.** With `85svh` the cap is generous; a single-row picker
  never needs the scroll and renders identically to today.
