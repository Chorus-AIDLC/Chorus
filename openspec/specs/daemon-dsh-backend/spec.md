# daemon-dsh-backend Specification

## Purpose
Defines how Chorus runs the external DeepSeek Harness backend, relays committed conversation events, and attributes normalized per-wake token usage.
## Requirements
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

### Requirement: dsh transcript consumer
The daemon upload consumer SHALL convert committed root dsh user and assistant message frames into transcript messages for the active Chorus session, and SHALL exclude non-conversation content through the shared transcript filtering rules.

#### Scenario: Committed dsh conversation is uploaded
- **WHEN** a dsh wake emits committed root `user/message` and non-empty `assistant/message` frames
- **THEN** the upload consumer appends the corresponding user and assistant text to the transcript identified by the active Chorus session ID

#### Scenario: Internal content is not uploaded as conversation
- **WHEN** a dsh assistant message contains thinking or other non-text content alongside visible text
- **THEN** the upload consumer retains only the visible conversation text

### Requirement: dsh usage is attributed once per idea-anchored wake
The daemon SHALL treat the normalized `dsh.turn.completed` usage as the authoritative delta for that wake, SHALL attach it only to the terminal turn report for the active idea-anchored session, and SHALL NOT apply a second persistent baseline subtraction.

#### Scenario: Terminal usage reaches the active idea
- **WHEN** a direct-Idea dsh wake emits one normalized `dsh.turn.completed` frame and then ends
- **THEN** exactly one terminal `turn-advance` for `sessionId` equal to that Idea UUID carries the normalized usage with source `dsh`

#### Scenario: Running edge does not carry usage
- **WHEN** the dsh wake advances from pending to running before terminal usage is known
- **THEN** the running `turn-advance` omits usage

### Requirement: dsh usage extraction rejects invalid frames
The daemon upload consumer SHALL read dsh usage from camelCase `inputTokens`, `outputTokens`, `cacheCreationTokens`, and `cacheReadTokens` fields, SHALL return no usage for malformed, incomplete, or type-mismatched dsh terminal frames, SHALL leave captured hook usage unset for rejected frames, and SHALL normalize missing or invalid categories in an otherwise valid partial usage object to `null`.

#### Scenario: Malformed or mismatched frame is ignored
- **WHEN** usage extraction receives a non-object value, a frame whose type is not `dsh.turn.completed`, or a terminal frame with a missing or non-object `usage` field
- **THEN** the extractor returns `null` and the hook dispatch does not attach usage to the terminal turn report

#### Scenario: Partial usage object preserves valid categories
- **WHEN** a `dsh.turn.completed` frame has an object-valued `usage` with at least one valid camelCase token category and other categories absent or invalid
- **THEN** the extractor preserves each valid category, normalizes every absent or invalid category to `null`, and retains source `dsh`

### Requirement: dsh usage is isolated between wakes
The daemon upload consumer SHALL reset captured dsh usage at the start of every wake so sequential wakes on the same Chorus idea anchor cannot inherit or recount a prior wake's values.

#### Scenario: Later wake has no usage frame
- **WHEN** a wake reports dsh usage and a later wake on the same idea anchor emits no `dsh.turn.completed` frame
- **THEN** the later terminal `turn-advance` omits usage rather than reusing the prior wake's values

#### Scenario: Later wake has its own usage frame
- **WHEN** two sequential wakes on the same idea anchor each emit a normalized `dsh.turn.completed` frame
- **THEN** each terminal `turn-advance` carries only its own frame's values without cumulative subtraction or duplicate counting
