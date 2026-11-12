# Verification: Pi submit gate warn receipt invalidation

Date: 2026-10-21. Base: `develop` at `531fd2eb`.
Task: `6612524d-b89e-44d6-9aa9-8cc8993eba8a`.

## Implementation

Only the runtime gate and its unit test file change. Both submit branches retain the verdict from the pre-attempt state, then consume receipts and advance mutation state before returning. The extension mode wiring, diagnostic strings, task missing-UUID behavior, and public API remain unchanged.

Twelve new deterministic cases cover four initial receipt states (missing, stale, unacceptable, valid) for scoped tasks, scoped proposals, and unknown-UUID proposals. Scoped cases cover delayed reads, isolation from other objects, and one-shot fresh-read recovery. No successful submit result is needed for invalidation, including when block mode suppresses execution. Unknown-UUID cases cover pending validations with and without UUIDs and preserve task receipts.

## Executed checks

| Command | Result |
| --- | --- |
| `bun test packages/chorus-pi/test/submit-gate.test.ts` before runtime fix | 23 passed, 11 failed; both missing-receipt regressions observed the second submit returning `undefined` instead of a verdict |
| Same focused command after runtime fix | 34 passed, 0 failed, 144 assertions |
| `bun test packages/chorus-pi/test` | 328 passed, 1 skipped, 0 failed, 5019 assertions |
| `(cd packages/chorus-pi && bash test/all.sh)` | All offline tests passed, including static checks and isolated event tests; gate group: 42 passed, 0 failed |
| `node packages/chorus-pi/scripts/validate-package.mjs` | Passed (v0.22.2, 14 skills, 4 agents) |
| `git diff --check` | Passed |

The directory-level suite's existing optional pi-subagents public-normalization test was skipped; no failing test was hidden. The canonical `test/all.sh` command implements reviewer note N1 and runs isolated extension-event checks not covered by the directory command alone.

Temporary raw logs are `/tmp/pi-submit-gate-{red,green,directory,offline}.log`; this document records the durable results.

## Boundaries

This is offline state-machine and mocked extension-event evidence, not a live Pi/server ordering verification. Reads started after submit but processed earlier by the server remain the documented non-goal.

The pre-existing `src/lib/__tests__/install-local.test.ts` edit was not changed. Its SHA-256 before and after validation was `8458b466421c249af068c878cd39e9fc0000e907234a1899ff6c19c145d81be8`.

No version bump, commit, branch creation, push, or merge was performed.
