## Context

The aggregate code-review gateway is intentionally read-only. Its existing contract directs FAIL recovery through new tasks on the approved Proposal, but the handoff does not consistently name Quick Dev or define who creates and sizes those tasks. Quick Dev also needs a deterministic terminal path that depends on the current agent's permissions without weakening the normal development verification discipline.

## Goals / Non-Goals

**Goals:**

- Keep aggregate reviewers read-only and make the orchestrator own BLOCKER remediation.
- Preserve a traceable Proposal -> fix Task -> verification -> aggregate re-review chain.
- Minimize workflow overhead by grouping related small findings.
- Let an agent with `task:admin` finish verification autonomously while retaining AC self-verification and independent reviewer checks.
- Produce an actionable, asynchronous handoff when admin permission is absent.

**Non-Goals:**

- Changing Chorus permission semantics or adding API endpoints.
- Reopening completed tasks.
- Allowing the code reviewer to edit code or create remediation tasks itself.
- Skipping independent task review, aggregate re-review, or configured review-round limits.

## Decisions

### The orchestrator invokes Quick Dev after a FAIL verdict

The aggregate reviewer continues to emit a structured read-only verdict. The main/orchestrating agent parses the BLOCKERs and starts Quick Dev against the original approved Proposal. This preserves reviewer independence and places mutation with the workflow owner.

Alternative considered: let the reviewer create tasks directly. This was rejected because it expands a deliberately read-only role and couples review output to mutation permissions.

### Fix tasks remain on the original Proposal

Quick Dev creates new tasks attached to the Proposal that produced the aggregate change. Task descriptions carry the relevant BLOCKER findings and review-round context. Completed tasks are never reopened.

Alternative considered: create a separate Proposal or associate tasks only through comments. Both weaken the feature-level audit trail.

### Task granularity is judgment-based with an anti-fragmentation default

The orchestrator groups related small BLOCKERs from one review round into a cohesive task. It splits work only when the remediation is materially large or independently testable. This balances traceability against per-task workflow overhead.

### Permission determines only the final verification actor

Quick Dev always follows normal develop discipline: implement, self-verify acceptance criteria, submit for verification, and invoke the required independent task reviewer. After evidence is available, an agent with `task:admin` performs admin verification and continues automatically. Without that permission, it posts the evidence on the Task, @mentions the responsible human, and ends the turn.

Permission detection must use the active Chorus identity/check-in permissions rather than role names or assumptions.

### Aggregate code re-review is mandatory

After every fix task is successfully completed and admin-verified, the orchestrator re-runs the independent aggregate code reviewer. A failed or cancelled fix task stops the automatic loop and escalates the unresolved remediation instead of triggering re-review. Existing round limits remain authoritative; reaching the configured non-zero limit also escalates to a human.

## Risks / Trade-offs

- [Risk] Skill copies drift across plugin surfaces. -> Update canonical and port-specific copies together and run parity-oriented searches/tests.
- [Risk] Agents claim admin capability based on persona or role name. -> Require explicit inspection of `task:admin` in check-in permissions.
- [Risk] Autonomous verification becomes self-approval without independent scrutiny. -> State that AC self-verification and the independent task reviewer remain mandatory.
- [Risk] One grouped task becomes too broad. -> Allow splitting when fixes are materially large or independently testable.
- [Risk] Human handoff lacks enough context. -> Require verification evidence, remaining action, and an explicit @mention in the Task comment.

## Migration Plan

1. Update the aggregate code-review recovery guidance and all distributed reviewer/workflow copies.
2. Update Quick Dev copies with permission-aware terminal behavior.
3. Add or update documentation/contract tests for parity and required phrases.
4. Roll back by reverting skill documentation changes; no persisted data migration is required.

## Open Questions

None. Elaboration resolved task ownership, Proposal linkage, task granularity, verification discipline, handoff behavior, and mandatory re-review.
