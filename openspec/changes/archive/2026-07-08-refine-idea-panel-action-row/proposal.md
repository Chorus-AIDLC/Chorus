## Why

On the dashboard idea-tracker detail panel, the footer's bottom-left **reassign**
control was reduced to an icon-only button in the last declutter pass (#406). As a
standalone icon it reads as clutter with weak affordance, and it crowds the footer
so the **Yolo** button also had to shrink to an icon-only shortcut. The panel already
shows the assignee (avatar + name + agent-instance line) in the elaboration tab, so
the natural place to trigger reassignment is that assignee block itself — freeing the
footer to let Yolo return to a full icon **+** label button.

## What Changes

- **Remove** the standalone reassign icon button from the footer action row of the
  dashboard idea-tracker detail panel (`dashboard/panels/idea-detail-panel.tsx`).
- **Make the existing assignee block clickable** (the `AssigneeSection` rendered in
  the elaboration tab) so clicking it opens the reassign modal (`AssignIdeaModal`),
  gated by the same `canAssign` predicate (`idea.status !== "elaborated"`): clickable
  while `open` / `elaborating`, read-only once `elaborated`.
- **Restore the Yolo button to icon + label** (rocket + "Yolo" text), dropping the
  tooltip that stood in for the hidden label, while keeping its purple styling and the
  confirm dialog. `YoloButton` is shared by both idea-detail panels, so this also
  restores the label on the `/ideas` panel — matching the intent that Yolo is no
  longer abbreviated anywhere.
- **Scope:** only the dashboard idea-tracker panel changes its reassign entry point;
  the `/ideas` panel keeps its own footer reassign button (per elaboration q1=b).

## Capabilities

### New Capabilities

- `idea-panel-action-row`: how the dashboard idea-tracker detail panel exposes the
  reassign entry point (on the assignee block, gated by editability) and how the Yolo
  stage-advance button is presented (icon + label, no tooltip).

### Modified Capabilities

<!-- none -->

## Impact

- **Code:**
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` —
    remove footer reassign button; pass an `onReassign` affordance down to the
    elaboration view / assignee section.
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/assignee-section.tsx` —
    make the block a clickable trigger (cursor-pointer + tooltip) when editable.
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/elaboration-view.tsx` —
    thread the reassign click + editability through to `AssigneeSection`.
  - `src/components/yolo-button.tsx` — icon + label, remove tooltip, keep confirm.
- **Shared component:** the `YoloButton` change is visible on both idea-detail panels.
- **i18n:** no new keys required (`common.reassign` / `common.assign`, `yolo.button`
  already exist).
- **Tests:** `src/components/__tests__/yolo-button.test.tsx` (label now rendered);
  panel/assignee-section interaction.
- **No API, schema, or data-model changes.**
