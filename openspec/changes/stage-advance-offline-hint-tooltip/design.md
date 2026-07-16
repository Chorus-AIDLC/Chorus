# Design: offline-hint tooltip for stage-advance buttons

## Context

`StartDevelopmentButton` and `YoloButton` (in `src/components/`) are shared
components rendered by both idea-detail panels (the `/ideas` route panel and the
dashboard idea-tracker panel). Each computes `agentOnline` from the client-side
agent-presence context and, when the assignee agent is offline, renders:

- the button in a `disabled` state, **and**
- a persistent inline `<span className="text-[11px] text-muted-foreground">`
  holding `t("offlineHint")`.

This change replaces that inline `<span>` with an on-demand tooltip.

## The disabled-trigger problem

A native disabled `<button>` receives no pointer events, so Radix's
`TooltipTrigger asChild` wrapping a disabled button never fires on hover. The
established fix (and the one the elaboration Q2=a answer selected) is to wrap the
button in a focusable, hover-receiving element and hang the tooltip trigger on
that wrapper instead of the button.

### Decision

When the agent is offline, wrap the (disabled) button in a `<span>` that:

- is the `TooltipTrigger asChild` target,
- carries `tabIndex={0}` so keyboard users can focus it and read the tooltip,
- uses `inline-flex` so it does not disturb the existing flex action-row layout.

When the agent is online there is no offline hint to show, so the button renders
without the tooltip wrapper (no behavior change to the enabled path).

The tooltip content is the shortened offline copy. `TooltipProvider` wraps the
tooltip locally in each component (mirroring the existing
`TooltipProvider delayDuration={300}` usage already present in the ideas
idea-detail panel), so the components remain self-contained and don't rely on an
ambient provider.

### Yolo button: nested `asChild` triggers

`StartDevelopmentButton` renders a bare `<Button>`, so wrapping it is
straightforward. `YoloButton` is different: its `<Button>` is already the child of
`AlertDialogTrigger asChild` (the confirm-dialog trigger). Stacking a
`TooltipTrigger asChild` directly onto the same button would make two Radix
primitives fight over the single child slot.

Because the offline state is *mutually exclusive* with the interactive state — an
offline Yolo button is disabled and clicking it never opens the dialog — the two
triggers never need to be active at once. The clean structure is:

- When **offline**: render the disabled button wrapped in the focusable
  `TooltipTrigger` span, and do NOT mount it as the `AlertDialogTrigger` (a
  disabled trigger opens nothing anyway). The tooltip surfaces the offline reason.
- When **online**: render exactly as today — the button as `AlertDialogTrigger
  asChild`, no tooltip wrapper.

This keeps each Radix primitive owning a single child and avoids nested-`asChild`
ambiguity, while preserving the existing confirm-dialog behavior on the online
path unchanged.

## Copy

`offlineHint` is shortened to a concise, tooltip-sized phrase in **all four**
registered locales. The repo registers `en`, `zh`, `ko`, `ja` in
`src/i18n/config.ts` and enforces key parity across them via
`src/i18n/__tests__/locale-parity.test.ts`; `offlineHint` currently exists in all
four (under both the `startDevelopment` and `yolo` namespaces) as the long
sentence. All four are shortened together — shortening a subset would leave the
rest with the long sentence squeezed into a tooltip (the clutter we are removing)
and, while key-parity would still pass (the key is present), it would defeat the
change's intent for those languages. The short forms:

- en: `Agent offline — enables on reconnect`
- zh: `Agent 离线，重连后可用`
- ko: `에이전트 오프라인 — 재연결 시 사용 가능`
- ja: `エージェントオフライン — 再接続で有効化`

The key name `offlineHint` is preserved (no key add/remove, so locale-parity is
unaffected); only the values change.

`errorAgentOffline` (the click-time server-rejection toast) is a different string
and is left unchanged — it is a full-sentence toast, not a tooltip.

## Scope guard

- Only `offlineHint` moves. `startedHint` and any other inline text are untouched
  (elaboration Q1=a).
- Button visible-but-disabled behavior is preserved (elaboration Q2=a); no info
  icon is added.
- No change to `canStartDevelopment` / `canRequestYolo` predicates, the presence
  computation, or the server actions.

## Testing

Both component test suites already assert the offline path via
`screen.getByText(/assigned agent is offline/i)`. Those assertions are updated to
match the tooltip mechanism:

- The persistent inline text is gone; instead the button is wrapped by a
  focusable tooltip trigger when offline.
- Radix renders `TooltipContent` into a portal only once the trigger is
  hovered/focused; in jsdom we assert the tooltip trigger wrapper exists and (on
  focus/hover) the shortened copy is reachable, rather than asserting a
  persistent inline node.
- The button's `disabled` state on the offline path is retained and still
  asserted.
- The online-path, click-behavior, and error-code-mapping tests are unaffected.

## Design.pen

This is a small refinement to an existing action-row control (hint text →
tooltip), not a new screen or component. The idea-detail panel action row is
already represented in `docs/design.pen`; this change does not add or restructure
screens. If a reviewer requires the `.pen` action-row annotation refreshed, that
is done via the Pencil MCP tools against the existing idea-detail-panel frame.
