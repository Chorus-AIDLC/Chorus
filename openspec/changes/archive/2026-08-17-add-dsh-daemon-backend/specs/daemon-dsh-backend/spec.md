## ADDED Requirements

### Requirement: External dsh runtime discovery
The daemon SHALL resolve `dsh-jsonrpc-agent` from `CHORUS_DSH_PATH` or `PATH`, SHALL require an environment-selected Cordis configuration, and SHALL fail visibly without affecting other backends when either requirement is unavailable.

#### Scenario: Runtime is available
- **WHEN** `--agent dsh` is selected and a valid external runtime and Cordis config are available
- **THEN** the daemon launches that runtime without adding the prompt, credentials, or config path to argv

#### Scenario: Runtime is unavailable
- **WHEN** `--agent dsh` is selected and the executable or required config cannot be resolved
- **THEN** the wake returns a non-success result and logs an actionable diagnostic without crashing the daemon

### Requirement: Per-wake dsh lifecycle
The dsh backend SHALL create one fresh runtime process and random dsh session for each wake, SHALL expose that child through `onChild`, and SHALL report the wake as new.

#### Scenario: Wake completes normally
- **WHEN** the root dsh session reaches idle after its prompt
- **THEN** the bridge requests shutdown, closes the transport, waits for process exit, and resolves the Spawner wake result

#### Scenario: Wake is interrupted
- **WHEN** the daemon interrupts an in-flight dsh wake
- **THEN** the existing execution-control path can terminate the exposed runtime process group and its descendants

#### Scenario: A later wake uses the same Chorus anchor
- **WHEN** another dsh wake is dispatched for an anchor used previously
- **THEN** the backend starts a fresh dsh runtime and session without reading or writing a dsh session map

### Requirement: JSON-RPC protocol integrity
The bridge SHALL parse only newline-delimited JSON-RPC frames from runtime stdout, SHALL route matching responses and notifications deterministically, and SHALL treat malformed frames, protocol errors, or premature exit as wake failures.

#### Scenario: Frames cross chunk boundaries
- **WHEN** one JSON-RPC frame is split across chunks or multiple frames arrive in one chunk
- **THEN** the bridge reconstructs and processes each complete line exactly once

#### Scenario: Runtime writes diagnostics
- **WHEN** the runtime writes non-empty text to stderr
- **THEN** the daemon logger records it without contaminating the JSON-RPC or `onMessage` stream

### Requirement: Conversation event boundary
The bridge SHALL forward only committed root-session user and non-empty assistant messages, SHALL attach the dsh session ID, and SHALL omit raw deltas, reasoning, tools, and descendant-session events.

#### Scenario: Root committed assistant message arrives
- **WHEN** a root `assistant/message` contains visible committed content
- **THEN** `onMessage` receives one dsh conversation frame preserving the event data and carrying `session_id`

#### Scenario: Internal or descendant event arrives
- **WHEN** a tool, reasoning, raw chunk, status, or descendant-session event arrives
- **THEN** no conversation frame is emitted for that event

### Requirement: Normalized terminal usage
The bridge SHALL aggregate valid usage from root committed assistant messages during one wake and SHALL emit exactly one `dsh.turn.completed` frame at the root idle boundary using the shared normalized usage fields and source `dsh`.

#### Scenario: Multiple model steps report usage
- **WHEN** a wake contains multiple root assistant messages with usage
- **THEN** the terminal frame contains the category-wise sum without adding reasoning tokens to output tokens

#### Scenario: A usage category is missing
- **WHEN** no valid count is observed for a normalized usage category
- **THEN** that terminal usage field is `null` rather than a fabricated zero

### Requirement: dsh backend selection
The daemon SHALL construct `DshSpawner` when the resolved agent type is `dsh` and SHALL expose `dsh` in CLI help and daemon install selection without changing the default backend.

#### Scenario: dsh is selected
- **WHEN** agent selection resolves to `dsh`
- **THEN** the backend-neutral wake pipeline invokes a `DshSpawner`

#### Scenario: no agent is selected
- **WHEN** no explicit agent selection is provided
- **THEN** the existing default backend remains unchanged
