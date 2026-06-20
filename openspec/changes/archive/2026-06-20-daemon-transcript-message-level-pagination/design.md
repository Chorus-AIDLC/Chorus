# Tech Design: Daemon transcript message-level pagination

## Context

`getSessionDetail(auth, sessionUuid, { limit?, beforeSeq? })` in
`src/services/daemon-session.service.ts` currently:

1. clamps `limit` to `[1, 200]` (default `DEFAULT_TRANSCRIPT_TURN_PAGE = 30`),
2. fetches the newest `limit + 1` **turns** (`orderBy seq desc`, `take limit + 1`)
   at/older than `beforeSeq`, using the extra row to compute `hasMore`,
3. batch-loads **all** retained messages of those turns in one query,
4. folds messages into turns, returns `{ session, turns, hasMore, oldestSeq }`
   ascending by turn `seq`.

The only caller is `src/components/agent-presence/chat/daemon-chat.tsx`
(first paint: no params; "load earlier": `?beforeSeq=turns[0].seq`). The route
`src/app/api/daemon-sessions/[sessionUuid]/route.ts` parses `?beforeSeq` + `?limit`.

Verified facts grounding the design:

- Real message `seq` starts at **1** within a turn (`appendTranscriptMessages`:
  `nextSeq = (last?.seq ?? 0) + 1`), so `seq = 0` is a free slot for a synthetic
  first message.
- `DaemonTranscriptMessage` has a per-turn `seq` (`@@index([turnUuid, seq])`) and a
  global autoincrement `id`; `DaemonSessionTurn` has a session-monotonic `seq`
  (`@@unique([sessionUuid, seq])`).
- The frontend already merges by **message uuid** (`mergeTurnPage`,
  `applyTranscriptEvent`) and renders ascending by turn `seq`, inserting turns in
  order — partial-turn bands already work.

## Goals / Non-Goals

**Goals**
- Page the transcript by message, not turn, so one large turn can't force a heavy
  first paint.
- Keep `human_instruction` (promptText-only) turns visible under the new cursor.
- Reuse the existing frontend merge + live-SSE machinery unchanged.
- No schema change, no migration.

**Non-Goals**
- Per-message truncation / lazy-expand of a single long message (separate idea).
- Changing the rolling-window cap `MAX_TRANSCRIPT_MESSAGES_PER_SESSION = 200`.
- Preserving the old turn-level `?beforeSeq` contract in parallel.

## Decisions

### D1 — Page size: 20 messages (`DEFAULT_TRANSCRIPT_MESSAGE_PAGE = 20`)

First paint and each "load earlier" return up to 20 messages. Smaller than the old
30-turn default because the unit is now a single (possibly multi-KB) message. Kept
as a named constant for later tuning. Still clamped to a sane range (`[1, 200]`).

### D2 — Composite cursor `(beforeTurnSeq, beforeMsgSeq)`

Two explicit query params (clearest semantics, independently testable) rather than
one encoded value or the message's global `id` (an implementation detail; and the
synthetic promptText message has no real `id`). The window predicate is:

```
turn.seq < beforeTurnSeq
  OR (turn.seq = beforeTurnSeq AND message.seq < beforeMsgSeq)
```

Omitting both params loads the newest page. The response returns the next cursor as
`oldestTurnSeq` / `oldestMsgSeq` (the `(turnSeq, msgSeq)` of the oldest message in
the page), plus `hasMore`.

### D3 — Every turn gets a positional `seq = 0` slot (generalizes the synthetic promptText)

The pager rebuilds bands only from windowed messages, so a turn with zero messages
in the window would vanish. The old turn-level pager always returned every turn,
including one whose messages were all trimmed by the rolling-window cap (empty
`messages[]`). To preserve that, the read projection gives **every** turn a
positional slot at `(turn.seq, seq = 0)` in the unified message stream:

- Turn with non-empty `promptText` → the slot is a synthetic *rendered* message:
  `role = "user"`, `text = turn.promptText`.
- Turn with `promptText = null` and no retained real messages (e.g. `agent_wake`
  whose messages were trimmed) → the slot is a *placeholder* that reserves the
  turn's position but contributes **no rendered message** (the band materializes
  with an empty rendered list).
- Turn with real messages and no promptText → the `seq = 0` placeholder still
  reserves the position; the rendered messages are the real `seq >= 1` ones.

