## ADDED Requirements

### Requirement: Deterministic Claude session conflicts receive one bounded resume fallback

When a Claude wake launched with `--session-id` returns the deterministic session-conflict classification, the daemon MUST retry that wake exactly once with `--resume` using the same session anchor, cwd, prompt, MCP configuration, and transcript callback. The retry MUST track its live child for interrupt handling without repeating the turn's pending-to-running lifecycle transition. No fallback is permitted for an unclassified failure or for a conflict returned by the fallback itself.

#### Scenario: Resume fallback succeeds

- **WHEN** a new-session Claude launch reports that its session ID is already in use and the one-time `--resume` retry exits cleanly
- **THEN** the daemon MUST complete the wake from the retry result without reporting a crash

#### Scenario: Resume fallback also fails

- **WHEN** a new-session Claude launch reports that its session ID is already in use and the one-time `--resume` retry also fails
- **THEN** the daemon MUST record the final interrupted outcome and MUST NOT spawn a third attempt in that recovery cycle

#### Scenario: Ordinary crash receives no fallback

- **WHEN** Claude exits non-zero without the deterministic session-conflict classification
- **THEN** the daemon MUST preserve the existing crash-reporting behavior and MUST NOT issue the one-time resume fallback

### Requirement: Exhausted deterministic conflicts do not enter automatic redispatch loops

After the one-time resume fallback for a session conflict is exhausted, the daemon MUST suppress subsequent synthetic automatic crash resumes for the same direct session/entity key in that daemon process. It MUST emit a visible diagnostic when suppressing a wake. A fresh human instruction for that key MUST clear the guard and permit a new bounded recovery cycle. The guard MUST NOT affect other sessions, user-interrupt resumes, or unrelated crash types.

#### Scenario: Automatic crash resume is suppressed after exhaustion

- **WHEN** the resume fallback has failed for a deterministic session conflict and an automatic crash resume is redispatched for the same key
- **THEN** the daemon MUST log the suppression and MUST NOT spawn another Claude process

#### Scenario: Fresh human instruction permits recovery

- **WHEN** a session key is guarded after an exhausted deterministic conflict and a fresh human instruction arrives for that key
- **THEN** the daemon MUST clear the guard and permit one new bounded recovery cycle

#### Scenario: Other sessions remain unaffected

- **WHEN** one session key is guarded after an exhausted deterministic conflict
- **THEN** wakes and resume behavior for every other session key MUST continue unchanged
