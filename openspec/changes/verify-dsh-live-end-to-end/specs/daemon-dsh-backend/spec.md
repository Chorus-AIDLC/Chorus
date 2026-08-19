## ADDED Requirements

### Requirement: Live dsh end-to-end acceptance
The dsh integration SHALL be accepted against a real external `dsh-jsonrpc-agent` and DeepSeek-backed model using an isolated Chorus workflow fixture. Acceptance MUST prove normal wake observability, committed transcript and per-wake usage attribution, Chorus-resource workflow continuity after daemon restart with a fresh native dsh session, and process-group interruption without post-terminal transcript or usage contamination. The evidence MUST be published in a redacted report that contains no provider credential, Chorus API key, authorization header, or secret-bearing environment value.

#### Scenario: A real dsh wake completes with observable transcript and usage
- **WHEN** an owner-started `chorus daemon --agent dsh` receives a wake for the isolated acceptance Idea and the real dsh runtime reaches idle
- **THEN** Chorus shows an online connection labeled `dsh`, committed user and assistant transcript for the correct Idea/session, and exactly one terminal normalized usage delta with source `dsh`

#### Scenario: Work continues after daemon restart through Chorus resources
- **WHEN** the daemon is stopped and restarted after one accepted fixture wake and a later wake targets the same fixture workflow
- **THEN** the later worker retrieves the current Idea/Proposal/Task state from its wake prompt and Chorus MCP resources, continues from the correct workflow boundary, and reports a new native dsh backend session identifier rather than claiming native session resume

#### Scenario: A live dsh wake is interrupted across UI and process boundaries
- **WHEN** a user interrupts a running acceptance wake during a controlled side-effect-free long operation
- **THEN** Chorus records the turn as user-interrupted, the dsh runtime process group and descendants exit within the configured escalation bound, and no later transcript or usage is attributed to that interrupted wake

#### Scenario: Acceptance evidence is auditable and secret-safe
- **WHEN** the live acceptance run is prepared for task verification
- **THEN** a report records redacted commands, environment categories, Chorus resource and turn identifiers, relevant UI/API or log observations, normalized usage, process evidence, and a pass/fail result for each path without exposing credentials or authorization material
