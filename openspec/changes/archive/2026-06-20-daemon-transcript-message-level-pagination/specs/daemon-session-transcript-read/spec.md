# daemon-session-transcript-read Specification

## ADDED Requirements

### Requirement: Message-level transcript pagination with a composite cursor

The single-session transcript read SHALL paginate the conversation by **message**,
not by turn. `GET /api/daemon-sessions/{sessionUuid}` SHALL return at most
`DEFAULT_TRANSCRIPT_MESSAGE_PAGE` (default 20) messages per page, newest-first
windowed but returned in ascending render order, rebuilding the (possibly partial)
turn bands that own the page's messages. The endpoint SHALL accept an optional
composite cursor `beforeTurnSeq` + `beforeMsgSeq`; when supplied it SHALL return the
messages strictly older than that cursor under the ordering
`turn.seq DESC, message.seq DESC`, i.e. messages where
`turn.seq < beforeTurnSeq OR (turn.seq = beforeTurnSeq AND message.seq < beforeMsgSeq)`.
Omitting the cursor SHALL return the most recent page. The response SHALL report
`hasMore` (whether older messages exist before this page) and the next cursor as
`oldestTurnSeq` / `oldestMsgSeq` (the position of the oldest message in the page).
The page size SHALL be clamped to a sane range so a hostile `limit` cannot request
an unbounded scan. This message-level contract REPLACES the prior turn-level window
(`DEFAULT_TRANSCRIPT_TURN_PAGE`, single `beforeSeq` cursor); the turn-level
parameters SHALL NOT be retained in parallel.

#### Scenario: First page returns the newest messages

- **WHEN** a caller requests `GET /api/daemon-sessions/{sessionUuid}` with no cursor
  for a visible session that has more than `DEFAULT_TRANSCRIPT_MESSAGE_PAGE` messages
- **THEN** the response contains the newest `DEFAULT_TRANSCRIPT_MESSAGE_PAGE` messages,
  grouped into their turns ascending by turn `seq` and message `seq`
- **AND** `hasMore` is `true`
- **AND** the response carries `oldestTurnSeq` / `oldestMsgSeq` for the oldest message returned

#### Scenario: Load-earlier walks back by the composite cursor

- **WHEN** the caller requests the same session with
  `?beforeTurnSeq=<oldestTurnSeq>&beforeMsgSeq=<oldestMsgSeq>` from the previous page
- **THEN** the response contains only messages strictly older than that composite
  position (`turn.seq < beforeTurnSeq`, or equal turn with `message.seq < beforeMsgSeq`)
- **AND** no message from the previous page is repeated and none between the pages is skipped

#### Scenario: A page boundary falls inside a turn

- **WHEN** a single turn holds more messages than fit in one page
- **THEN** the turn appears as a partial band carrying only that page's messages,
  and a subsequent load-earlier returns the remaining older messages of the same turn
  merged into the same band

#### Scenario: hasMore is false at the start of the conversation

- **WHEN** the caller has paged back to the oldest retained message of the session
- **THEN** the response for the earliest page reports `hasMore` is `false`

### Requirement: Every turn keeps a positional slot so no turn band is dropped

The read projection SHALL give every turn at least one positional slot at
`(turn.seq, seq = 0)` in the unified message stream, so the message-level pager
never drops a turn band. This preserves the turn-level pager's guarantee that every
turn remains reachable — including a turn whose messages were all removed by the
rolling-window cap, which the old pager returned with an empty message list. The
slot behaves as follows:

- For a turn with a non-empty `promptText` (e.g. a `human_instruction` turn), the
  `seq = 0` slot SHALL carry a synthetic message with `role = "user"` and `text`
  equal to the promptText.
- For a turn with no `promptText` and no retained real messages (e.g. an autonomous
  `agent_wake` turn whose messages were all trimmed), the `seq = 0` slot SHALL still
  reserve the turn's place so the turn is returned as a band with an empty rendered
  message list — never silently dropped.

Each `seq = 0` slot SHALL carry a stable `uuid` derived from its turn so the
frontend's uuid-keyed merge de-duplicates it across pages, re-fetches, and live
events; SHALL sort ahead of the turn's real messages (which begin at `seq = 1`);
SHALL count toward the page size; and SHALL participate in the composite cursor
exactly like a real message. The slot SHALL exist only in the read projection — it
SHALL NOT be persisted and SHALL NOT require any schema or message-role change.

#### Scenario: A prompt-only turn is not skipped by the pager

- **WHEN** the page window reaches a `human_instruction` turn that has a `promptText`
  but no stored transcript messages
- **THEN** that turn appears in the result as a band whose only message is the
  synthetic `seq = 0`, `role = "user"` message carrying the promptText

#### Scenario: A message-less, prompt-less turn is still returned as an empty band

- **WHEN** the page window reaches a turn with `promptText = null` whose retained
  transcript messages were all removed by the rolling-window cap
- **THEN** that turn is still returned as a turn band (with an empty rendered message
  list), not silently dropped from the transcript
- **AND** it occupies exactly one position in the composite cursor sequence so paging
  does not stall or loop on it

#### Scenario: The synthetic message orders ahead of real messages in its turn

- **WHEN** a turn has both a `promptText` and one or more stored `assistant`/`user`
  messages (`seq >= 1`)
- **THEN** the rebuilt turn band lists the synthetic promptText message first,
  followed by the real messages in ascending `seq`

#### Scenario: The positional slot is stable across an overlapping fetch

- **WHEN** a page that includes a turn's `seq = 0` slot is merged with another page
  or a live event that also references the same turn
- **THEN** the slot is de-duplicated by its stable uuid and is not rendered twice
