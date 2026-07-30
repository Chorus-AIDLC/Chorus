## Why

Code-review BLOCKERs currently risk being fixed ad hoc, outside the task lifecycle, while Quick Dev can request human verification even when the executing agent has sufficient admin permission to complete the workflow. The workflow should preserve independent review and auditability while involving humans only when permissions or review limits require them.

## What Changes

- Require the orchestrating agent to route code-review BLOCKER fixes through Quick Dev tasks on the original approved Proposal.
- Let the orchestrator group related small BLOCKERs into one task and split only materially large fixes, avoiding task fragmentation.
- Require every BLOCKER fix task to complete the normal acceptance-criteria and independent-review workflow before aggregate code re-review.
- Make Quick Dev inspect the executing agent's `task:admin` permission and select either autonomous admin verification or an explicit human handoff.
- Require non-admin handoffs to post verification evidence and @mention the responsible human, then stop instead of polling.

## Capabilities

### New Capabilities

- `quick-dev-verification`: Permission-aware Quick Dev verification, independent task review, and human handoff behavior.

### Modified Capabilities

- `code-review-gateway`: Refine FAIL recovery to use orchestrator-created Quick Dev tasks linked to the original Proposal, with practical task grouping and mandatory re-review.

## Impact

- Affects Quick Dev and code-reviewer workflow instructions across supported plugin surfaces.
- Affects lifecycle guidance that handles aggregate code-review FAIL verdicts.
- Requires documentation parity checks across Claude Code, Codex, OpenClaw, Pi, and the standalone skill distribution where applicable.
- Does not require service APIs, database schema changes, or new permissions.
