# daemon-pi-rpc Specification

## Purpose
TBD - created by archiving change switch-pi-daemon-to-rpc. Update Purpose after archive.
## Requirements
### Requirement: Pi daemon wakes SHALL use the native RPC protocol
The Pi daemon backend SHALL spawn one `pi --mode rpc --session-id <anchor>` process per wake, keeping the existing anchor, cwd, environment, credentials and operator-configured arguments, and SHALL NOT pass `-p`, `--mode json` or `--no-session`. It SHALL write JSONL commands to stdin: one `get_state` command, then exactly one `prompt` command whose `message` is the wake prompt. It SHALL NOT fall back to JSON print mode or offer a switch to it.

#### Scenario: Wake sends get_state then one prompt
- **WHEN** the daemon wakes Pi for an anchor
- **THEN** the argv contains `--mode rpc` and `--session-id <anchor>` and does not contain `-p`
- **AND** stdin receives a `get_state` command followed, after its response, by exactly one `prompt` command carrying the wake prompt
- **AND** no second `prompt` command is ever written for that wake

### Requirement: The spawner SHALL keep stdin open until agent_settled
The spawner SHALL keep the child's stdin open after sending the prompt and SHALL close it after the first `agent_settled` event, so the process exits normally. A `prompt` response with `success: true` and an `agent_end` event (with or without `willRetry`) SHALL NOT close stdin. A `prompt` response with `success: false` SHALL be logged, SHALL close stdin, and SHALL settle the wake with a non-zero exit code even when the process exits 0. After a successful prompt response the spawner SHALL send a second `get_state`; when it reports `isStreaming: false` and neither `agent_start` nor `agent_settled` has been seen, the prompt was handled without an agent run and the spawner SHALL close stdin so the wake settles with the raw exit code. A process that exits or errors before `agent_settled` SHALL settle with its raw exit outcome. Writes to stdin SHALL never throw into the wake path.

#### Scenario: agent_settled closes stdin
- **WHEN** the child emits `agent_end` with `willRetry: true`, then later `agent_settled`
- **THEN** stdin stays open after `agent_end` and is closed after `agent_settled`
- **AND** the wake resolves with the process's exit code after it exits

#### Scenario: Prompt handled without an agent run still settles
- **WHEN** the child answers the prompt with `success: true`, emits no `agent_start`, and the follow-up `get_state` reports `isStreaming: false`
- **THEN** the spawner closes stdin and the wake resolves with the process's exit code

#### Scenario: Rejected prompt is not success
- **WHEN** the child answers the prompt with `success: false` and then exits 0
- **THEN** the spawner logs the error, closes stdin and the wake resolves with a non-zero exit code

#### Scenario: Write after the child is gone does not crash the daemon
- **WHEN** the child's stdin is already closed and the spawner attempts a write
- **THEN** the error is logged and the daemon keeps running

### Requirement: Protocol frames SHALL be consumed and not forwarded
The spawner SHALL consume stdout frames of type `response` and `extension_ui_request` and SHALL NOT forward them to the wake's message consumer. All other frames SHALL be forwarded unchanged so transcript upload and operation events observe the same event stream as JSON mode. `extension_error` events SHALL additionally be logged as warnings.

#### Scenario: Protocol frames stay out of the transcript
- **WHEN** the child emits a `response` and an `extension_ui_request` between `message_end` events
- **THEN** the message consumer receives the `message_end` events but neither protocol frame

### Requirement: Blocking extension dialogs SHALL be cancelled immediately
For an `extension_ui_request` whose method is `select`, `confirm`, `input` or `editor`, the spawner SHALL immediately write `{"type":"extension_ui_response","id":<request id>,"cancelled":true}` and log a warning naming the method without its title, message or options. Requests with any other method SHALL be consumed without a reply.

#### Scenario: Confirm dialog is cancelled
- **WHEN** the child emits an `extension_ui_request` with method `confirm`
- **THEN** the spawner writes a cancelled `extension_ui_response` with the same id and logs a warning naming `confirm`

#### Scenario: Notify needs no reply
- **WHEN** the child emits an `extension_ui_request` with method `notify`
- **THEN** nothing is written to stdin

