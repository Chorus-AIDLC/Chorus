## ADDED Requirements

### Requirement: Claude transcript discovery matches backend cwd encoding

The Claude daemon backend MUST derive its project transcript directory using the cwd encoding observed from the supported Claude Code installation. The encoding MUST correctly locate transcripts for working directories containing spaces and non-ASCII characters and MUST preserve the established output for existing ASCII path, separator, dot, and platform fixtures. The transcript probe and spawned Claude process MUST use the same resolved cwd.

#### Scenario: CJK cwd resumes an existing transcript

- **WHEN** a Claude session transcript exists under Claude Code's encoded project directory for a cwd containing CJK characters
- **THEN** the daemon MUST find that transcript and launch the next wake with `--resume` rather than `--session-id`

#### Scenario: Space-containing cwd resumes an existing transcript

- **WHEN** a Claude session transcript exists under Claude Code's encoded project directory for a cwd containing spaces
- **THEN** the daemon MUST find that transcript and launch the next wake with `--resume` rather than `--session-id`

#### Scenario: Existing ASCII encoding remains compatible

- **WHEN** the daemon encodes an existing ASCII path fixture containing separators, dots, and hyphens
- **THEN** the resulting project directory key MUST remain byte-identical to the verified Claude Code result

### Requirement: Claude session conflicts are reported structurally

The Claude spawner MUST classify a non-zero subprocess result whose stderr states that the supplied session ID is already in use as a deterministic session conflict. The classification MUST be returned through the spawner result without parsing daemon log output and MUST NOT classify unrelated stderr or non-zero exits as session conflicts.

#### Scenario: New-session launch conflicts with a registered ID

- **WHEN** Claude exits non-zero and stderr reports that the supplied session ID is already in use
- **THEN** the spawner result MUST identify a deterministic session conflict while preserving the exit code and session identity fields

#### Scenario: Unrelated Claude failure is not classified

- **WHEN** Claude exits non-zero for an error that does not match the session-ID-in-use signature
- **THEN** the spawner result MUST NOT identify a deterministic session conflict

### Requirement: Non-Claude backends retain authoritative session maps

Codex and Kiro MUST continue to decide new-versus-resume state from their backend-owned persisted session mappings rather than Claude's cwd-derived transcript probe. If either backend acquires a cwd-derived store assumption, its encoding MUST be independently verified and covered by backend-specific tests.

#### Scenario: Codex and Kiro ignore the Claude transcript probe

- **WHEN** the shared Waker dispatches a Codex or Kiro wake
- **THEN** the selected spawner MUST derive resume state from its persisted backend session mapping and MUST NOT treat the Claude transcript probe as authoritative