Every slot carries `uuid = "synthetic:" + turnUuid` (stable, so the uuid-keyed
merge de-dupes across pages, re-fetches, and live events), `turnUuid = turn.uuid`,
`seq = 0`, `createdAt = turn.createdAt`. It is a **read/projection-layer** construct
only — never persisted, no schema/`role` change. It counts toward the page size and
participates in the composite cursor like any other message (a turn is reached "at
its seq = 0 slot" exactly once).

Implementation note: distinguish a *rendered* synthetic message (promptText case,
included in the turn's rendered `messages[]`) from a *placeholder* slot (counted for
paging/cursor, excluded from rendered `messages[]`). The simplest encoding is to
always include the slot in the paging stream but only emit it into the band's
rendered `messages[]` when it carries promptText text.

### D4 — Query strategy

Because messages belong to turns and we page across both, the cleanest correct
approach within the 200-message session cap (small N — performance is a non-issue):

1. Resolve the candidate window of turns: turns with `seq <= beforeTurnSeq` (or all
   turns when no cursor), ordered `seq desc`.
2. Build the unified message stream for those turns — real messages plus the
   synthetic `seq = 0` per promptText-bearing turn — ordered by `(turn.seq desc,
   msg.seq desc)`.
3. Apply the composite `before` predicate, take `limit + 1` to compute `hasMore`,
   then reverse to ascending.
4. Group the page's messages back into their turns (turn metadata via the existing
   `toTurnView`), producing `TurnWithMessagesView[]` ascending by turn `seq`, each
   carrying only the messages that fell in this page (partial turns are expected).

The synthetic message is generated in-memory from `turn.promptText`; the real
messages come from one batched `findMany` over the candidate turns (same shape as
today). The session cap bounds the candidate set, so loading candidate turns'
messages and slicing in memory is acceptable and keeps the composite-cursor +
synthetic-fold logic in one place (unit-testable with plain fixtures).

### D5 — Replace, don't dual-run, the old contract

`getSessionDetail`'s `{ limit, beforeSeq }` options become
`{ limit, beforeTurnSeq, beforeMsgSeq }`; `oldestSeq` becomes `oldestTurnSeq` +
`oldestMsgSeq`. The route parses the new params. The constant is renamed
`DEFAULT_TRANSCRIPT_TURN_PAGE → DEFAULT_TRANSCRIPT_MESSAGE_PAGE`. Existing service
tests for pagination are rewritten. No external API consumer exists (MCP does not
expose this route).

### D6 — Frontend cursor extraction (track the server-returned cursor)

`daemon-chat.tsx`:
- First paint: `GET /api/daemon-sessions/{uuid}` with no cursor params.
- `loadEarlier`: cursor = the **server-returned** `oldestTurnSeq` / `oldestMsgSeq`
  from the previously loaded page, passed as `?beforeTurnSeq=&beforeMsgSeq=`. The
  frontend tracks these in state alongside `hasMoreEarlier` rather than deriving the
  cursor from rendered messages — because an empty band (placeholder-only turn) has
  no rendered message to read a `seq` from, and the placeholder's `(turnSeq, 0)` is
  exactly what the server reports as the page's oldest position. This also removes
  the dependency on `turns[0].messages[0]`.
- `setHasMoreEarlier(Boolean(data.hasMore))` unchanged; `mergeTurnPage` /
  `applyTranscriptEvent` unchanged (still uuid-keyed). The merge must tolerate a
  turn arriving with an empty rendered `messages[]` (already supported — live
  `turn_created` materializes `messages: []`).

## Risks / Trade-offs

- **Cursor off-by-one across the turn boundary.** The strict `<` on both `turnSeq`
  and `msgSeq` with the `OR` predicate must not skip or re-emit the boundary
  message. Covered by a dedicated service test crossing a turn boundary mid-page.
- **Synthetic message uuid collision.** `synthetic:{turnUuid}` is unique per turn
  and disjoint from real message uuids; merge de-dupes by uuid. A test asserts a
  re-fetch/overlap doesn't double-render the synthetic message.
- **Live event interplay.** A `transcript_appended` arriving during a fetch is
  merged by uuid as today; the new cursor only affects the read window. A test
  asserts live append + paged load don't duplicate.

## Migration

None. Composite order derives from existing `turn.seq` + `message.seq`; the
synthetic message is computed at read time.
