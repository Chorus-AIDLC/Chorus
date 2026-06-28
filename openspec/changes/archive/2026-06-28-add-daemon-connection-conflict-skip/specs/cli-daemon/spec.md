## ADDED Requirements

### Requirement: The daemon SHALL warn and permanently skip a path-connection the server reports as conflicting

When the server reports a `connection_conflict` event for one of the daemon's path-connections (a live daemon already holds the same `(agent, host, cwd)`), the daemon SHALL print a prominent WARNING that names the `host` and `cwd` and states that a live daemon already serves that path, SHALL tear down that path-connection's SSE listener (clearing any pending reconnect), and SHALL NOT reconnect or re-probe that path for the remaining lifetime of the process. The `connection_conflict` event SHALL be consumed before the wake-routing path so it can never be mistaken for a notification and can never spawn a subprocess. Takeover of a conflicting path SHALL occur only on a subsequent daemon start or restart, never via in-process background re-probe.

#### Scenario: A conflicting path is warned and dropped without retry

- **GIVEN** a daemon path-connection for cwd C receives a `connection_conflict` event from the server
- **WHEN** the daemon handles the event
- **THEN** it MUST emit a WARNING naming the host and cwd C and the reason (a live daemon already serves it)
- **AND** it MUST stop that path's SSE listener and MUST NOT schedule a reconnect or re-probe for cwd C for the life of the process

#### Scenario: A conflict event never reaches the wake path

- **WHEN** a `connection_conflict` event arrives on a path-connection's stream
- **THEN** it MUST be handled by the conflict path and MUST NOT be dispatched to the event router / wake queue
- **AND** no Claude/Codex subprocess MUST be spawned as a result of the conflict event

### Requirement: A daemon serving multiple paths SHALL skip only the conflicting paths and keep serving the rest

When a daemon serves multiple cwds and only some of them conflict with a live daemon, the daemon process SHALL continue running and SHALL keep serving its non-conflicting path-connections normally; only the conflicting paths SHALL be skipped. Each path-connection is independent, so a skip of one cwd SHALL NOT disrupt task dispatch or the reverse-control channel of another cwd's connection.

#### Scenario: Partial conflict leaves non-conflicting paths serving

- **GIVEN** a daemon declared to serve cwds C1 and C2, where C1 conflicts with a live daemon and C2 does not
- **WHEN** the daemon starts and the server reports a conflict for C1
- **THEN** the daemon MUST warn and skip C1
- **AND** the daemon process MUST stay running and MUST continue serving C2 (its dispatch and control channel intact)

### Requirement: A daemon SHALL exit non-zero when every declared path conflicts

When every declared path-connection of the daemon ends in a conflict (none registers successfully), the daemon SHALL print a clear message that all declared paths are already served by a live daemon and there is nothing to do, and SHALL exit with a non-zero status rather than lingering as a process that serves no connection. The exit SHALL fire only after every declared path-connection has reached a terminal outcome (registered or conflicted), so a path still completing its handshake does not trigger a premature exit.

#### Scenario: All paths conflict — daemon exits non-zero

- **GIVEN** a daemon declared to serve only cwds that are each already served by a live daemon
- **WHEN** the server reports a conflict for every one of the daemon's path-connections
- **THEN** the daemon MUST print a clear "all N paths already served — nothing to do" message
- **AND** the process MUST exit with a non-zero status

#### Scenario: Exit waits for all paths to resolve

- **GIVEN** a daemon serving cwds C1 and C2 where C1 is reported conflicting before C2 has completed its handshake
- **WHEN** C1's conflict is handled
- **THEN** the daemon MUST NOT exit yet
- **AND** the all-conflict exit MUST be evaluated only once C2 has also reached a terminal outcome
