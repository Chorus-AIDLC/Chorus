## MODIFIED Requirements

### Requirement: Codex session anchoring via a persisted idea→thread-id map

Because Codex generates its own `thread_id` rather than accepting a client-supplied session id, the daemon SHALL capture the generated `thread_id` from the Codex event stream and SHALL persist a mapping from the Chorus session anchor (the direct idea uuid, or the entity uuid for an ad-hoc session) to that `thread_id` in a daemon-local store. For a fresh run, the daemon SHALL persist the mapping immediately after the first valid generated thread identifier is observed, without waiting for the turn or process to exit successfully. Repeated identifier events within the same wake SHALL result in exactly one persistence call. On a subsequent wake for the same anchor, the daemon SHALL resume the existing Codex session via `codex exec resume <thread_id>`; when no mapping exists for the anchor, it SHALL start a fresh `codex exec` run. The new-vs-resume decision for the Codex backend SHALL be made from this map (not from the Claude on-disk transcript probe), and lifecycle logs SHALL NOT report a contradictory Claude-probe decision as the Codex command state. The persistence SHALL be best-effort: a read/write failure SHALL degrade to starting a fresh session with a visible log, never throwing into the wake path.

#### Scenario: Same anchor resumes the same Codex thread

- **WHEN** a wake fires for an anchor whose `thread_id` was recorded by a prior Codex run
- **THEN** the daemon runs `codex exec resume <thread_id>` so the conversation continues, rather than starting a new session

#### Scenario: First wake for an anchor starts fresh and records the thread id

- **WHEN** a wake fires for an anchor with no recorded `thread_id`
- **THEN** the daemon starts a new `codex exec` run, captures the first valid generated `thread_id` from the stream, and immediately persists the anchor-to-thread-id mapping for future resumes

#### Scenario: Interrupted first turn remains resumable

- **WHEN** a fresh Codex wake emits a valid `thread_id` and is then interrupted before a successful process exit
- **THEN** the mapping MUST already contain that `thread_id`
- **AND** the next wake for the same anchor MUST invoke `codex exec resume <thread_id>` instead of starting a fresh thread

#### Scenario: Failure before thread establishment does not create a mapping

- **WHEN** a fresh Codex process fails or exits before emitting a valid generated thread identifier
- **THEN** the daemon MUST NOT persist an inferred, blank, or anchor-derived thread identifier

#### Scenario: Duplicate identifier events are idempotent

- **WHEN** a fresh Codex wake emits the same valid generated thread identifier more than once
- **THEN** the daemon MUST invoke mapping persistence exactly once for that wake
- **AND** the persisted mapping MUST equal the emitted identifier

#### Scenario: Codex lifecycle state reflects the map-based decision

- **WHEN** the Claude transcript probe and the Codex thread map would produce different new-vs-resume answers
- **THEN** the Codex command MUST follow the thread map
- **AND** daemon lifecycle logs MUST NOT claim that the contradictory Claude-probe answer was used

### Requirement: Codex interrupt via detached process-group kill

The Codex backend SHALL spawn its subprocess in a detached POSIX process group (so it leads its own group and a group-directed signal reaches the child shells `codex exec` forks for tool calls), and the daemon's existing two-stage process-tree killer (graceful SIGINT, then forceful SIGKILL of the group after a timeout; `taskkill /T /F` on Windows) SHALL be reused unchanged to interrupt a running Codex wake. After an interrupt, a subsequent wake for the same anchor SHALL resume the recorded Codex `thread_id` whenever a valid identifier was emitted before the interrupt, including when the interrupted turn was the first turn for that anchor.

#### Scenario: Interrupting a running Codex wake stops its process tree

- **WHEN** an authorized interrupt is verified for a running Codex wake
- **THEN** the daemon group-signals the detached Codex process so the Codex process and the child shells it spawned are stopped, escalating to a forceful kill if it does not exit within the timeout

#### Scenario: Re-wake after interrupt resumes when a thread id was captured

- **WHEN** a Codex wake, including a first wake for its anchor, was interrupted after a valid `thread_id` had been emitted and a new wake fires for the same anchor
- **THEN** the daemon resumes that `thread_id` via `codex exec resume` rather than starting a fresh session

#### Scenario: Repeated interrupt of an existing thread preserves continuity

- **WHEN** a wake resumes an already-mapped Codex thread, that resumed wake is interrupted, and another wake fires for the same anchor
- **THEN** the daemon MUST retain the existing mapping
- **AND** the later wake MUST again invoke `codex exec resume` with the same `thread_id`
