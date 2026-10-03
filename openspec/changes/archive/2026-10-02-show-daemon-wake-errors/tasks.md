## 1. Server diagnostic contract

- [x] 1.1 Add WakeError validation, nullable turn JSON migration, persistence and read projection.
- [x] 1.2 Verify failure-only persistence, API limits, exact-turn retries and existing owner/admission fences.

## 2. Backend diagnostics

- [x] 2.1 Add bounded sanitized collection to Claude, Codex, Pi, Kiro and DSH failed wake results.
- [x] 2.2 Verify startup, structured terminal, warning-only success, signal and redaction cases.

## 3. Wake-report integration

- [x] 3.1 Carry diagnostics through Waker, turn-reporter and CLI REST reporting, including unstarted wakes and existing operation aborts.
- [x] 3.2 Carry the same diagnostic through OpenClaw daemon failures and preserve user-interrupt semantics.
- [x] 3.3 Verify coalescing, exact attribution and Claude conflict fallback.

## 4. Conversation diagnostics

- [x] 4.1 Add localized summary and accessible expandable details in the failed turn.
- [x] 4.2 Verify empty/partial replies, historical fallback, all four registered locales and both themes.

## 5. Integration acceptance

- [x] 5.1 Run converged module tests, type checking, lint, locale parity and browser acceptance when available.
- [x] 5.2 Complete independent task/code review and prepare verified specs and the completion report for publication.

After verification, archive the change, mirror the emitted cumulative specs into
Chorus, and publish the Idea completion report. Pushing or merging a pull request
requires separate human approval.
