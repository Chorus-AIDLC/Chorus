## 1. Durable source identity and exact server admission
- [x] 1.1 Add nullable versioned wake context with single/batch notification persistence and capability-compatible pending delivery.
- [x] 1.2 Add exact ordinary/batch admission and tests for authorization, legacy data, read notifications and state identity.

## 2. CLI reliable routing and recovery
- [x] 2.1 Separate in-flight from accepted dedup, preserve exact identities and targeting, and await route outcomes.
- [x] 2.2 Add connection-scoped retry/reconciliation, deadlines, safe errors, generation/disposal guards and exact waker lifecycle.
- [x] 2.3 Verify queue coalescing, multiple agents/cwds, operations and legacy compatibility with isolated regression tests.

## 3. Cross-layer fault-injection acceptance
- [x] 3.1 Reproduce both incident shapes using fake transports and assert exact execution, lifecycle and transcript identities.
- [x] 3.2 Verify recovery with stable SSE, already-read context, request failure, shutdown and origin changes; document remaining network/deployment limitations.
- [x] 3.3 Record evidence and a deployment/runbook handoff without updating, restarting or replaying the live daemon.
