## Why

The Idea Tracker sidebar spreads seven functional actions across header and footer, competing with the idea content. A single discoverable Actions entry reduces noise and provides a home for copying the idea link and UUID. The owner selected all seven scope decisions in elaboration and requested YOLO execution.

## What Changes

- Replace the Tracker header action cluster with an Actions dropdown plus independent Close; move Derive, Move, Edit, Verify Elaborate, Start Development, Yolo and Delete into it.
- Remove the action footer. Keep edit Save/Cancel inline in the edit form so editing remains usable.
- Add Copy link and Copy UUID with localized success/error feedback.
- Keep unavailable operations visible, disabled and explained; preserve business predicates, wake routing, theme restrictions and confirmations.
- Keep destructive Delete separated at the menu bottom.
- Verify keyboard, mobile, English/Chinese and light/dark behavior. The owner waived the Pencil design update on 2026-09-11.

## Capabilities

### New Capabilities
- `idea-tracker-actions-menu`: Unified action entry, availability explanations, clipboard utilities and accessible interactions.

### Modified Capabilities
- `idea-panel-action-row`: Allow the Tracker Yolo action to use a menu item while preserving its visible label and confirmation; standalone shared buttons retain their appearance.

## Impact

Main surface: `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx`. Shared start-development/yolo controls may gain a backwards-compatible rendering adapter to reuse their wake logic; default consumers remain unchanged. Locales and component tests are affected. No database, REST/MCP API, task/proposal panel, plugin, design artifact or dependency changes are intended.
