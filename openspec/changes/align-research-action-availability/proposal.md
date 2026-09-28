## Why

Research currently lets users click while its assigned agent is offline and only
reports the server rejection afterward. YOLO already prevents that interaction.
In Idea 940b328e-1d43-4a43-8a41-21be5f1212f5 round 1, the user chose to fix
Research only and require assignment before clicking (research_only,
require_assignment). These answers supersede the initial suggestion to retain
the unassigned-agent chooser.

## What Changes

- Require an agent or agent-instance assignee and an effectively online connection
  belonging to that agent before Research can be triggered.
- Keep unavailable Research visible with localized, accessible assignment/offline
  explanations in the desktop dropdown and mobile action sheet.
- React to presence and assignment updates without requiring a page reload.
- Remove the unassigned-agent chooser from ResearchAction. Preserve cwd/instance
  selection for an already assigned agent when dispatch needs disambiguation.
- Preserve stage eligibility, submission protection, queued feedback, retries,
  and server checks for actual origin/instance/cwd availability.
- Update `docs/design.pen` through Pencil to reflect the Research disabled states
  and verify desktop/mobile explanations in both light and dark themes, as required
  by `CLAUDE.md`. Unavailable design or theme verification remains incomplete.

## Capabilities

### New Capabilities

- `research-action-availability`: client assignment and online prerequisites for
  the Research action, with responsive and keyboard-accessible explanations.

### Modified Capabilities

None. The existing lightweight-research requirement permits actionable
availability errors for missing assignments. The new capability specifies that
UI choice without changing server Research contracts.

## Impact

Primary code: `src/components/research-action.tsx`, its Tracker menu integration,
Research translations in `messages/en.json` and `messages/zh.json`, and focused
component/menu regressions. No migrations or changes to Verify/Resolve, YOLO,
daemon execution, or service authorization. The existing standalone agent picker
and server selection API need not be deleted as part of this UI fix.

Evidence: the originating Idea holds source references for ResearchAction,
YoloButton, ResearchAgentPicker, server dispatch, and Verify. The proposal also
attaches the existing YOLO and Research server source references.
