# Daemon transcript: message-level pagination

## Why

The daemon conversation modal's right-pane transcript paginates in **turns**: the
first paint loads the latest `DEFAULT_TRANSCRIPT_TURN_PAGE = 30` turns and "load
earlier" walks back by `turn.seq`. But a single turn is one agent wake/execution
and can carry many multi-KB `user`/`assistant` messages, so the page unit is too
coarse — even one turn can be a heavy payload, and 30 of them can blow the first
paint up to hundreds of KB. Shrinking the turn count (a smaller `limit`) only
masks the problem: the worst case is still "one enormous turn".

The fix is to make the page unit a **message**, not a turn. The data model already
supports it: `DaemonTranscriptMessage` is its own table (one row per message), each
message carries a per-turn `seq` and each turn a session-monotonic `seq`, so the
composite `(turn.seq, message.seq)` order is exactly the top-to-bottom render order
— a natural message-level cursor with **no schema change and no migration**.

## What Changes

- **Read window becomes message-level.** `getSessionDetail` returns the newest
  `DEFAULT_TRANSCRIPT_MESSAGE_PAGE = 20` *messages* at/older than a composite
  cursor, rebuilds the (possibly partial) turn bands that own those messages, and
  reports `hasMore` + the next cursor. The turn-level `DEFAULT_TRANSCRIPT_TURN_PAGE`
  / `?beforeSeq` contract is **replaced**, not kept in parallel (no external
  consumer — the only caller is this repo's `daemon-chat.tsx`).
- **Composite cursor on the wire.** `GET /api/daemon-sessions/{uuid}` accepts
  `?beforeTurnSeq=<T>&beforeMsgSeq=<M>`; the service filters
  `turn.seq < T OR (turn.seq = T AND message.seq < M)`. The response carries the
  next cursor as `oldestTurnSeq` / `oldestMsgSeq`.
- **Every turn keeps a positional slot so no band is dropped.** Because the pager
  rebuilds bands only from windowed messages, the read projection gives every turn a
  `(turn.seq, seq = 0)` slot in the message stream. For a `human_instruction` turn
  that slot is a synthetic `role = "user"` message carrying the `promptText` (real
  messages start at `seq = 1`); for a prompt-less turn whose messages were all
  trimmed by the rolling-window cap, the slot is a placeholder that reserves the
  turn's position so it still returns as an empty band (matching the old turn-pager,
  which never dropped such turns). Each slot carries a stable `uuid`
  (`synthetic:{turnUuid}`) for uuid-keyed de-dupe, counts toward the page size, and
  participates in the cursor. The slot is read-only — never persisted, no schema
  change.
- **Frontend cursor extraction.** First paint and "load earlier" track the
  **server-returned** `oldestTurnSeq` / `oldestMsgSeq` cursor rather than deriving it
  from `turns[0].seq` (an empty placeholder band has no rendered message to read a
  `seq` from); everything else (the uuid-keyed `mergeTurnPage` /
  `applyTranscriptEvent`, partial-turn bands, live SSE) is unchanged and only gains
  targeted tests.

## Capabilities

- `daemon-session-transcript-read` (MODIFIED) — the single-session read API's
  pagination contract changes from turn-window to message-window with a composite
  cursor and synthetic-promptText folding.

## Impact

- **Code:** `src/services/daemon-session.service.ts` (`getSessionDetail`, page
  constant, synthetic-message projection), `src/app/api/daemon-sessions/[sessionUuid]/route.ts`
  (query-param parsing), `src/components/agent-presence/chat/daemon-chat.tsx`
  (cursor extraction for first paint + `loadEarlier`).
- **Tests:** `src/services/__tests__/daemon-session.service.test.ts` (rewrite the
  pagination cases for message-window + composite cursor + synthetic promptText);
  frontend merge/partial-band tests.
- **No DB migration, no schema change** — composite order is computed from existing
  `turn.seq` + `message.seq`.
- **Out of scope:** per-message truncation / lazy-expand of a single very long
  message (orthogonal follow-up); the rolling-window cap
  `MAX_TRANSCRIPT_MESSAGES_PER_SESSION = 200` is untouched.
