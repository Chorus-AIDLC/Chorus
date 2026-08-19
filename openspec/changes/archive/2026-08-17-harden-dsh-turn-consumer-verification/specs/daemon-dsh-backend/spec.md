## ADDED Requirements

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
