# Restore the Claude Code session resume id (unify Claude + Codex)

## Why

The daemon session chat UI has a "Copy session ID" control in the transcript
header. It renders **iff** the session's `backendSessionId` is non-null and copies
that value verbatim, so a human can resume the same conversation locally (e.g.
`claude --resume <id>` / `codex exec resume <id>`).

Today the button appears **only for Codex** conversations. It is missing for
**Claude Code** — a regression:

- Before PR #467 the control read `session.sessionId` (which, for Claude, *is* the
  `--resume` anchor — the daemon spawns with `--session-id <sessionId>` and owns the
  `<sessionId>.jsonl` transcript), so it showed for every backend.
- PR #467 (`fix(codex): persist resumable session id`) rewired the control to read
  `backendSessionId` to make Codex work — and, as a side effect, removed it for
  Claude Code, whose spawner never reports a `backendSessionId`.

The root cause is uniform: `backendSessionId` is populated only when a spawner
*returns* it on the terminal turn edge. Codex returns it; Claude does not. The
transport that carries it (waker → REST client → server persist, with an
idempotent/conflict guard) is already backend-agnostic.

## What Changes

Make the **Claude Code** daemon spawner report the resume identifier its own
`--resume` command accepts, so the existing copy control lights up for Claude
exactly as it does for Codex:

- **Claude Code** — the spawner reports `backendSessionId` = the session's Claude
  `--resume` anchor (the id the daemon itself resumes with) on terminal turns.
  This restores the pre-#467 behavior via the current `backendSessionId` path,
  with no UI fallback.
- **Codex** — unchanged (already reports its `thread_id`).
- **No UI change and no server change.** The transcript header, the
  `CopySessionIdButton` render gate (`backendSessionId` non-null), the copied
  value (bare id), and the persist path all stay exactly as they are. The button
  reappears purely because Claude now populates a usable `backendSessionId`.

### Kiro is explicitly out of scope (deferred to a follow-up idea)

The original elaboration asked to unify **all** backends including Kiro (idea
228f56b6, q1=c). Investigation during proposal review found the Kiro half is not a
simple spawner-return change: the daemon always runs `kiro-cli chat
--no-interactive`, and that mode does **not** persist a session to the Kiro CLI
store (live-verified in `cli/kiro-spawner.mjs`), so there is no captured resume id
to report and `--resume-id` cannot re-open the conversation. Making Kiro resumable
needs its own investigation (how to obtain a durable, resumable id from headless
kiro-cli) and is tracked as a **derived child idea**, not forced into this 0.16.1
patch.

Behavior confirmed by the elaboration on idea 228f56b6: copy the **bare id**
(q2=a), reuse the Claude anchor rather than change plumbing (q3=a — realized here
as the spawner reporting that anchor through the existing `backendSessionId`
channel, which keeps the shipped "no fallback to business key" spec intact), the
control's meaning is "copy a resumable id for local resume" (q4=a), and this ships
as a 0.16.1 patch (q5=a).

## Capabilities

- `backend-session-resume-id` — extend the existing capability from Codex-only to
  also cover the Claude Code backend.

## Impact

- **Code:** `cli/claude-spawner.mjs` (spawner `wake()` return shape only). No
  changes to the waker, REST client, server route, service, schema, or any React
  component.
- **Tests:** new spawner unit test asserting the terminal return carries
  `backendSessionId`; the existing waker/REST-client/UI tests already cover the
  downstream chain.
- **Docs:** OpenSpec delta spec for `backend-session-resume-id`.
- **No migration, no i18n, no design.pen change** (no new or modified screen; the
  control already exists and is unchanged — only the data feeding its render gate
  changes).
