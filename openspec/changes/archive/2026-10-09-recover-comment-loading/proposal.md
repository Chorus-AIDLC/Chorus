# Recover comment loading

## Why

Activity comments can remain on the first-page spinner after a rejected read because loading is only cleared after successful promise settlement. Reads also share Next.js's serial Server Action queue. Both mechanisms are confirmed locally; the original production transport/database trigger is not confirmed.

## What Changes

- Read comment pages using the existing authenticated GET API rather than Server Actions, with a 15-second browser deadline covering headers and body parsing.
- Provide recoverable first-page and older-page failures, preserving loaded history on pagination failures.
- Cancel obsolete reads and ignore stale results after retry, target change, or unmount; contain realtime read errors and overlapping refreshes.
- Preserve cursor pagination, owner attribution, project-viewer access checks, mutation actions, and offset API compatibility.
- Add regression tests and local browser fault-injection verification. No deployment, push, merge, database-pool tuning, or gateway changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `comment-pagination`: bounded cancellable HTTP reads, attribution parity, and recovery behavior.

## Impact

`UnifiedComments`, a browser read helper, GET `/api/comments` cursor responses, component/helper/API tests, and this spec. No schema or new dependency. Production root-cause uncertainty remains explicitly recorded rather than being presented as solved by local recovery tests.
