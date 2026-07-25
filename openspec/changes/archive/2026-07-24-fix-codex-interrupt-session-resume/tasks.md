## 1. Thread Identity Durability

- [x] 1.1 Persist a fresh Codex anchor-to-thread mapping on the first valid identifier event, with exactly one write per fresh wake and no writes before thread establishment.
- [x] 1.2 Add focused CodexSpawner tests for interrupted/non-zero exits, exactly-once duplicate identifier handling, successful exits, missing identifiers, and best-effort write failures.

## 2. Resume Integration And Observability

- [x] 2.1 Align backend-neutral Waker lifecycle logging with the Codex spawner's actual map-based new/resume result.
- [x] 2.2 Add daemon integration regressions proving that a first turn interrupted after `thread.started` resumes the same thread on the next wake, a resumed known-thread wake can be interrupted and resumed again with the same ID, and persisted mapping survives a spawner/daemon restart.
- [x] 2.3 Run the focused CLI test suites and OpenSpec validation.
