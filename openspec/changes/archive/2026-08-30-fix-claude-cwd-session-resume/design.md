## Context

`Waker` resolves one cwd, calls `isNewSession(sessionId, cwd)`, and passes the resulting `isNew` decision to the selected backend spawner. Claude uses `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl` as the probe. The current `escapeCwd()` implementation replaces `/` and `.` on POSIX (plus Windows separators and `:`), but live Claude Code stores CJK and spaces as `-` too. The daemon therefore probes a directory that does not exist and repeatedly chooses `--session-id`.

Codex and Kiro do not rely on this probe for their authoritative decision. Their spawners declare the shared probe non-authoritative and use persisted `anchor → backend session id` maps, so the audit does not currently identify an analogous fix.

The selected elaboration policy is full defense: correct the probe, retry a recognized conflict once with `--resume`, then stop automatic redispatch if that fallback fails.

## Goals / Non-Goals

**Goals:**

- Make second and later Claude wakes resume from cwd values containing CJK characters or spaces.
- Preserve byte-identical escaping outcomes for existing ASCII path fixtures.
- Recover once from stale or imperfect transcript discovery without turning every non-zero Claude exit into a retry.
- Prevent a deterministic conflict from hammering the daemon after the fallback is exhausted.
- Keep backend-specific session discovery inside backend contracts and verify Codex/Kiro remain unaffected.

**Non-Goals:**

- Replacing Claude's on-disk transcript probe with a new persistent session database.
- Retrying arbitrary Claude failures or adding a general-purpose retry framework.
- Changing Codex or Kiro session identity unless the implementation audit finds an actual analogous defect.
- Claiming Windows compatibility without checking the installed Windows Claude Code layout.

## Decisions

### 1. Derive the escaped directory from Claude's observed rule

Update `escapeCwd()` so every character Claude normalizes in a project-directory key is replaced one-for-one with `-`. Before freezing the expression, compare representative ASCII, dot, hyphen, underscore, space, CJK, and (where available) Windows paths against the installed Claude Code project directories. Unit fixtures then become the compatibility contract.

This retains the stateless transcript probe and its daemon-restart behavior. Persisting a second Claude session map was rejected because it would duplicate Claude's own durable store and introduce migration/staleness concerns.

### 2. Return a structured conflict classification from the Claude spawner

The Claude spawner will retain a bounded stderr buffer for the current subprocess and classify only the established “Session ID … is already in use” signature. Its wake result will carry a backend-neutral optional failure classification while preserving existing `exitCode`, `sessionId`, `backendSessionId`, and `isNew` fields.

Structured classification is preferred over having `Waker` parse logs. The spawner owns backend stderr semantics, while `Waker` owns orchestration policy. Unrelated stderr and non-zero exits remain ordinary crashes.

### 3. Let Waker perform one fallback without duplicating turn lifecycle transitions

When the first Claude attempt was launched as new and returns the session-conflict classification, `Waker` will invoke the same spawner once more with `isNew: false`, the same prompt, cwd, MCP config, message callback, and session anchor.

The retry's child callback updates the execution registry so interrupt remains functional, but it does not repeat the already-completed pending-to-running turn transition. The fallback result becomes the authoritative result for terminal turn/execution reporting. No recursive retry path is allowed.

Keeping the retry in `Waker` preserves backend separation and makes the one-attempt budget explicit. Hiding a second subprocess entirely inside `ClaudeSpawner` was rejected because the shared `onChild` lifecycle contract must track the active retry child.

### 4. Suppress only repeated automatic crash resumes after fallback exhaustion

If the recognized conflict survives the one-time `--resume` fallback, `Waker` records a daemon-local terminal guard for the direct session/entity key. A subsequent synthetic crash resume for the same key is logged and discarded rather than spawned. A fresh human instruction clears the guard and permits one new recovery cycle; daemon restart also resets the in-memory guard, bounding any reconnect behavior to one cycle per process instead of a tight loop.

The guard is scoped to the deterministic signature. User interrupts, ordinary crashes, clean exits, and unrelated sessions retain existing behavior. This is preferred over global backoff because the selected policy is “resume once, then stop,” and over permanently blocking the session because a human must retain a recovery path.

### 5. Keep the backend audit testable

Implementation will verify that Codex and Kiro still declare the shared Claude probe non-authoritative and select resume state from their own persisted maps. If that invariant has changed by implementation time, the task expands to a compatible fix and regression test in the affected backend as authorized by elaboration.

## Risks / Trade-offs

- **Claude changes its private project-directory encoding again** → Keep observed fixtures and the stderr fallback; update the compatibility helper when a new live version is verified.
- **The stderr wording changes** → Match narrowly but case-insensitively around the stable session-id/in-use phrase and retain the corrected primary probe as the normal path.
- **A retry child is not registered for interrupt** → Reuse the execution-child update callback while gating the turn-running transition to the first successful spawn.
- **A false-positive terminal guard delays recovery** → Scope it to a classified conflict after a failed resume fallback and clear it on a fresh human instruction.
- **In-memory suppression resets on daemon restart** → This still prevents the observed tight same-process hammer; each restarted process remains bounded to one recovery cycle.

## Migration Plan

No data migration is required. Deploy the CLI change with tests, restart affected daemons, and verify a CJK/space cwd performs a fresh first wake followed by `--resume`. Rollback is a code rollback; existing Claude transcripts and backend session maps are unchanged.

## Open Questions

- What exact escaping expression does the installed Claude Code version use for underscore and astral Unicode on each supported platform? Resolve empirically during implementation and encode the findings as fixtures.
