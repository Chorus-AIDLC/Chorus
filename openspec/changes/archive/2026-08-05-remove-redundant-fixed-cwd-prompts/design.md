## Context

`ProposalActions` currently reads `fixedTarget` from `usePinThenWake` and renders a `FixedCwdAnchor` before the actions menu. The card is informational only and crowds the Proposal header. Other call sites use the same component in different workflows and are explicitly out of scope.

## Goals / Non-Goals

**Goals:**

- Remove the fixed-cwd card from the Proposal header.
- Preserve Proposal actions and pin-then-wake behavior.
- Keep all other UI and runtime behavior byte-for-byte unchanged where practical.

**Non-Goals:**

- Removing or editing `FixedCwdAnchor`.
- Changing Idea, Task, conversational entry, Project Overview, or Project Settings UI.
- Changing cwd selection, fixed-target resolution, persistence, wake, or resume behavior.

## Decisions

### Remove only the Proposal render path

Delete the `FixedCwdAnchor` import, stop destructuring the unused `fixedTarget`, and remove the conditional render in `ProposalActions`.

Alternative considered: remove every call site using the shared component. The latest human instruction explicitly rejects that broader scope.

### Keep the hook and shared component unchanged

`usePinThenWake` remains responsible for Proposal action routing. Only its unused presentation return value is no longer consumed in this component. The shared card remains available to all other callers.

Alternative considered: add a prop to hide the card. The card is rendered directly by `ProposalActions`, so a new abstraction would add complexity without value.

## Risks / Trade-offs

- [A broad cleanup could alter other pages] -> Limit the code diff to `proposal-actions.tsx` and assert other `FixedCwdAnchor` call sites still exist.
- [Removing `fixedTarget` could affect action routing] -> Remove only the destructured return value; leave the hook invocation and callbacks unchanged.

## Migration Plan

1. Apply the three-line Proposal-only cleanup.
2. Run focused lint/type/test checks and inspect the final diff for single-file scope.
3. Verify the Proposal header in a browser while confirming another fixed-cwd surface remains unchanged.

Rollback is a source revert; there is no data migration.

## Open Questions

None.
