## ADDED Requirements

### Requirement: Preserve distinct Chorus and backend session identities
The system MUST retain the existing Chorus daemon session business key for routing and MUST store a backend-owned resume identifier separately as a nullable value.

#### Scenario: New Codex session reports its thread ID
- **WHEN** a Codex daemon session emits a non-empty `thread.started.thread_id`
- **THEN** the system persists that value as the session's backend resume identifier without changing its Chorus business key

#### Scenario: Historical session has no backend identifier
- **WHEN** a daemon session created before the feature has no backend resume identifier
- **THEN** the system leaves the value null and does not substitute the Chorus business key

### Requirement: Synchronize the Codex resume identifier through authenticated lifecycle reporting
The daemon MUST report the observed Codex thread ID through the existing authenticated turn lifecycle channel, and the server MUST update only the reporting agent's matching session.

#### Scenario: Matching lifecycle report supplies an identifier
- **WHEN** an authenticated daemon reports a backend session ID for one of its sessions
- **THEN** the server stores the ID on that session and returns it from daemon-session reads

#### Scenario: The same identifier is reported again
- **WHEN** a later lifecycle report supplies the same backend session ID
- **THEN** the update succeeds idempotently without changing session identity

#### Scenario: A conflicting identifier is reported
- **WHEN** a session already has one backend session ID and a lifecycle report supplies a different non-empty ID
- **THEN** the server rejects the conflicting report and preserves the original value

#### Scenario: Another agent uses the same Chorus business key
- **WHEN** an authenticated daemon reports a backend session ID and another agent has a session with the same Chorus session ID
- **THEN** the server updates only the reporting agent's session and does not expose or mutate the other agent's session

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
