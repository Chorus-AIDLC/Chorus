# daemon-claude-stream-json Specification

## Purpose
TBD - created by archiving change switch-claude-daemon-to-stream-json. Update Purpose after archive.
## Requirements
### Requirement: Claude daemon wakes SHALL use the bidirectional stream-json protocol
The Claude Code daemon backend SHALL spawn one `claude -p` process per wake with `--input-format stream-json --output-format stream-json --verbose`, keeping the existing session anchoring (`--session-id` for a new session, `--resume` for an existing one), `--mcp-config`, permission-mode flags, environment, credentials, cwd and operator-configured arguments. It SHALL deliver the wake prompt as exactly one stream-json user frame (`{"type":"user","message":{"role":"user","content":<prompt>},"parent_tool_use_id":null}`) over stdin and SHALL NOT fall back to plain-text input mode or offer a switch to it.

#### Scenario: New session wake sends one user frame
- **WHEN** the daemon wakes Claude for a session whose transcript does not exist
- **THEN** the argv contains `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose` and `--session-id <anchor>`
- **AND** stdin receives exactly one newline-terminated JSON user frame whose content is the wake prompt

#### Scenario: Resume wake keeps the anchor
- **WHEN** the daemon wakes Claude for a session whose transcript exists
- **THEN** the argv contains `--resume <anchor>` together with the stream-json input and output flags
- **AND** the wake result reports `backendSessionId` equal to the anchor

### Requirement: The spawner SHALL keep stdin open until the turn's terminal result
The spawner SHALL keep the child's stdin open after writing the user frame and SHALL close it after the first stdout frame whose `type` is `result`, regardless of its subtype, so the process exits normally. Wake settlement SHALL continue to be driven by process exit with the raw exit code, and the existing `session_conflict` classification SHALL be preserved. A process that exits or errors before any result frame SHALL settle with its raw exit outcome and SHALL NOT be reported as success. Writes to stdin SHALL never throw into the wake path.

#### Scenario: Result closes stdin and the process exits
- **WHEN** the child emits a `result` frame with subtype `success`
- **THEN** the spawner closes stdin
- **AND** the wake resolves with the process's exit code after it exits

#### Scenario: Early exit is not success
- **WHEN** the child exits with a non-zero code before emitting any `result` frame
- **THEN** the wake resolves with that non-zero exit code

#### Scenario: Stdin write after the child is gone does not crash the daemon
- **WHEN** the child has already closed its stdin and the spawner attempts a control write
- **THEN** the error is logged and the daemon keeps running

### Requirement: Control frames SHALL be handled by the spawner and not forwarded
The spawner SHALL consume stdout frames of type `control_request`, `control_response` and `control_cancel_request` and SHALL NOT forward them to the wake's message consumer. All other frames SHALL be forwarded unchanged, so transcript upload, usage accounting and operation events observe the same conversation stream as before.

#### Scenario: Control frames stay out of the transcript
- **WHEN** the child emits a `control_request` between assistant frames
- **THEN** the message consumer receives the assistant frames but not the control frame

### Requirement: Permission requests SHALL be answered explicitly and visibly
In `--chorus-only` permission mode the spawner SHALL pass `--allowedTools mcp__chorus__*` and `--permission-prompt-tool stdio`, and SHALL answer every `can_use_tool` control request with a `deny` behavior and a message stating the tool is blocked by the daemon's Chorus-only policy and directing the agent to Chorus MCP tools or a Chorus comment. It SHALL log a visible warning naming the denied tool without logging the tool input. In yolo mode the spawner SHALL keep `--dangerously-skip-permissions`; an unexpected `can_use_tool` request SHALL also be denied with a warning. Any other control request subtype SHALL receive an immediate error response and a warning, so no control request can leave a turn waiting.

#### Scenario: Chorus-only denies a non-allowlisted tool explicitly
- **GIVEN** the daemon runs in `--chorus-only` mode
- **WHEN** the child emits `control_request` with subtype `can_use_tool` for `Bash`
- **THEN** the spawner writes a `control_response` with `behavior: "deny"` and the Chorus-only message for that request id
- **AND** logs a warning naming `Bash` without the command text

#### Scenario: Unknown control request is answered with an error
- **WHEN** the child emits a `control_request` with an unrecognized subtype
- **THEN** the spawner writes an error `control_response` for that request id and logs a warning

### Requirement: Interrupt SHALL use a protocol stop hook inside the existing graceful deadline
The spawner SHALL register a process stop hook for each spawned child and unregister it when the wake settles. When invoked, the hook SHALL first, unless a result was already seen or stdin already closed, send one `control_request` with subtype `interrupt` and wait until a result frame, an error response to that request, child exit, or the protocol deadline supplied by the killer, whichever comes first. On every invocation path, including when the interrupt step is skipped, the hook SHALL then await the killer-supplied `beforeClose` callback when present (logging and continuing if it fails), and then close stdin if it is still open. Repeated invocations SHALL share the in-flight stop. The hook SHALL NOT introduce any timeout beyond the deadline supplied by the existing layered SIGINT-escalation configuration, and the existing forced process-tree cleanup SHALL apply when the process remains. User-interrupt, shutdown and resume reporting semantics SHALL be unchanged.

#### Scenario: User interrupt ends the turn over the protocol
- **GIVEN** a running Claude turn
- **WHEN** an authorized interrupt reaches the daemon
- **THEN** the child receives an `interrupt` control request, emits a result, stdin is closed and the process exits
- **AND** the turn is reported as interrupted by the user and no forced kill is issued

#### Scenario: Unresponsive child falls back to forced cleanup
- **GIVEN** a running child that ignores the interrupt control request
- **WHEN** the protocol deadline passes
- **THEN** stdin is closed and the existing forced process-tree cleanup terminates the process within the same resolved deadline

#### Scenario: Windows tree identities are captured before stdin closes
- **GIVEN** the killer supplies a `beforeClose` callback
- **WHEN** the stop hook completes its interrupt wait
- **THEN** `beforeClose` resolves before stdin is closed

#### Scenario: Interrupt before the turn starts stays within the deadline
- **GIVEN** the interrupt is acknowledged but the queued user frame still runs
- **WHEN** no result arrives before the protocol deadline
- **THEN** stdin is closed and the existing forced cleanup ends the process within the same resolved deadline

#### Scenario: Stop after the result skips the interrupt but still captures the tree
- **GIVEN** the killer supplies a `beforeClose` callback
- **WHEN** the stop hook runs after a result frame was already received
- **THEN** no interrupt control request is written
- **AND** `beforeClose` is still awaited before the hook resolves

### Requirement: The verified wire behavior SHALL be pinned by fixtures
The stream-json frames the spawner relies on SHALL be recorded as test fixtures labelled with the Claude Code CLI version they were captured from, covering a normal turn, an interrupted turn, a `can_use_tool` request and an unknown control request; each fixture SHALL state its provenance (live capture or synthetic), and spawner tests SHALL replay them. The daemon documentation SHALL state the verified CLI version and the protocol's SDK-level documentation status.

#### Scenario: Fixtures replay through the spawner
- **WHEN** the spawner tests run
- **THEN** each recorded fixture is replayed through a fake child and the spawner's writes and results match the recorded behavior

