# Move the offline hint next to Start Development / Yolo into a tooltip

## Why

On an idea-detail panel, the **Start Development** and **Yolo** stage-advance
buttons render a persistent inline line of explanatory text next to them
whenever the assigned agent (daemon) is offline — e.g. "The assigned agent is
offline — the button enables when it reconnects". This line always takes a full
row of horizontal space in the footer action row, wraps awkwardly on narrow
panels, and reads as visual clutter for what is a secondary, why-is-this-disabled
explanation.

The disabled button already communicates the primary signal ("you can't click
this right now"). The *reason* only needs to surface on demand. Moving it into a
hover / focus tooltip declutters the action row while keeping the explanation one
interaction away.

## What Changes

- The offline explanatory text (`offlineHint`) for both `StartDevelopmentButton`
  and `YoloButton` is no longer rendered as a persistent inline `<span>`. It
  moves into a shadcn/Radix tooltip that surfaces on hover or keyboard focus of
  the disabled button.
- Because a disabled `<button>` does not emit pointer events (so it cannot
  trigger a hover tooltip on its own), the button is wrapped in a focusable
  element that owns the tooltip trigger when the agent is offline.
- The offline copy is shortened to a single concise phrase, suitable for a
  tooltip, in **all** registered locales — `en`, `zh`, `ko`, `ja` (the repo
  registers four locales in `src/i18n/config.ts` and enforces key parity via
  `src/i18n/__tests__/locale-parity.test.ts`). Shortening only a subset would
  leave the other locales with the long sentence crammed into a tooltip (the
  very clutter this change removes) and break the parity guard.
- Scope is limited to the offline hint. The `startedHint` ("Development
  started…" / "Yolo started…") and other inline text stay exactly as they are.

## Capabilities

- `idea-panel-action-row` — ADDED requirement: the offline hint on the stage-advance
  buttons is presented as a tooltip, not persistent inline text.

## Impact

- Affected code: `src/components/start-development-button.tsx`,
  `src/components/yolo-button.tsx`, all four locale files (`messages/en.json`,
  `messages/zh.json`, `messages/ko.json`, `messages/ja.json`), and the two
  component test files.
- No server, service, API, or data-model change. Purely a client-side
  presentation refinement of an existing disabled-state hint.
- No change to the underlying stage-advance gating, offline policy, or the
  server-side error surfacing (`errorAgentOffline` toast is untouched).
