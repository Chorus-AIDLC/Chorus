# Design — Restore the Claude Code session resume id

## Context

`DaemonSession` stores two ids (prisma `schema.prisma` → `DaemonSession`):

- `sessionId` — the Chorus routing/business key. For an idea-anchored session it is
  the `directIdeaUuid`; for an ad-hoc session a server-generated uuid. Unique per
  agent (`@@unique([agentUuid, sessionId])`).
- `backendSessionId` — "Backend-owned resume identity, distinct from Chorus's
  routing key" — nullable.

The transcript header control `CopySessionIdButton`
(`src/components/agent-presence/chat/transcript-view.tsx`) renders only when
`session.backendSessionId` is non-null and copies it verbatim. The governing spec
`openspec/specs/backend-session-resume-id/spec.md` explicitly forbids the UI from
falling back to the business key when `backendSessionId` is null (and a unit test,
`copy-session-id-button.test.tsx`, locks this in).

`backendSessionId` is populated through one already-generic path:

```
spawner.wake() → { …, backendSessionId }        (per backend)
  → waker.#advanceTurn(sessionId, "ended"|"interrupted", …, result.backendSessionId)
  → daemon-rest-client.turnAdvance({ …, backendSessionId })   // sent only on terminal edge
  → POST /api/daemon/turn-advance
  → daemon-session.service.advanceTurnForWake(...)            // first-write + idempotent/conflict guard
```

Only the **first hop** is backend-specific. Codex's spawner returns a
`backendSessionId` (its `thread_id`); Claude's does not — so its column stays null
and the button never shows. This is the entire root cause of the Claude regression.

## Goals / Non-goals

**Goals**
- Claude Code daemon sessions populate a usable `backendSessionId`, so the existing
  copy control appears for them exactly as it does for Codex.
- Do it through the one uniform mechanism (spawner reports the id its own resume
  command accepts); no special-casing in the UI, server, or transport.

**Non-goals**
- No change to what the button copies (still the bare id — elaboration q2=a).
- No change to the UI, render gate, server route, service, or schema.
- No "copy full resume command", transcript copy, or session fork (elaboration
  q2=a / q4=a explicitly scope those out).
- **Kiro is out of scope** — see "Kiro deferral" below.
- No backfill of historical sessions — the value is populated on the next terminal
  turn per session; pre-existing sessions with no report stay null (consistent with
  the "Historical session has no backend identifier" scenario already in the spec).

## Decisions

### D1 — Fix in the spawner return, not the UI

The elaboration answer q3=a ("reuse `sessionId`, only relax the display condition")
expresses the **intent**: for Claude the usable resume anchor *is* `sessionId`, so
don't invent a new value. But implementing that as a UI fallback
(`backendSessionId ?? sessionId`) is rejected: the shipped spec + unit test require
the header to **not** fall back to the business key, precisely because for Codex the
business key is a routing uuid that does **not** resume anything. A blind fallback
would resurrect a broken button for Codex sessions that legitimately have no
backend id yet.

Instead we realize q3=a's intent through the existing `backendSessionId` channel:
the Claude spawner **reports** its `--resume` anchor as `backendSessionId`. Net
effect for Claude is identical to "reuse sessionId" (the copied value equals
`session.sessionId`), but it flows through the one code path that is already
correct for every backend and keeps the "no fallback" invariant intact.

### D2 — Claude: report the `--resume` anchor (= the Chorus business key)

`cli/claude-spawner.mjs` spawns a **new** session with `--session-id <sessionId>`
and **resumes** with `--resume <sessionId>`; `isNewSession` probes the on-disk
transcript at `<configDir>/projects/<cwd>/<sessionId>.jsonl`. So the durable value
that `claude --resume <id>` accepts in that cwd is `sessionId` (the `id` argument),
and it is also the transcript filename. The spawner therefore reports:

```js
// terminal returns (close / error), mirroring the shape Codex uses:
resolve({ sessionId: observedSessionId, backendSessionId: id, exitCode: code, isNew });
```

- `id` is the input `sessionId`, already validated as a lowercase UUID by
  `isValidSessionId` before spawn — safe to persist.
- The stream-observed `session_id` (`observedSessionId`) is **not** used as the
  resume id: on a fork-on-resume Claude version it can differ from the anchor the
  daemon (and the `<sessionId>.jsonl` file) are keyed on, so `id` is the value that
  reliably resumes the conversation Chorus tracks. `observedSessionId` continues to
  populate the returned `sessionId` field unchanged (no behavior change there).
- For Claude, `backendSessionId === sessionId` by construction. That is expected —
  Claude's resume anchor genuinely *is* the value the daemon chose as the business
  key. The server's first-write/idempotent guard (`advanceTurnForWake` in
  `daemon-session.service.ts`) has no "must differ from the business key" check, so
  persisting an equal value is harmless.

### D3 — No downstream changes

The waker forwards `result.backendSessionId` on the terminal edge only
(`waker.#advanceTurn`, proven by `waker-turn-lifecycle.test.mjs`), the REST client
sends it only when `backendSessionId && isTerminal`, and the server persists it
with an idempotent/conflict guard. All three are backend-agnostic and already
tested. The UI already renders the button from `session.backendSessionId`. So the
diff is confined to one spawner file + its unit test.

### Kiro deferral

The elaboration (idea 228f56b6, q1=c) asked to cover Kiro too. During proposal
review this was found **not** to be a spawner-return change:
`cli/kiro-spawner.mjs` obtains a Kiro resume id by diffing the CLI session store
before/after a run, but the daemon always runs `kiro-cli chat --no-interactive`,
and that mode does **not** persist a session to the store (live-verified comment at
`kiro-spawner.mjs:361-368`). So on every headless run the diff finds zero new
sessions, the captured id is null, `backendSessionId` stays null, and the button
never appears — and even if reported, `--resume-id` could not re-open a
never-persisted conversation. Making Kiro resumable requires a separate
investigation (how to get a durable resumable id out of headless kiro-cli, or
whether kiro-cli must be invoked differently). Tracked as a derived child idea of
228f56b6; not in this patch.

## Risks / Trade-offs

- **Claude fork-on-resume**: some Claude Code versions emit a new `session_id` when
  resuming. Mitigation: we report the anchor `id`, not the observed stream id, so
  the copied value always matches the daemon's resume path and the on-disk
  transcript filename. (D2.)
- **First-turn latency**: `backendSessionId` is written on the terminal turn edge,
  so a brand-new session shows the button only after its first turn completes.
  This already matches Codex behavior; no regression.

## Migration

None. No schema change; the column already exists. No data backfill (by design —
see Non-goals). No i18n keys (label unchanged). No `design.pen` change (no new or
modified screen; the control already exists and its appearance is unchanged).
