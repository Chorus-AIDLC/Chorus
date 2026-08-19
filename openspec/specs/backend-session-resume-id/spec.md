# backend-session-resume-id Specification

## Purpose
TBD - created by archiving change persist-codex-session-id. Update Purpose after archive.
## Requirements
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

### Requirement: Copy only a usable backend resume identifier
The conversation UI MUST preserve the existing session ID copy control without adding backend-specific labels or raw-ID display, and the control MUST copy a present backend resume identifier verbatim.

#### Scenario: Backend identifier is available
- **WHEN** a user views a conversation whose backend resume identifier is non-null
- **THEN** the existing session ID copy control remains visually and verbally unchanged and copies the backend identifier

#### Scenario: Backend identifier is unavailable
- **WHEN** a user views a conversation whose backend resume identifier is null
- **THEN** the header does not show a session ID copy action and does not fall back to the Chorus business key

#### Scenario: Backend identifier is not exposed as new UI
- **WHEN** a backend resume identifier is available
- **THEN** the header does not add a Codex label, raw identifier text, badge, or other visible element

### Requirement: Copied Codex identifier resumes the same conversation
For a Codex-backed conversation, the persisted backend session ID MUST be accepted by the installed Codex CLI's `codex exec resume` command and identify the same thread.

#### Scenario: User resumes from the copied ID
- **WHEN** the user runs `codex exec resume <copied-id>` in the session's working directory
- **THEN** Codex resumes the same thread represented by the Chorus conversation

### Requirement: Claude Code sessions report a usable resume identifier
The Claude Code daemon backend MUST report, through the existing authenticated turn
lifecycle channel, the resume identifier that its own `--resume` command accepts,
so that the conversation UI's session-id copy control appears for Claude Code
conversations exactly as it does for Codex. The reported identifier MUST be the
session's Claude `--resume` anchor.

#### Scenario: Claude Code session reports its resume anchor
- **WHEN** a Claude Code daemon session completes a turn
- **THEN** the daemon reports the session's Claude `--resume` anchor as the backend resume identifier, and the server stores it as the session's backend resume identifier

#### Scenario: Copy control appears for a Claude Code session with a stored identifier
- **WHEN** a user views a Claude Code conversation whose stored backend resume identifier is non-null
- **THEN** the existing session-id copy control is shown and copies that identifier verbatim

### Requirement: Copied Claude identifier resumes the same conversation
For a Claude Code-backed conversation, the persisted backend resume identifier MUST
be accepted by the installed Claude Code CLI's `--resume` option in the session's
working directory and identify the same conversation the Chorus session tracks.

#### Scenario: User resumes a Claude conversation from the copied id
- **WHEN** the user runs `claude --resume <copied-id>` in the session's working directory
- **THEN** Claude Code resumes the same conversation represented by the Chorus session

