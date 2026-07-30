## 1. Review Blocker Remediation

- [x] 1.1 Update the aggregate code-reviewer and lifecycle workflow guidance across supported plugin surfaces so the orchestrator creates appropriately grouped Quick Dev fix tasks on the original Proposal, re-runs aggregate review only after every fix task is successfully admin-verified, and escalates failed or cancelled fixes.
- [x] 1.2 Add or update contract tests and parity checks for reviewer read-only behavior, original-Proposal linkage, anti-fragmentation guidance, mandatory successful task verification, failed/cancelled escalation, and review-round limits.

## 2. Permission-Aware Quick Dev Verification

- [x] 2.1 Update Quick Dev across supported plugin surfaces to inspect explicit `task:admin` permission, preserve AC self-verification and independent task review, autonomously verify when authorized, and otherwise post an evidence-rich human handoff then end the turn.
- [x] 2.2 Add or update contract tests and parity checks for both permission branches, including headless non-blocking behavior and protection against role-name-based authorization.

## 3. Integration Verification

- [x] 3.1 Run the relevant plugin skill, hook, and parity test suites and verify the complete FAIL -> Quick Dev task -> task review -> permission-aware verification -> aggregate re-review flow.
