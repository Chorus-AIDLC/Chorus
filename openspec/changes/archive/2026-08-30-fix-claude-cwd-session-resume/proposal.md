## Why

Claude-backed daemon sessions currently infer new-versus-resume state by probing a cwd-derived transcript directory. The probe escapes only path separators and dots, while Claude Code also escapes spaces and non-ASCII characters, so a first wake succeeds but later wakes reuse `--session-id`, fail with “Session ID already in use,” and can enter a deterministic crash redispatch loop.

## What Changes

- Align the daemon's Claude transcript-directory escaping with the installed Claude Code behavior, including CJK and space-containing working directories while preserving existing ASCII results.
- Classify Claude's “Session ID already in use” response and retry the same wake exactly once with `--resume`.
- Stop automatic crash redispatch for that session if the one-time resume fallback also fails; a fresh human instruction can start a new recovery attempt.
- Add focused unit and orchestration coverage for CJK, spaces, unchanged ASCII paths, successful fallback, failed fallback, and loop suppression.
- Audit Codex and Kiro session discovery. Both already use backend-owned persisted session maps rather than Claude's cwd-to-transcript probe, so no analogous escaping change is required unless implementation-time verification finds a regression.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-spawner-interface`: Require Claude transcript discovery to match backend cwd escaping and expose a structured deterministic session-conflict outcome for bounded recovery.
- `daemon-interrupt-resume`: Require one-shot resume recovery and suppression of repeated automatic crash redispatch after a deterministic session conflict.

## Impact

- Affected modules: `cli/claude-spawner.mjs`, `cli/waker.mjs`, and their unit/integration tests; the control/router boundary may receive a narrow loop-suppression hook.
- No database, public HTTP API, dependency, Codex session-map, or Kiro session-map migration is expected.
- The implementation must verify the escaping rule against the installed Claude Code version before finalizing fixtures, particularly cross-platform behavior.
