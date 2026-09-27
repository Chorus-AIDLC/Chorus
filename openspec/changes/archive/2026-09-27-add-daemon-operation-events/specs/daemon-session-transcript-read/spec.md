## MODIFIED Requirements

### Requirement: Every turn keeps a positional slot so no turn band is dropped

The read projection SHALL give every turn at least one positional slot at
`(turn.seq, seq = 0)` in the unified message stream, so the message-level pager
never drops a turn band. This preserves the turn-level pager's guarantee that every
turn remains reachable — including a turn whose messages were all removed by the
rolling-window cap, which the old pager returned with an empty message list. The
slot behaves as follows:

- For a non-operation turn with a non-empty `promptText` (e.g. a historical `human_instruction` turn), the
  `seq = 0` slot SHALL carry a synthetic message with `role = "user"` and `text`
  equal to the promptText.
- For canonical `idea_creation_requested` and `research_requested` turns, the
  `seq = 0` slot SHALL reserve the band position without rendering the compatibility
  system prompt as a user message. The localized operation band provides context;
  retained real transcript messages SHALL still render normally.
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

- **WHEN** a non-operation turn has both a `promptText` and one or more stored `assistant`/`user`
  messages (`seq >= 1`)
- **THEN** the rebuilt turn band lists the synthetic promptText message first,
  followed by the real messages in ascending `seq`

#### Scenario: The positional slot is stable across an overlapping fetch

- **WHEN** a page that includes a turn's `seq = 0` slot is merged with another page
  or a live event that also references the same turn
- **THEN** the slot is de-duplicated by its stable uuid and is not rendered twice

#### Scenario: Canonical operation does not impersonate user input
- **WHEN** a canonical operation turn contains a nonempty compatibility promptText
- **THEN** its stable seq=0 slot counts toward pagination and preserves the localized turn band without displaying that prompt as a synthetic user message
- **AND** overlap merging, live updates and retained real messages preserve their existing cursor, order and deduplication behavior
