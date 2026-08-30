## 1. Claude Session Discovery and Recovery

- [x] 1.1 Verify Claude Code's project-directory encoding against the installed version, update `escapeCwd()` and its documentation, and add CJK, space, ASCII compatibility, transcript-path, and backend-audit regression tests.
- [x] 1.2 Add bounded stderr capture and structured session-conflict classification to the Claude spawner without changing unrelated exit behavior.
- [x] 1.3 Implement Waker's single `--resume` fallback with shared cwd/prompt/config callbacks, retry-child interrupt tracking, and exactly-once turn-running transition semantics.

## 2. Deterministic Loop Protection and Integration

- [x] 2.1 Add a per-session terminal guard that suppresses repeated synthetic crash resumes after fallback exhaustion, clears on fresh human instruction, and emits visible diagnostics.
- [x] 2.2 Add orchestration/integration tests proving successful fallback, failed-fallback terminal behavior, no third spawn, guard isolation, guard clearing, and unchanged ordinary crash/user-resume behavior.
- [x] 2.3 Run focused CLI tests plus the broader daemon test suite and document the verified Claude version and Codex/Kiro audit outcome in code comments or test fixtures.
