# daemon-session-conversation — delta

## ADDED Requirements

### Requirement: Server-paginated visible session list

The `GET /api/daemon-sessions` endpoint SHALL support opt-in, backward-compatible
server-side pagination of the caller's visible daemon sessions, matched to the
agent-first chat UI. The endpoint SHALL expose three modes selected by query parameters,
and every mode SHALL enforce the same owner/self + company visibility fence as the
existing unpaginated read (an agent key sees only its own sessions; a user/super_admin sees
only sessions of agents they own; never cross-owner or cross-company).

#### Scenario: Legacy full-list mode is unchanged

- **WHEN** the endpoint is called with no pagination query parameters
- **THEN** it SHALL return `{ sessions }` containing every visible session, enriched with
  `originOnline` and naming fields, ordered by `lastTurnAt` descending — byte-identical in
  shape to the pre-change response
- **AND** non-chat callers (the connections view, the send-instruction targeting picker)
  SHALL continue to work without modification

#### Scenario: Agent-index mode

- **WHEN** the endpoint is called with `view=agents`
- **THEN** it SHALL return, for each agent that has at least one visible session, an entry
  carrying `agentUuid`, the agent's most recent session `lastTurnAt`, and its visible
  `sessionCount`
- **AND** it SHALL compute this with a single grouped aggregate, performing NO per-session
  origin/naming enrichment and NO orphan-turn reconcile
- **AND** the cost SHALL scale with the number of distinct agents, not the total session count

#### Scenario: Per-agent cursor page mode

- **WHEN** the endpoint is called with `agentUuid=<uuid>` and optional `limit` and `before`
- **THEN** it SHALL return `{ sessions, nextCursor, hasMore }` where `sessions` is one page of
  that agent's visible conversations ordered by `lastTurnAt` descending (ties broken by a
  stable secondary key), `nextCursor` is the cursor to pass as `before` for the next page (or
  `null` when none remain), and `hasMore` indicates whether older conversations exist
- **AND** `limit` SHALL default to the client page size and be clamped to a bounded range
- **AND** origin-online enrichment, naming enrichment, and the orphan-turn reconcile SHALL run
  only over the returned page, not the full history

#### Scenario: Per-agent page enforces visibility scope

- **WHEN** a caller requests `agentUuid` for an agent it may not see (an agent it does not own,
  or in another company)
- **THEN** the endpoint SHALL return an empty page rather than another owner's sessions, without
  disclosing whether that agent exists

### Requirement: Chat modal consumes the paginated session list

The daemon chat modal SHALL load its conversation list through the paginated endpoint so the
payload it fetches is bounded by what it displays, while preserving its agent-first behavior.

#### Scenario: Agent axis from the index

- **WHEN** the chat modal opens
- **THEN** it SHALL populate its agent Select and choose a default agent using the agent-index
  mode (unioned with the live connection list for currently-connected agents), without fetching
  any conversation rows for non-selected agents

#### Scenario: Per-agent page load and load-more

- **WHEN** an agent is selected in the chat modal
- **THEN** the modal SHALL fetch the first page of that agent's conversations from the per-agent
  page mode and render them newest-first
- **AND** the "Load more" control SHALL fetch the next page via the server cursor and append it,
  de-duplicated by session uuid, rather than slicing a fully-fetched client-side array

#### Scenario: Bounded background refresh

- **WHEN** the chat modal's periodic refresh runs
- **THEN** it SHALL refetch only the selected agent's first page (resettling online status and
  surfacing newly-started conversations at the top), not the caller's entire session history

#### Scenario: Live updates still merge

- **WHEN** a conversation is started or re-pointed, or a live transcript event arrives, while the
  chat modal is open
- **THEN** the modal SHALL merge it into the currently loaded page (prepend/patch/append) exactly
  as before, without requiring a full-list refetch
