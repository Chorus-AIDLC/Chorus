## 1. Codex Headless Connection Diagnostics

- [x] 1.1 Reproduce and trace the duplicate SessionStart warning to its emission or rendering boundary, then update `CodexSpawner` and the affected hook/caller so the child receives the daemon's resolved URL and API key and equivalent warnings are scoped to one emission per startup.
- [x] 1.2 Add focused regression tests for complete credential propagation, secret exclusion from argv/logs, successful check-in without false warning, genuine missing configuration, connection failure, duplicate triggers in one startup, and warning reset across independent startups; run the relevant CLI and hook test suites.
