## 1. Typed Assignment Provenance

- [x] 1.1 Add nullable `assignedByType` fields for Idea and Task with a DDL-only migration; classify legacy user/agent UUIDs through company-scoped read-time inference without changing stored rows, assignees, or lifecycle state.
- [x] 1.2 Thread typed provenance through Idea/Task service contracts and every explicit assignment/reassignment entry point; keep agent self-claim null and clear both fields on release.
- [x] 1.3 Update single and batch response formatting to resolve typed assigners dynamically, including null-type legacy compatibility and agent-instance assignees.
- [x] 1.4 Add focused schema, service, API, MCP, formatter, fixture, and regression tests for user assignment, agent dispatch, self-claim, reassignment, release, and legacy rows.

## 2. Wake Attribution And Handoff Protocol

- [x] 2.1 Add one company-scoped direct-resource orchestrator resolver and enrich Idea/Task notification details plus synthetic resume-control payloads without parent/root-Idea traversal.
- [x] 2.2 Extend daemon notification typing and `cli/prompts.mjs` composition so every non-null Idea/Task wake and resume appends the exact agent-orchestrator mention while preserving event-actor and headless guidance.
- [x] 2.3 Add server transport and daemon prompt tests covering all wake actions, resume parity, user/no/deleted assigners, actor separation, non-Idea/Task entities, and null-body preservation.
- [x] 2.4 Update the canonical Chorus workflow skills and all shipped ports with the human-gate/completion handoff rule, then run the repository's plugin/skill parity checks.
- [x] 2.5 Run the affected unit and integration suites plus OpenSpec validation, and document any intentionally deferred liveness, lineage, or theme-Yolo behavior.
