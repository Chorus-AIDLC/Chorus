## MODIFIED Requirements

### Requirement: Preserve distinct Chorus and backend session identities
The system MUST retain the existing Chorus daemon session business key for routing, MUST preserve the first observed backend-owned resume identifier separately as a nullable session value, and MUST store each wake's authoritative backend-owned identifier as a nullable value on its daemon turn.

#### Scenario: First turn reports its backend identifier
- **WHEN** a daemon's first turn emits a non-empty backend session identifier
- **THEN** the system persists that value on the turn as its authoritative backend identifier
- **AND** the system initializes the session's backend resume identifier to the same first-wake value without changing its Chorus business key

#### Scenario: Later turn reports a fresh backend identifier
- **WHEN** a later serialized turn on the same Chorus session emits a different non-empty backend session identifier
- **THEN** the system persists the fresh value on that later turn
- **AND** the system preserves the session's original first-wake backend identifier

#### Scenario: Historical session or turn has no backend identifier
- **WHEN** a daemon session or turn created before the feature has no corresponding backend identifier
- **THEN** the system leaves the value null and does not substitute the Chorus business key or backfill it from another row

### Requirement: Synchronize the Codex resume identifier through authenticated lifecycle reporting
The daemon MUST report its observed backend session identifier through the existing authenticated turn lifecycle channel, and the server MUST bind the identifier only to the reporting agent's resolved turn. The successful running transition MUST identify the resolved turn so later lifecycle reports and retries can correlate to that exact row. The first non-empty identifier bound to a turn MUST be immutable: an identical retry MUST succeed idempotently without repeating terminal side effects, while a different identifier for that same turn MUST be rejected. A later serialized turn on the same Chorus session MUST be allowed to bind a different identifier. The session-level backend identifier MUST remain the first observed value and MUST NOT make a later turn's fresh identifier conflict.

#### Scenario: Matching lifecycle report supplies an identifier
- **WHEN** an authenticated daemon reports a backend session ID for one of its resolved turns
- **THEN** the server stores the ID on that turn and returns it from daemon-session turn reads
- **AND** if the session has no backend identifier, the server initializes it to that first observed value

#### Scenario: The same identifier is reported again for one turn
- **WHEN** a correlated terminal lifecycle report is retried for a turn that already has the requested terminal status and backend session ID
- **THEN** the report succeeds idempotently without changing turn or session identity
- **AND** terminal side effects such as token-usage rollups are not applied again

#### Scenario: A conflicting identifier is reported for one turn
- **WHEN** a turn already has one backend session ID and a lifecycle report for that turn supplies a different non-empty ID
- **THEN** the server rejects the conflicting report without advancing the turn or overwriting either identifier

#### Scenario: A later serialized turn reports a fresh identifier
- **WHEN** turn 1 has bound backend ID A and a later serialized turn 2 reports backend ID B with its own correlated turn UUID after a daemon restart
- **THEN** turn 2 binds ID B and reaches its requested terminal state
- **AND** turn 1 retains ID A
- **AND** the session-level backend identifier remains A

#### Scenario: A retry arrives while a newer turn is running
- **WHEN** a correlated terminal report for completed turn 1 is retried while turn 2 on the same session is running
- **THEN** the server returns turn 1's idempotent success without binding its identifier to or advancing turn 2

#### Scenario: Another agent uses the same Chorus business key
- **WHEN** an authenticated daemon reports a backend session ID and another agent has a session with the same Chorus session ID
- **THEN** the server updates only the reporting agent's session and resolved turn and does not expose or mutate the other agent's rows
