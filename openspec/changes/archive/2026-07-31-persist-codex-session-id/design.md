## Context

`DaemonSession.sessionId` is a stable Chorus business key. For idea conversations it is the direct Idea UUID; for ad-hoc conversations it is server-generated. Turn creation, transcript upload, execution matching, and control routing depend on this value.

Codex has a separate identity model. `codex exec --json` creates a thread and emits `{"type":"thread.started","thread_id":"..."}`. The daemon already captures this value and stores an anchor-to-thread mapping in `~/.chorus/codex-sessions.json` so later automated wakes can resume. The value never reaches the server, while the UI currently labels and copies `DaemonSession.sessionId` as though it were the backend resume ID.

## Goals / Non-Goals

**Goals:**

- Persist the actual Codex thread ID on the server as soon as a new Codex process reports it.
- Keep the existing Chorus session business key unchanged.
- Expose and copy only the backend-owned resume ID.
- Make synchronization idempotent and safe across repeated lifecycle reports.
- Cover transport, persistence, API projection, UI behavior, and Codex resume command construction with tests.

**Non-Goals:**

- Backfill backend IDs for sessions created before deployment.
- Add a UI action that launches `codex resume`.
- Replace the local anchor-to-thread map used by the daemon.
- Add backend-specific labels, raw-ID display, or other new UI elements.

## Decisions

### Store a separate nullable backend identifier

Add `DaemonSession.backendSessionId String?`. `sessionId` remains the immutable Chorus business key. This avoids breaking every existing route that resolves sessions by `(agentUuid, sessionId)` and makes the ownership of each identifier explicit.

Alternative considered: overwrite `sessionId` after Codex starts. Rejected because pending turns and daemon reports are already keyed by the Chorus value, and changing it would break routing and uniqueness assumptions.

### Report the ID through the existing turn-advance channel

Extend the daemon's turn-advance payload with optional `backendSessionId`. The Codex spawner result already returns the observed thread ID. The waker sends it on the terminal lifecycle report, where the server has the authenticated agent, connection, and Chorus session key needed to update the correct row.

The server accepts a bounded non-empty value and applies it idempotently. A null or omitted value leaves the field unchanged. If a non-null value already exists and a different value is reported, the service rejects the transition rather than silently changing the conversation's resume identity.

Alternative considered: add a dedicated endpoint. Rejected because it would duplicate authentication, connection ownership, and session resolution already present in turn-advance.

### Keep the local map authoritative for daemon automation

The existing `~/.chorus/codex-sessions.json` map remains the immediate source for the next local wake. Server persistence is for durable product state and user visibility, not a replacement for the daemon's local resume lookup in this scope.

### Gate the UI on availability

`SessionView` includes `backendSessionId: string | null`. The transcript header keeps the existing "Copy session ID" control's appearance, wording, and placement, but renders it only when the value exists and copies `backendSessionId` verbatim. It does not display a backend-specific label or raw ID. Historical sessions therefore do not expose a known-invalid fallback.

## Risks / Trade-offs

- [Terminal-only synchronization can be delayed until the first run exits] -> The UI remains without a copy action during that run, which is truthful; the ID appears after the session list/detail refresh.
- [A daemon crash before terminal reporting loses server synchronization] -> The local map still preserves automation continuity; a later successful wake reports the same ID.
- [A conflicting reported ID indicates local-map corruption or an unexpected backend reset] -> Reject the conflicting update and log/surface the lifecycle report failure rather than mutating identity.
- [Other agent backends have their own resume identifiers] -> Keep the field generic but only populate it from Codex in this change.

## Migration Plan

1. Add the nullable column with no backfill.
2. Deploy server support before or together with the daemon payload extension; omission remains backward-compatible.
3. Deploy the UI gate and copy behavior.
4. Rollback is safe because older code ignores the nullable column and newer daemons can omit the optional payload.

## Open Questions

None. Live Codex output and the existing spawner tests establish `thread.started.thread_id` as the resume identifier.
