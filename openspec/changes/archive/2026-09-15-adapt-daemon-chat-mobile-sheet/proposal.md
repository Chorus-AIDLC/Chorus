## Why

The Agent Daemon conversation currently becomes an edge-to-edge fullscreen dialog on phones, which makes opening and dismissing it feel abrupt and unlike the Tracker's established mobile Actions surface. A near-full-height bottom sheet keeps the conversation immersive while leaving a small, understandable dismissal area above it.

## What Changes

- Replace the Agent Daemon conversation's mobile fullscreen dialog with the existing bottom-sheet presentation used by the Idea Tracker Actions menu.
- Preserve the current `< sm` responsive breakpoint: mobile uses the sheet, while `sm` and wider viewports retain the existing floating dialog.
- Give the mobile sheet a fixed 16 CSS-pixel top gap, rounded top corners, backdrop dismissal, Escape/close-button dismissal, and the existing sheet entrance/exit motion.
- Add drag-to-dismiss from the sheet's top handle only; scrolling or swiping the conversation body does not drag the sheet.
- Preserve the current `DaemonChat` content, mobile drill-down, internal scrolling, focus management, accessibility title/description, and desktop layout.
- Verify the implemented surface in both light and dark themes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-session-transcript-read`: Replace the mobile fullscreen-modal requirement with a near-full-height, dismissible bottom-sheet contract while preserving the desktop dialog.

## Impact

- Frontend: `src/components/agent-presence/connections-modal.tsx` and its focused tests.
- Reuses the existing `src/components/ui/sheet.tsx` primitive and the same styling language as the mobile Idea Tracker Actions menu.
- No API, database, daemon runtime, permission, i18n, or dependency changes.
- Delivery: after all Chorus verification gates pass, create a PR targeting `develop`, wait for green CI, merge it, deploy the merged revision to production, and run post-deploy smoke verification. The Idea owner explicitly authorized these actions in the Idea discussion.
