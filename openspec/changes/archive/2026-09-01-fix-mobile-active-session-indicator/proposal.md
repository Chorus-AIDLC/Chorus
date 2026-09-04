## Why

The Idea Tracker active-session indicator no longer opens its Agent chooser when tapped on
mobile, so users cannot reach an active conversation when an Idea has multiple sessions. The
same entry should also avoid an unnecessary one-item chooser whenever its only session is
actionable.

## What Changes

- Make the active-session indicator's multi-session chooser open reliably from touch/click as
  well as hover and keyboard focus.
- When exactly one active session is actionable, activate the existing exact-session chat handoff
  directly on both mobile and desktop without rendering the chooser.
- Keep multiple sessions selectable through the existing Popover and keep non-actionable
  other-user sessions visible as status-only entries.
- Continue hiding the indicator when an Idea has no active sessions.
- Add interaction regression coverage using realistic pointer/tap sequences, while preserving
  parent Idea-card and graph-canvas event isolation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `idea-daemon-activity`: Clarify deterministic touch/click behavior for the active-session
  indicator while preserving single-session direct navigation and multi-session selection.

## Impact

- Frontend component: `src/components/active-session-indicator.tsx`.
- Frontend tests: `src/components/__tests__/active-session-indicator.test.tsx`.
- Existing consumers in Tracker rows, the Idea detail sidebar, and the project graph keep the same
  props and exact-session chat callback.
- No API, persistence, permission, dependency, i18n, or data-model changes.
