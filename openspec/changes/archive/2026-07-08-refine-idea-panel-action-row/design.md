# Design — Refine idea-panel action row

## Context

Two twin idea-detail panels render the same stage-advance controls:

- **Dashboard idea-tracker panel** — `dashboard/panels/idea-detail-panel.tsx`. Tabbed
  (overview / elaboration / proposal / tasks / activity). The **assignee** is shown
  only inside the **elaboration** tab via `AssigneeSection`
  (`dashboard/panels/assignee-section.tsx`), rendered by `elaboration-view.tsx`. The
  footer has a bottom-left icon-only reassign button gated by
  `canAssign = idea.status !== "elaborated"`.
- **`/ideas` panel** — `ideas/idea-detail-panel.tsx`. Single-scroll; shows its own
  assignee block in the body and keeps its own footer reassign button.

Both panels render the shared `YoloButton` (`src/components/yolo-button.tsx`) and
`StartDevelopmentButton`. The last declutter pass (#406) turned both the footer
reassign button and the Yolo button into icon-only controls with tooltips.

This change touches **only the dashboard idea-tracker panel** for the reassign
relocation, plus the **shared** `YoloButton` (which surfaces on both panels).

## Goals / decisions (from elaboration round 1)

| # | Decision |
|---|----------|
| q1 scope | Only the dashboard idea-tracker panel changes its reassign entry point; `/ideas` panel untouched. |
| q2 placement | The assignee already displays in the elaboration tab (`AssigneeSection`); reuse it as the reassign trigger rather than adding a new block. |
| q3 affordance | Minimal discoverability: `cursor-pointer` + tooltip only. No hover-background, no hover pencil icon. |
| q4 gating | Keep the existing `canAssign` gating — assignee clickable while `open`/`elaborating`, read-only once `elaborated`. |
| q5 Yolo | Rocket icon + "Yolo" label; **drop** the tooltip; keep purple styling and the confirm (AlertDialog) step. |

## Change 1 — reassign moves onto the assignee block

`AssigneeSection` currently takes only `assignee`. Extend it with two optional props so
it can act as a reassign trigger without changing its default (read-only) behavior:

```ts
interface AssigneeSectionProps {
  assignee: { type; uuid; name; instance? } | null;
  onReassign?: () => void;   // when set AND editable, the block becomes a button
  editable?: boolean;        // false → render as today (non-interactive)
}
```

- When `onReassign` is set **and** `editable` is true: render the inner
  avatar+name+instance box as a `<button type="button">` wrapper with
  `cursor-pointer`, wrapped in a shadcn `Tooltip` whose content is
  `common.reassign` (assigned) / `common.assign` (unassigned), and an `aria-label` to
  match. Clicking calls `onReassign`. No hover-background or pencil icon (q3=b).
- Otherwise: render exactly as today (a plain `<div>`), so the `/ideas` panel and any
  read-only usage are unaffected.

`elaboration-view.tsx` gains matching optional props and forwards them to
`AssigneeSection`:

```ts
interface ElaborationViewProps {
  // ...existing
  onReassign?: () => void;
  canReassign?: boolean;
}
```

`idea-detail-panel.tsx` (dashboard):
- Compute `canAssign = idea ? idea.status !== "elaborated" : false` (already present).
- Pass `onReassign={() => setShowAssignModal(true)}` and `canReassign={canAssign}` into
  `<ElaborationView>`.
- **Remove** the footer `canAssign && (<TooltipProvider>…reassign icon Button…)` block
  entirely. The `AssignIdeaModal` mount + `showAssignModal` state stay (the trigger
  just moves).

Editability parity: the footer button used `canAssign` (`status !== "elaborated"`); the
assignee-block trigger uses the same predicate, so behavior is identical, only the
trigger location changes (q4=a).

## Change 2 — Yolo button icon + label

In `src/components/yolo-button.tsx`, the primary trigger is currently
`size="icon"` (h-8 w-8) wrapped in `TooltipProvider`/`Tooltip` with `aria-label` and a
`Rocket`-only child. Change to:

- Drop the `Tooltip`/`TooltipProvider`/`TooltipTrigger` wrappers and the tooltip import
  usage around the trigger (keep them only if still used elsewhere in the file — they
  are not).
- Render a normal `Button` (default size) with purple classes retained
  (`bg-[#7F5AF0] hover:bg-[#6D48DE] text-white`), child = `<Rocket className="mr-2 h-4 w-4" /> {t("button")}`.
- Keep `AlertDialogTrigger asChild` around that Button so the confirm dialog still
  fires; keep the whole AlertDialog confirm flow, disabled/offline logic, and the
  `started`/`offlineHint` states unchanged.

This mirrors `StartDevelopmentButton`'s icon+label shape, so the two primary
stage-advance CTAs look consistent. Because `YoloButton` is shared, the label returns
on the `/ideas` panel too — intended (q5, and the idea body says "no longer abbreviated").

## Non-goals

- No change to `/ideas` panel's footer reassign button.
- No change to `StartDevelopmentButton`, the assign modal, gating predicates, or any
  server action.
- No new i18n keys (`common.reassign`, `common.assign`, `yolo.button` already exist).

## Risks

- **Discoverability**: a bare cursor+tooltip is subtle. Accepted by q3=b (minimal). The
  tooltip + `aria-label` keep it accessible and self-documenting on hover/AT.
- **Shared Yolo component**: the label change is intentionally global across both
  panels; verified there is no third consumer that wanted icon-only.
- **Elaboration-tab-only reach**: on the dashboard panel the reassign trigger is only
  present on the elaboration tab (the only tab that renders the assignee). This is
  self-consistent — `open`/`elaborating` ideas default to that tab, which is exactly
  the editable window; once `elaborated` the block is read-only anyway.

## Verification

- `pnpm lint`, `npx tsc --noEmit`, `pnpm test` (yolo-button test updated for label).
- Manual e2e (Playwright): open a dashboard idea panel on an `elaborating` idea →
  elaboration tab → click assignee block → assign modal opens; footer no longer has the
  reassign icon; Yolo shows rocket + "Yolo".
- Update `docs/design.pen` for the modified panel footer + assignee affordance.
