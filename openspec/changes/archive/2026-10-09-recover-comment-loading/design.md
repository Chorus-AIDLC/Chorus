# Design: recover comment loading

## Evidence and scope

The existing initial loader leaves loading true on rejection [1](ref:fe6283c3-94f6-4028-882e-3f06a1ff41d4). Next serializes ordinary Server Actions [2](ref:50c1dc4b-47fb-4e57-8edf-ab16b6346378). A bounded GET read removes that avoidable coupling and repairs the confirmed recovery defect regardless of the unconfirmed first production failure. Gateway/database observations remain hypotheses; do not tune them in this patch.

## Transport

Reuse GET `/api/comments?targetType=...&targetUuid=...&limit=10[&cursor=...]`. Keep `getAuthContext` and viewer `requireEntityAccess` before any comment or owner reads. Cursor mode enriches comments with `resolveAgentOwners` so switching transport preserves author UI. Offset mode and mutation actions remain unchanged. Reject invalid/non-finite/out-of-range cursor limits with a validation response; return cursor responses with no-store caching.

The client helper uses same-origin credentials, no-store, and AbortController. Its 15-second deadline covers fetch and body parsing. Race completion with cancellation/deadline so even a mock/non-cooperative transport cannot hold the caller indefinitely; clear timers/listeners and do not leak raw server errors, credentials, or comment text into logs. Validate the cursor response shape before returning it. Aborting the browser request does not promise database query cancellation.

## Component lifecycle

Initial/retry reads enter loading, clear the previous error, and always terminate in success or an existing localized error/retry state. A new target or unmount invalidates the read generation and cancels active controllers. New target state resets comments, cursor, counts, and deletion bookkeeping. Late obsolete responses cannot change the current target's data, counts, errors, or loading flags.

Older-page failures keep existing comments/cursor and present an explicit retry. Guard active reads synchronously to avoid duplicate IntersectionObserver requests. Realtime reads use the same bounded helper; coalesce overlapping refreshes, preserve loaded history and existing burst-sync semantics, and do not allow a stale refresh to undo a successful local mutation. Background failures keep visible data without unhandled rejections or automatic retry loops. Mutation Server Actions are not migrated.

## Validation

- Helper: success/encoding, malformed/HTTP errors, network rejection, pending headers/body timeout, cancellation, and cleanup.
- API: same-company viewer success with owner metadata, hidden/cross-company denial before service access, unauthorized, cursor validation, offset compatibility.
- Component: first read rejection and retry, pagination rejection/retry and duplicate triggers, target switch/unmount/late results, bounded realtime errors/coalescing, existing comment actions and burst merging.
- Browser: real local app, intercept GET to fail/delay, observe spinner exit and retry recovery without reopening, normal reads and pagination. Never claim this reproduces the original production trigger.

## Rollback and non-goals

Revert the transport/component patch to restore previous behavior; no migration. No production deployment, push/merge, new telemetry platform, automatic retry storms, or speculative infrastructure changes. Report unconfirmed production triggers as follow-ups.

## Local verification record

Verified in the real local app against a disposable PGlite database (`/tmp/chorus-comment-read.wyZATq`), not production. The pre-existing local database was not forced through its unrelated schema warnings. A local fixture has 12 comments.

- Intercepting comment GETs with HTTP 503/HTML exits the first-page spinner and exposes Retry; removing interception and clicking Retry renders 10 comments without reopening the panel.
- Holding GET requests without a response exposes Retry after the configured 15-second request budget (about 19.7 seconds from full-page navigation including other initial loads); Retry recovers 10 comments.
- Failing the older cursor request preserves all 10 visible comments; Retry recovers all 12.
- Light and dark screenshots were inspected: `.playwright-mcp/comment-read-error-{light,dark}.png` and `.playwright-mcp/comment-older-error-{light,dark}.png`. Retry UI uses existing localized messages and semantic tokens.
- Pencil MCP is not available (no resources/templates or Pencil tools). `docs/design.pen` was not modified by unsupported text editing; visual source synchronization is a documented tooling follow-up, not a claimed completed artifact.

These fault injections verify recovery and independent HTTP transport, not the original production initiating failure. The component serializes its own reads, remembers scroll demand during a realtime read, coalesces refresh demand, and drops a failed partial sync rather than losing already-loaded history.
