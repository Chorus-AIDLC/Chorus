# daemon-execution-state

## ADDED Requirements

### Requirement: Ad-hoc conversation executions are visible

The execution-state model SHALL recognize `daemon_session` as a wake-triggering
entity kind, in addition to `task | idea | proposal | document`, so that an ad-hoc
(non-idea) conversation wake is reconciled into a `DaemonExecution` row rather than
being silently dropped. A reported `daemon_session` execution SHALL be validated
for existence against the `DaemonSession` table (company-scoped), not the
task/idea/proposal/document content tables. The ingest endpoint SHALL accept
`daemon_session` at its request boundary. In the execution surfaces (presence
popover, connections/chat views) a `daemon_session` execution SHALL be labeled as a
conversation rather than as an unknown resource, and SHALL NOT render a broken
resource deep link.

#### Scenario: Ad-hoc wake produces a running execution row

- **WHEN** a daemon reports an execution snapshot containing an entry with
  `entityType: "daemon_session"` and an `entityUuid` that resolves to an existing
  `DaemonSession` in the caller's company
- **THEN** the entry is reconciled into a `DaemonExecution` row (it is NOT dropped),
  and the conversation appears in the running/queued execution surfaces

#### Scenario: Non-existent daemon_session entry is dropped, not wedging the snapshot

- **WHEN** a snapshot entry has `entityType: "daemon_session"` but its `entityUuid`
  does not resolve to a `DaemonSession` in the caller's company
- **THEN** that entry is dropped (consistent with the existing dead-reference
  handling for the other entity kinds) while the rest of the snapshot still
  reconciles

#### Scenario: Conversation execution is labeled, not "unknown"

- **WHEN** a `daemon_session` execution is rendered in an execution surface
- **THEN** it is labeled as a conversation (a localized "Conversation" label), and
  no broken resource deep link is shown for it

#### Scenario: Existing entity kinds are unaffected

- **WHEN** a snapshot contains `task | idea | proposal | document` entries
- **THEN** they are validated and reconciled exactly as before (the
  `daemon_session` addition is additive and does not alter existing behavior)
