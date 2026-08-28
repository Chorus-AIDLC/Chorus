## Why

Nested themes currently aggregate direct-child statuses captured before child themes are rolled up. A completed child theme can therefore remain incomplete in its parent tracker card even though the detail panel reports the correct progress.

## What Changes

- Aggregate container Idea status from the leaves toward the roots so each parent sees every direct child's final derived status.
- Preserve `childProgress` as a count of direct children only.
- Keep the existing project-level batch query shape and perform lineage aggregation in memory.
- Detect malformed cyclic components, apply a uniform fallback to every cycle member, and bound aggregation so results are independent of input order.
- Add regression coverage for complete, partial, deeply nested, malformed, input-order permutation, and tracker/detail-consistency cases.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `container-idea`: Define recursive nested-theme status rollup while preserving direct-child progress semantics and safe bounded execution.

## Impact

- `src/services/idea.service.ts`: project-wide derived-status aggregation.
- `src/services/__tests__/idea.service.lineage.test.ts`: service-level nested lineage cases.
- `src/services/__tests__/idea-tracker.container.integration.test.ts`: tracker consistency coverage.
- No schema, API shape, or dependency changes.
