## 1. Backend Session Identity

- [ ] 1.1 Add nullable backend session ID persistence and API projection with migration and service tests.
- [ ] 1.2 Extend daemon lifecycle reporting to send the observed Codex thread ID and enforce agent-scoped, idempotent, conflict-safe persistence.

## 2. User Experience And Verification

- [ ] 2.1 Keep the existing transcript-header copy control unchanged, make it copy only the backend session ID, and hide it when that ID is unavailable without adding visible UI.
- [ ] 2.2 Add focused daemon, API, service, and component regression tests, then validate the OpenSpec change and relevant suites.
