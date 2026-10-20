## Why

PR #633 supplies acting identities to MCP and board task transitions, but detail-page verification and REST updates still omit them. Description edits also skip mention processing, and super-admin identities display as unknown.

## What Changes

- Forward authenticated actor context from remaining task-update entry points, including detail verification, REST PATCH, and detail field editing.
- Preserve the existing append-only mention notification behavior when editing descriptions.
- Resolve `super_admin` as `Admin` in individual and batch identity display paths without changing stored actor identity.
- Add focused regression tests and audit all production `updateTask` call sites; no new lint infrastructure.
- Do not backfill history, change authorization or task transitions, expose admin account data, or alter database schemas.

## Capabilities

### New Capabilities
- `task-actor-attribution`: authenticated task mutation attribution, description mention actor propagation, and consistent administrator display.

### Modified Capabilities
None. Existing task-edit UI/acceptance-criteria behavior remains unchanged.

## Impact

Task detail server actions, the single-task REST route, shared UUID identity resolution, and unit tests. Baseline is `f3bd92a2` (PR #633); no dependency or API-shape changes.

## Decisions

Felix selected P2 plus both P3 fixes, the `Admin` label, and focused tests plus a production call-site audit. YOLO authorization permits automatic proposal/task verification after independent reviews, but not PR push or merge.
