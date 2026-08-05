## Why

The Proposal header repeats a large fixed working-directory card beside proposal actions even though the user does not choose or change the target there. Removing this one card reduces clutter without changing any other cwd surface or behavior.

## What Changes

- Remove the `FixedCwdAnchor` card from the Proposal header action area.
- Keep every other `FixedCwdAnchor` call site unchanged.
- Keep the shared component, Project Overview summary, Project Settings management, cwd pickers, and all fixed-target runtime behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-cwd-anchoring`: Make the Proposal header an explicit exception to the read-only anchor-summary requirement.

## Impact

- Changes only `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-actions.tsx`.
- Does not change shared components, other pages, APIs, persistence, daemon routing, or assignment semantics.
