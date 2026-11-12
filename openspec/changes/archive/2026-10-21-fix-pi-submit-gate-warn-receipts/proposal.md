# Pi submit gate: invalidate receipts on warned submissions

## Why

PR #631 introduced Pi's optional pre-submit read-back gate, but a submit verdict currently returns before receipt consumption and mutation bookkeeping. In `warn` mode the submit still executes, so an earlier in-flight read can arrive afterwards and incorrectly authorize another submit. See [PR #631](ref:62297e24-f0b7-4d26-b715-94aa323447d6).

## What Changes

- Compute the task/proposal verdict against the pre-submit state, then always consume the applicable receipts and record the submit attempt before returning that verdict.
- For proposal submission without a UUID, clear all proposal receipts and advance `anyDraftMutation`, including verdict-producing paths.
- Add deterministic task/proposal regressions for delayed pre-submit results, verdict paths, object isolation, and fresh-read recovery.
- Apply the conservative policy confirmed by Felix on 2026-10-21: blocked attempts also invalidate receipts; no execution-mode parameter or server-result tracking is introduced.

## Capabilities

### New Capabilities

- `pi-submit-gate`: Local submit-attempt invalidation and read-receipt freshness for Pi's optional task/proposal gate. This is a new specification for an existing runtime feature; no existing capability specifies its receipt lifecycle.

### Modified Capabilities

None.

## Impact

- Runtime: `packages/chorus-pi/lib/submit-gate.ts` only; preserve the public gate API and verdict diagnostics.
- Tests: `packages/chorus-pi/test/submit-gate.test.ts`; run the focused test and the Pi test directory plus package validation.
- No dependencies, schema/API migrations, mode defaults, plugin ports, or release/version changes.
- One atomic implementation task includes the fix and its regression tests. This proposal is not implementation approval.

## Non-goals

No fix for a read started after a submit but processed first by the server; server status checks remain authoritative. No changes to the unrelated SIGINT terminal-echo test, other plugin ports, native tool identification, or the existing task-submit-without-UUID behavior.
