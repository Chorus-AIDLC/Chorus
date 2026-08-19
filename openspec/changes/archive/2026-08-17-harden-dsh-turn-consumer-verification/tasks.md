## 1. Consumer Lifecycle Verification

- [x] 1.1 Add extractor/hook unit coverage using dsh camelCase token fields for malformed non-object input, type mismatch, missing or non-object usage, and valid partial usage normalization without accidental settlement.
- [x] 1.2 Add deterministic dsh consumer-to-waker integration coverage for committed transcript upload, active Idea/session attribution, terminal-only usage, and sequential-wake isolation without a dsh usage map; pin fixtures to the canonical `daemon-dsh-backend` wire or reusable producer helpers.
- [x] 1.3 Run the focused dsh spawner/backend, transcript upload hook, waker lifecycle, turn-advance route, and daemon-session service test suites and record the passing evidence.
