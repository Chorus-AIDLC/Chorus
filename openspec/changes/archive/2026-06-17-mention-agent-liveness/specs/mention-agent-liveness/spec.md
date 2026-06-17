## ADDED Requirements

### Requirement: Mention search SHALL enrich agent candidates with online status

The mention search SHALL include, for each candidate of type `agent`, an `online`
boolean indicating whether that agent currently has at least one effectively-online
daemon connection. This applies to the mention search service (`searchMentionables`)
and both surfaces over it (`GET /api/mentionables` and `chorus_search_mentionables`).
"Effectively online" SHALL reuse the
daemon-connection registry's existing rule — the connection's `status` is `online`
AND `now - lastSeenAt` is within the registry's `STALE_THRESHOLD_MS` — rather than
defining a separate threshold, so producer and consumer cannot drift. The online
determination SHALL be `companyUuid`-scoped and SHALL be computed in a single batch
query over the agent candidate set (no per-candidate query). Candidates of type
`user` SHALL NOT carry an `online` field. The field SHALL be additive — a consumer
that ignores it behaves exactly as before — and SHALL NOT require a new permission
bit or widen the existing owner-scoped visibility of agent candidates.

#### Scenario: An owned agent with a live connection is online

- **GIVEN** a user whose mention search returns an agent they own
- **AND** that agent has a `DaemonConnection` with `status = "online"` and a `lastSeenAt` within `STALE_THRESHOLD_MS`
- **WHEN** the mention search resolves the candidate list
- **THEN** that agent candidate MUST carry `online: true`

#### Scenario: An agent with no fresh connection is offline

- **GIVEN** an agent candidate whose only `DaemonConnection` is `offline`, or whose `lastSeenAt` is older than `STALE_THRESHOLD_MS`, or which has no connection at all
- **WHEN** the mention search resolves the candidate list
- **THEN** that agent candidate MUST carry `online: false`

#### Scenario: User candidates are not enriched

- **WHEN** the mention search returns a candidate of type `user`
- **THEN** that candidate MUST NOT carry an `online` field

#### Scenario: Online is resolved in batch, not per candidate

- **GIVEN** a mention search resolving N agent candidates
- **WHEN** their online status is determined
- **THEN** the server MUST resolve all N via a single batched, `companyUuid`-scoped connection query rather than one query per candidate
- **AND** when there are zero agent candidates it MUST issue no liveness query at all

### Requirement: Mention search SHALL report each agent's active execution count

The mention search SHALL include, for each candidate of type `agent`, an
`activeCount` integer giving the number of that agent's currently active daemon
executions — `DaemonExecution` rows whose `status` is `running` or `queued`. The
count SHALL be `companyUuid`-scoped and computed in a single batched aggregate over
the agent candidate set (no per-candidate query). `activeCount` SHALL be coherent
with `online`: an agent that is not `online` SHALL report `activeCount` of `0`, so
the count never contradicts the online indicator. Candidates of type `user` SHALL
NOT carry an `activeCount` field.

#### Scenario: An online agent reports its running/queued count

- **GIVEN** an online agent candidate whose daemon has 2 `running` and 1 `queued` `DaemonExecution` rows
- **WHEN** the mention search resolves the candidate list
- **THEN** that agent candidate MUST carry `activeCount: 3`

#### Scenario: An online agent with no active executions reports zero

- **GIVEN** an online agent candidate with no `running`/`queued` execution rows
- **WHEN** the mention search resolves the candidate list
- **THEN** that agent candidate MUST carry `activeCount: 0`

#### Scenario: An offline agent reports zero regardless of stale rows

- **GIVEN** an agent candidate that is not `online`
- **WHEN** the mention search resolves the candidate list
- **THEN** that agent candidate MUST carry `activeCount: 0`

#### Scenario: Active count is resolved in batch

- **GIVEN** a mention search resolving N agent candidates
- **WHEN** their active counts are determined
- **THEN** the server MUST resolve all N via a single batched, `companyUuid`-scoped aggregate query rather than one query per candidate

### Requirement: The @-mention dropdown SHALL render agent liveness and demote roles

The @-mention dropdown SHALL render, on each **agent** candidate row, a static
online indicator dot when the candidate's `online` is true, with an accessible
`Online`/`Offline` tooltip; an offline agent SHALL NOT render a dot. When the
candidate's `activeCount` is greater than zero the row SHALL render a compact count
badge; when `activeCount` is zero no badge SHALL be shown. The agent row SHALL no
longer render the agent's roles line (the online dot and count replace it). The dot
SHALL be static (no pulsing animation) to keep the dense dropdown calm. Rows for
`user` candidates SHALL be unchanged — no dot, no count. All new user-facing strings
(the `Online`/`Offline` tooltip and the count label) SHALL be localized in both
supported locales. The dropdown SHALL take the liveness values from the candidate
payload at open time and SHALL NOT poll while open.

#### Scenario: An online agent row shows a dot and (when busy) a count

- **GIVEN** the dropdown lists an agent candidate with `online: true` and `activeCount: 2`
- **WHEN** the row renders
- **THEN** it MUST show a static online dot with an `Online` tooltip
- **AND** it MUST show a count badge reflecting 2
- **AND** it MUST NOT show the agent's roles line

#### Scenario: An online idle agent shows a dot but no count badge

- **GIVEN** the dropdown lists an agent candidate with `online: true` and `activeCount: 0`
- **WHEN** the row renders
- **THEN** it MUST show the online dot
- **AND** it MUST NOT show a count badge

#### Scenario: An offline agent shows neither dot nor count

- **GIVEN** the dropdown lists an agent candidate with `online: false`
- **WHEN** the row renders
- **THEN** it MUST NOT show an online dot
- **AND** it MUST NOT show a count badge

#### Scenario: User rows are unaffected

- **WHEN** the dropdown renders a `user` candidate row
- **THEN** it MUST render as before (name and email) with no online dot and no count badge
