# Fix @mention cwd instance-picker dialog overflowing the mobile viewport

## Why

In the Idea Tracker's **Activity (动态)** tab → **Comments** area, on a **mobile**
viewport, a user who types `@` to wake an agent and then needs to pin the agent's
working directory (`cwd`) is shown the "Which working directory?" picker
(`MentionInstancePickerDialog` in `src/components/mention-editor.tsx`). Two reported
symptoms:

1. The picker popup appears occluded by the comment list and the comments/activity
   sub-tab switcher.
2. After choosing a `cwd`, the **Pin instance / 确定** button cannot be clicked.

**Root cause (reproduced live with Playwright on `develop`, injecting an agent with
several online instances):**

- The picker is a Radix `Dialog`. Its `DialogContent` carries only `sm:max-w-md` —
  **no `max-height` and no internal scroll** (`overflow-y: visible`,
  `max-height: none`). Radix centers it with `top-[50%] translate-y-[-50%]` against the
  **layout** viewport (`window.innerHeight`), which does not shrink when the mobile soft
  keyboard opens.
- On a keyboard-shortened viewport (measured 360×420) with an agent that has 8 online
  instances, the dialog measured **573 px tall** against a **420 px** viewport: the
  header clipped to `top = -76px` (above the fold) and the footer's **Pin instance
  button bottom = 429 px > 420 px** — pushed off-screen, with no internal scrollbar to
  reach it. That is exactly symptom (2); symptom (1) is the same dialog clipping past
  both viewport edges so it *looks* occluded.
- The `@mention` suggestion popup itself (the `z-[100]` list) was verified to render on
  top and remain clickable on mobile — it is **not** the defect. Raising z-index would
  not fix anything.

The fix is the smallest change that removes the overflow: give the picker dialog a
mobile-safe max-height in dynamic-viewport units (`svh`/`dvh`, which DO track the soft
keyboard — the repo already uses `h-dvh max-h-dvh` in `connections-modal.tsx` for the
same class of bug) and make the **instance list** the only scrolling region, so the
title and footer (Cancel / Pin instance) stay visible and tappable at any viewport
height and instance count.

## What Changes

- `MentionInstancePickerDialog` (`src/components/mention-editor.tsx`) constrains its
  `DialogContent` to a mobile-safe max-height using a dynamic-viewport unit and lays its
  body out as a flex column: a fixed header, a single `overflow-y-auto` scroll region
  wrapping the `InstancePicker` instance list, and a fixed footer that always shows the
  Cancel and Pin-instance buttons.
- No change to the `@mention` suggestion popup, to the shared `ui/dialog.tsx` primitive,
  or to the other `InstancePicker` consumers (`assign-task-modal`, `assign-idea-modal`),
  which embed the picker inline in their own already-scrollable modals and are
  unaffected.
- Behavior outside the overflow case is byte-for-byte unchanged: selection still enables
  the Pin button, Cancel still discards, single-instance auto-select and the 2+ picker
  trigger are untouched.

## Capabilities

- `daemon-cwd-instance-addressing` — adds a requirement that every instance-picker
  surface stays fully usable (header + footer reachable, list scrolls) regardless of
  viewport height, including when a mobile soft keyboard shrinks the visible viewport.

## Impact

- Affected code: `src/components/mention-editor.tsx` (the `MentionInstancePickerDialog`
  layout only).
- Affected tests: a unit/DOM test asserting the picker dialog applies a mobile-safe
  max-height + internal-scroll layout (header and footer outside the scroll region).
- No schema, API, or data migration. No i18n string changes (reuses existing
  `mentionInstance.*` keys).
- User-visible: on mobile, the cwd picker's title and Pin/Cancel buttons are always
  reachable; long instance lists scroll inside the dialog.
