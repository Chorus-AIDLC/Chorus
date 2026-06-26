# Fix Assign Idea / Assign Task modals overflowing the mobile viewport (footer buttons unreachable)

## Why

On a mobile viewport, opening **Assign Idea** or **Assign Task** can push the
modal taller than the visible viewport, and the modal **cannot scroll**, so the
bottom **Assign / Cancel** buttons are pushed off-screen and the user cannot
complete (or cancel) the assignment.

Two **hand-written fixed-position modals** are affected (verified against the
`develop` / 0.11.2 working tree). They are neither shadcn `Dialog` nor the
generic `src/components/assign-modal.tsx` (which already has
`max-h-[80vh] overflow-y-auto` and is fine):

- `src/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal.tsx`
- `src/app/(dashboard)/projects/[uuid]/tasks/assign-task-modal.tsx`

Both use the same container:

```
fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl ...
```

Root cause:

1. **No `max-height`, no internal scroll.** The card is vertically centered with
   `top-1/2 -translate-y-1/2`, but the container has no height ceiling and the
   body has no `overflow-y-auto`. When the user picks **Assign to Agent** the body
   grows: an agent `Select` + the working-directory `InstancePicker` (one row per
   online `(host, cwd)` instance — multiple rows for multiple instances) + a pin
   note + a **Release** option (when already assigned). Enough content and the
   total height exceeds a short viewport.
2. **Because it is vertically centered**, once total height > viewport height the
   card overflows the **top and bottom edges simultaneously**: the title is
   clipped above the screen and the footer (`flex justify-end` Cancel/Assign in
   `px-6 py-6 border-t`) is pushed below it — with no scrollbar that can reach
   either. This is the "bottom buttons unreachable" symptom.
3. **(Secondary)** `w-[400px]` is a fixed pixel width, so on a 360px-wide viewport
   the card also overflows horizontally (there is no `max-w-[calc(100vw-2rem)]`
   fallback). A mobile soft keyboard further shortens the visible viewport, making
   the height symptom easier to trigger.

The body-growth driver is the shared `InstancePicker`
(`src/components/agent-presence/instance-picker.tsx`), a list that grows linearly
with the number of online instances and has no height ceiling of its own.

## What Changes

Per the resolved elaboration (decisions A / B / B):

- **(q1 = A) Centered card + capped height + internal scroll** — NOT full-screen.
  The modals stay centered cards on every viewport; desktop appearance is
  unchanged. A mobile-safe `max-height` (using `svh`/`dvh` dynamic viewport units,
  soft-keyboard safe) plus a scrollable body solves the overflow, rather than the
  `connections-modal.tsx` `h-dvh w-screen` full-screen approach.
- **(q2 = B) Extract a reusable mobile-safe dialog skeleton** — the structure
  "pinned Header + scrolling Body + pinned Footer + capped dynamic-viewport height
  + narrow-viewport width fallback" becomes one reusable component (a new
  `ScrollableDialog` family under `src/components/ui/`) with header / body / footer
  slots. It is used by these two assign modals now and is available for other
  modals later.
- **(q3 = B) Built on shadcn `Dialog`** — the skeleton wraps shadcn
  `DialogContent` (which already provides Esc / focus-trap / aria and a
  `max-w-[calc(100%-2rem)]` narrow-viewport fallback, also fixing symptom 3), in
  line with the CLAUDE.md "always use shadcn/ui" rule. The two hand-written cards
  drop their `fixed top-1/2 -translate-y-1/2` backdrop+card and adopt the skeleton.

This is a **pure UI / layout refactor**: all existing open/close wiring and the
assignment / instance-pin business logic are preserved verbatim — only the modal
shell and layout change.

### Call-site contract is preserved

All three call sites mount the modals conditionally
(`{showAssignModal && <AssignIdeaModal onClose={…} />}`) with no `open` prop. The
skeleton therefore self-drives `open={true}` internally and maps
`onOpenChange(false)` (Esc / overlay / close button) to the existing `onClose`
callback, so the parents
(`ideas/idea-detail-panel.tsx`, `dashboard/panels/idea-detail-panel.tsx`,
`dashboard/panels/basic-view.tsx`, `tasks/task-detail-panel.tsx`) need **no
changes**.

## Capabilities

- **assign-modal-mobile-layout** — adds normative requirements that (a) a reusable
  scrollable-dialog skeleton built on shadcn `Dialog` keeps its header and footer
  pinned and visible while only its body scrolls, within a dynamic-viewport height
  cap and a narrow-viewport width fallback; and (b) both the Assign Idea and Assign
  Task modals adopt it so their title and Cancel / Assign controls remain visible
  and clickable on any viewport, with the body scrollable to any row, without
  changing assignment behavior.

## Impact

- Affected code (all frontend, no API / DB change):
  - New `ScrollableDialog` skeleton component under `src/components/ui/` (built on
    `@/components/ui/dialog`) + its unit tests.
  - `src/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal.tsx` — adopts the
    skeleton; business logic unchanged.
  - `src/app/(dashboard)/projects/[uuid]/tasks/assign-task-modal.tsx` — adopts the
    skeleton; business logic unchanged.
- i18n: no new user-facing strings expected (the modals reuse their existing
  keys); if any incidental string is added it goes into both `messages/en.json`
  and `messages/zh.json`.
- `docs/design.pen`: update the two assign-modal screens to the new
  pinned-header/footer + scrolling-body layout (per the design-update convention).
- Out of scope: the comment-area `@`-mention picker `MentionInstancePickerDialog`
  (that is the separate idea `d3f31086`, slug `fix-mention-cwd-picker-mobile-overflow`);
  the generic `src/components/assign-modal.tsx` (already mobile-safe); any change to
  assignment, instance-pin, or wake business logic.
