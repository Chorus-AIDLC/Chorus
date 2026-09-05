# Paginate the daemon session/conversation list

## Why

Opening the daemon chat modal is slow, and the slowness grows with the number of
conversations. The user confirmed (idea 460ea0d5 elaboration) that the pain is the
**load time of the conversation-history list**, not front-end rendering — "只有网络问题，没有性能问题".

The root cause is that `GET /api/daemon-sessions` returns **every** visible session at
once, with no `take`/`limit`:

- `getVisibleSessions` runs `prisma.daemonSession.findMany({ orderBy: lastTurnAt desc })`
  over the caller's whole history, then a read-time orphan-turn reconcile pass over that
  full set.
- `getVisibleSessionsWithOrigin` then enriches **every** row: one connection-liveness
  query, one earliest-`human_instruction`-per-session query, and one idea-title query —
  all scaling with total session count.
- The chat client fetches this full payload on open **and re-fetches it every 15s**, then
  throws most of it away (it slices to 12 rows for the one selected agent).

At 20–100 conversations (the user's range) this is a large, latency-heavy payload the
UI does not need. The front-end already paginates client-side; the fix is to stop
sending the whole list over the wire.

## What Changes

Add **opt-in, backward-compatible** server-side pagination to `GET /api/daemon-sessions`,
matched to the client's existing agent-first UI (one agent's conversations shown at a
time, newest-first):

1. **Agent-index mode** (`?view=agents`) — a cheap `GROUP BY agentUuid` returning, per
   agent that has session history, its `agentUuid`, most-recent `lastTurnAt`, and
   `sessionCount`. No transcript, no per-row enrichment, no reconcile. Drives the left-pane
   agent Select and the default-agent selection without loading any conversation rows.

2. **Per-agent page mode** (`?agentUuid=<uuid>&limit=<n>&before=<cursor>`) — one page of
   that agent's conversations, newest-first, keyset-paginated by a stable `(lastTurnAt, uuid)`
   cursor, returning `{ sessions, nextCursor, hasMore }`. Origin-online + naming enrichment
   and the orphan-turn reconcile run **only over the returned page**, not the whole history.

3. **Legacy full-list mode** (no query params) — response is **byte-identical** to today
   (`{ sessions: [...all] }`), so `connections-view` and the send box's targeting picker are
   unaffected. Pagination is purely additive.

4. **Client rewire** (daemon chat modal only) — the modal fetches the agent index for its
   Select + default agent, then fetches per-agent pages on selection and on "Load more"
   (server-driven cursor instead of a client-side slice). The 15s poll refetches only the
   selected agent's first page. Live merges (`handleSessionStarted`, SSE transcript events)
   operate on the loaded page as before.

## Capabilities

- `daemon-session-conversation` — ADDED: server-paginated visible-session list (agent-index
  mode, per-agent cursor page mode, legacy full-list preservation).

## Out of Scope (explicitly, per elaboration Q4/Q5)

- Front-end virtualization / windowing of the list or transcript.
- `React.memo` / render-pipeline changes, deferred Shiki/Mermaid highlighting.
- Transcript pagination — already message-paginated (20/page cursor + "load earlier");
  unchanged.

## Impact

- **Endpoint:** `GET /api/daemon-sessions` gains two opt-in query modes; default response
  unchanged.
- **Service:** `daemon-session.service.ts` (new paginated read + agent-index read),
  `daemon-instruction.service.ts` (`getVisibleSessionsWithOrigin` gains a paginated variant
  enriching only a page).
- **Client:** `daemon-chat.tsx` data layer + `conversation-list.tsx` "Load more" wiring.
- **Compat:** `connections-view` (test-only now) and the send box are unaffected — they use
  the no-param default.
- **Risk:** low — additive endpoint modes; existing callers keep the legacy shape.
