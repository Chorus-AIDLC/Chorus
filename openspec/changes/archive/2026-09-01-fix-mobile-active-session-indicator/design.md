## Context

`ActiveSessionIndicator` is shared by Tracker rows, the Idea detail sidebar, and graph nodes. It
uses a controlled Radix Popover while also manually opening it from pointer-enter, focus, and
click handlers. The click handler always prevents the trigger's default behavior and forces the
controlled state open. That overlap is fragile for touch sequences, where pointer and click
events are synthesized differently from the mouse-only events covered by current tests.

The existing `onSelect` contract already opens the exact daemon session, including the mobile
transcript drill-down. The data source already removes the indicator at zero sessions and marks
sessions that cannot be opened with `canOpen: false`.

## Goals / Non-Goals

**Goals:**

- Give touch/click one deterministic activation path for a multi-session chooser.
- Route one actionable session directly through the existing exact-session callback on every
  viewport.
- Preserve hover discovery, keyboard access, status-only entries, and event isolation.
- Cover the browser-like pointer sequence that exposed the mobile regression.

**Non-Goals:**

- Replacing Popover with a mobile-only Bottom Sheet.
- Changing chat routing, session authorization, presence data, or Agent ordering.
- Making another user's status-only session actionable.
- Changing visuals, translations, APIs, or persistence.

## Decisions

### 1. Separate direct activation from chooser activation

When there is exactly one session and it is actionable, the trigger will invoke `onSelect`
directly and will not depend on Popover state. Every other non-empty case uses the chooser:
multiple sessions need selection, while a sole non-actionable session still needs status
disclosure.

This keeps the user's one-Agent shortcut independent of input modality and avoids briefly
mounting an unnecessary one-row Popover.

### 2. Let Radix own click/tap state for chooser cases

The chooser trigger will preserve propagation isolation but will not unconditionally suppress
Radix's native click/tap toggle and then reimplement it with `setOpen(true)`. Controlled
`onOpenChange` remains the single state bridge. Hover opening is retained for mouse-like pointers
only; touch pointers rely on the click/tap contract. Keyboard focus continues to open the chooser.

This uses the component library's tested trigger semantics and removes competing state transitions
from one touch gesture.

### 3. Test complete pointer gestures

Regression tests will use `userEvent.pointer` or an equivalent pointer-down/up/click sequence for
mobile-like touch activation instead of a click-only shortcut. Assertions cover chooser
visibility, selection, direct single-session navigation, parent-click isolation, and unchanged
status-only behavior.

## Risks / Trade-offs

- **Hover and click can still occur in one mouse gesture.** Mouse-only hover handling remains
  idempotent with controlled `onOpenChange`; tests retain the existing hover-open/click behavior.
- **Radix/jsdom pointer behavior can differ from a real browser.** Use realistic Testing Library
  pointer sequences and retain a focused browser acceptance check at a mobile viewport.
- **Conditional direct rendering can drift in accessibility attributes.** Keep the same Button,
  label, disabled semantics, and keyboard activation contract; assert them in component tests.

## Migration Plan

This is a frontend-only backward-compatible component change. Deploy normally and roll back the
component/test commit if the shared graph or sidebar entry regresses.

## Open Questions

None. Elaboration resolved the zero-, one-, and multi-session behaviors and confirmed that the
single-session shortcut applies on all devices.