### Requirement: Interrupt SHALL use a protocol stop hook inside the existing graceful deadline
The spawner SHALL register a process stop hook for each spawned child and unregister it when the wake settles. When invoked, the hook SHALL, if the prompt was sent, `agent_settled` has not been seen and stdin is open, send one `abort` command and wait until `agent_settled`, the abort response, child exit, or the protocol deadline supplied by the killer, whichever comes first. If the stop starts before the prompt was sent, the prompt SHALL never be sent. On every path the hook SHALL then await the killer-supplied `beforeClose` callback when present (logging and continuing if it fails) and close stdin. Repeated invocations SHALL share the in-flight stop. The hook SHALL NOT add any timeout beyond the supplied deadline, and the existing forced process-tree cleanup SHALL apply when the process remains. Because pi exits 0 on stdin EOF, a wake whose stop started before `agent_settled` SHALL settle with exit code 130 when the raw exit code is 0, so user-interrupt, shutdown and resume reporting semantics are unchanged (the turn is recorded as interrupted, not ended); a stop after `agent_settled` SHALL keep the raw exit code.

#### Scenario: User interrupt aborts over the protocol
- **GIVEN** a running Pi wake
- **WHEN** an authorized interrupt reaches the daemon
- **THEN** the child receives an `abort` command, emits `agent_settled`, stdin is closed and the process exits
- **AND** the wake settles with exit code 130, the turn is reported as interrupted by the user and no forced kill is issued

#### Scenario: Unresponsive child falls back to forced cleanup
- **GIVEN** a running child that ignores `abort`
- **WHEN** the protocol deadline passes
- **THEN** stdin is closed and the existing forced process-tree cleanup ends the process within the same resolved deadline

#### Scenario: Stop before the prompt never sends it
- **WHEN** the stop hook runs while the spawner is still waiting for the `get_state` response
- **THEN** no `prompt` and no `abort` command is written
- **AND** `beforeClose` is awaited before stdin is closed

### Requirement: Session continuity SHALL be reported truthfully
The spawner SHALL derive the wake result's `isNew` from the `get_state` response (`messageCount` of 0 means a new session), falling back to the caller's value when the response is unusable. When the session is new and the directory of the reported `sessionFile` already contains another session file for the same anchor, the spawner SHALL log a warning that previous Pi history could not be restored and SHALL forward one assistant `message_end` carrying that notice before sending the prompt. A failure to inspect the directory SHALL be logged and SHALL NOT fail the wake.

#### Scenario: Resumed session reports isNew false
- **WHEN** `get_state` reports `messageCount` greater than 0
- **THEN** the wake result has `isNew: false` and no continuity notice is emitted

#### Scenario: Unrestorable history is visible
- **GIVEN** a session file for the anchor exists but pi started a new session
- **WHEN** `get_state` reports `messageCount: 0` and a different `sessionFile` in the same directory
- **THEN** the spawner logs a warning and forwards one assistant notice message before the prompt

### Requirement: Unsupported Pi versions SHALL be refused with an upgrade hint
Before the first spawn for a resolved `pi` executable, the spawner SHALL read `pi --version` and cache the result for that path. A version below 0.85.0 SHALL log a visible error that names the found version, the required minimum and an upgrade command, and the wake SHALL resolve with `exitCode: null` without spawning an RPC process. An unparseable version or a failed probe SHALL log a warning and SHALL NOT block the wake.

#### Scenario: Old Pi is refused
- **WHEN** `pi --version` prints `0.80.3`
- **THEN** no RPC process is spawned, an error naming 0.80.3 and 0.85.0 is logged, and the wake resolves with `exitCode: null`

#### Scenario: Version is probed once per path
- **WHEN** two wakes run with the same resolved executable
- **THEN** `pi --version` runs only once

### Requirement: The verified wire behavior SHALL be pinned by fixtures
The RPC frames the spawner relies on SHALL be recorded as test fixtures labelled with the Pi version and their provenance (live capture or synthetic), covering a normal run, a resumed run, an abort during a running tool, a prompt handled without an agent run, a blocking extension dialog and a rejected prompt. Spawner tests SHALL replay them. The daemon documentation SHALL state the verified Pi version and the minimum supported version.

#### Scenario: Fixtures replay through the spawner
- **WHEN** the spawner tests run
- **THEN** each fixture is replayed through a fake child and the spawner's writes and results match the recorded behavior

