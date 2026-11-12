# Design: conservative submit-attempt invalidation

## Context

Source Idea: `26f743bf-eb92-4574-a4f2-204aad2e03bc`. Proposal: `3d38d9c5-1883-4156-9db8-64fe630ce2a1`.

Felix selected `conservative` in elaboration round 1 on 2026-10-21, confirming invalidation even when block mode prevents execution. The original implementation came from [PR #631](ref:62297e24-f0b7-4d26-b715-94aa323447d6).

The inspected checkout is now `develop` at `531fd2eb`, containing `submit-gate.ts`. `evaluateGate` increments a call sequence and records read-start sequences; `recordGateResult` drops results whose start precedes the applicable mutation. However, both submit branches return verdicts before updating mutation state. The extension calls the same evaluator for warn/block and skips it for off; warn only notifies, while block prevents execution.

## Goals / Non-goals

Goals: close every early-verdict bookkeeping bypass in the existing submit branches, preserve diagnostics based on the original state, and prove the defect and recovery with deterministic tests.

Non-goals: mode-aware mutation rollback, server execution ordering, cross-port changes, task missing-UUID policy changes, unrelated SIGINT tests, or a new gate architecture.

## Decisions

### Evaluate first, invalidate once, then return

Restructure each submit branch to retain a `GateVerdict | undefined` instead of returning early for failed checks. Preserve the existing condition priority and reason strings. After evaluating the original receipt/mutation state, run the branch's existing invalidation bookkeeping exactly once and return the retained verdict. Do not mutate before evaluation: that would make a valid receipt look stale and lose the existing diagnostic context.

- Task with UUID: delete `taskReceipts[uuid]`; set `taskMutation[uuid]` to the current sequence and submit tool. Preserve the existing missing-task-UUID early exit because no target is available and no task-wide fallback exists.
- Proposal with UUID: delete `proposalReceipts[uuid]`; set `proposalDraftMutation[uuid]` to the current sequence.
- Proposal without UUID: evaluate using the existing latest-receipt fallback, then clear all proposal receipts and set `anyDraftMutation` to the current sequence.

Do not clear pending reads globally. The current `recordGateResult` sequence comparisons already reject results spanning these mutations and preserve unrelated object reads.

### Keep the gate mode-agnostic

No changes are needed to `extensions/chorus.ts`: `off` bypasses evaluation, `warn` notifies and executes, and `block` rejects. A block attempt or failed submit still invalidates locally; this is the explicitly accepted conservative cost. We do not restore receipts from submit results.

### Test the complete verdict boundary

Use the existing Bun tests and manually ordered calls, without sleeps or real Chorus writes:

1. For task and proposal, start a read/validation after the relevant mutation, submit without a receipt and assert a verdict, then deliver the old successful result. A second submit must still return a verdict.
2. Cover pre-existing stale receipts and unacceptable receipts (`status != in_progress` / `valid:false`), asserting that each submit consumes the receipt and advances mutation even when a verdict is returned. Include a pending good read to prove it cannot replace that receipt after the submit.
3. For proposal submit without UUID, cover absent, stale, and invalid receipts as well as the existing valid path. Assert global proposal invalidation and rejection of in-flight validations predating that submit.
4. For a UUID-scoped submit, an unrelated object's pending read remains usable. A read/validation begun after the submit can authorize one further submit; that attempt consumes it again.
5. Retain existing success-path, diagnostics, mode, malformed input, and read-error tests. Diagnostics are derived from the pre-attempt state; a later retry may reasonably report a missing receipt instead of the consumed receipt's old error.

Verification commands:

```sh
bun test packages/chorus-pi/test/submit-gate.test.ts
bun test packages/chorus-pi/test
node packages/chorus-pi/scripts/validate-package.mjs
```

Record a red-before/green-after run for the new missing-receipt regressions. Broader unrelated failures are reported, not silently fixed. These tests are offline state-machine evidence, not live Pi/server ordering verification.

## Risks / Trade-offs

- Conservative block invalidation can require another read; accepted in elaboration.
- Incorrect ordering of mutation vs. verdict calculation could break diagnostics or reject valid receipts; preserve pre-state evaluation and cover both success and warning paths.
- Missing proposal UUID has intentionally global invalidation, unlike scoped submissions; test both to prevent accidental cross-object invalidation.
- A read started after a submit can still observe pre-submit server state; existing server checks remain the final authority.
- The existing uncommitted `src/lib/__tests__/install-local.test.ts` modification is unrelated and must remain untouched.

## Rollout / Rollback

No migration or configuration change. Ship through normal human-approved task verification and PR/release workflow; do not merge automatically. Rollback is reverting the focused runtime/test change, with no persistent state to repair because the gate state is session-local.

## Open Questions

None. Implementation remains gated on human proposal approval.
