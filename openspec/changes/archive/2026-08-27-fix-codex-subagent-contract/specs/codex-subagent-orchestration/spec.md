## ADDED Requirements

### Requirement: Supported Codex spawn contract
The Codex plugin SHALL teach only the current object-shaped `spawn_agent` contract. Skill-driven subagents MUST receive an `items` array containing the mounted skill and a text assignment, while self-contained work MAY use `message`; examples MUST NOT pass `agent_type`.

#### Scenario: Reviewer is spawned
- **WHEN** guidance instructs an orchestrator to launch a proposal, task, or code reviewer
- **THEN** it mounts the corresponding `chorus:chorus-*-reviewer` skill in `items`
- **AND** it supplies a text item with the entity UUID and expected VERDICT outcome

#### Scenario: Worker is spawned
- **WHEN** guidance instructs an orchestrator to launch a Chorus development worker
- **THEN** it mounts `chorus:develop` in `items`
- **AND** it supplies a text item containing the Chorus task UUID and project UUID

### Requirement: Context forking is explicit and conditional
The Codex plugin SHALL describe `fork_context` as an opt-in mechanism. Guidance MUST enable `fork_context: true` only when the child requires material parent conversation state that cannot be conveyed adequately by its mounted skill and assignment text; routine worker and reviewer examples MUST use a fresh context.

#### Scenario: Entity-backed worker or reviewer
- **WHEN** a child can retrieve authoritative context from Chorus using the supplied entity UUIDs
- **THEN** guidance leaves `fork_context` disabled

#### Scenario: Parent conversation is required
- **WHEN** a child assignment depends on material evidence or decisions available only in the parent conversation
- **THEN** guidance permits `fork_context: true`
- **AND** explains why the inherited context is needed

### Requirement: Subagent lifecycle guidance
The Codex plugin SHALL describe lifecycle operations according to agent state and orchestration dependency.

#### Scenario: Result blocks the next step
- **WHEN** the orchestrator cannot advance without the subagent result
- **THEN** guidance instructs it to call `wait_agent`
- **AND** to call `close_agent` once no further interaction is needed

#### Scenario: Live agent needs correction
- **WHEN** an active subagent needs clarification, correction, or more work
- **THEN** guidance instructs the orchestrator to use `send_input`

#### Scenario: Closed agent must continue
- **WHEN** work must continue in a previously closed subagent thread
- **THEN** guidance instructs the orchestrator to use `resume_agent`
- **AND** does not present `resume_agent` as the normal path for an active agent

### Requirement: Chorus responsibility boundary
The Codex plugin SHALL distinguish Codex thread orchestration from Chorus MCP workflow state. `spawn_agent`, `wait_agent`, `send_input`, `close_agent`, and `resume_agent` SHALL manage execution threads, while Chorus MCP tools SHALL remain authoritative for claims, task status, work reports, acceptance evidence, submissions, and verdict comments.

#### Scenario: Worker assignment crosses both layers
- **WHEN** a worker assignment example is shown
- **THEN** the Codex spawn instruction identifies the same Chorus task and project UUIDs used by the worker's MCP workflow

### Requirement: Static and packaged regression verification
The repository MUST provide an executable check that rejects obsolete Codex spawn syntax and stale built-in-role guidance while asserting the required reviewer, worker, lifecycle, and responsibility-boundary terms. The same check MUST be runnable against both repository sources and a generated or installed Codex plugin copy.

#### Scenario: Obsolete syntax is introduced
- **WHEN** a Codex plugin source contains a `spawn_agent` example with `agent_type`
- **THEN** the static contract test fails and identifies the offending file

#### Scenario: Installed copy is validated
- **WHEN** the Codex plugin is copied into a cache-shaped temporary install location
- **THEN** the contract test runs against that copy and passes only if its contents match the supported contract

### Requirement: Codex package version consistency
When a Codex plugin release line is still unpublished, changes targeting that line MUST preserve its version in the Codex plugin manifest, all Codex skill frontmatter records, and the Codex MCP helper client identifier.

#### Scenario: Version consistency check
- **WHEN** the modified Codex plugin is validated
- **THEN** all required Codex version locations report the same current unpublished version
