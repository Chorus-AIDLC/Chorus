## MODIFIED Requirements

### Requirement: Lineage-anchored session continuity

The daemon SHALL key each local Claude session on the **direct idea** of the
dispatched entity — the idea the entity attaches to directly, NOT the topmost
ancestor of its lineage. For each inbound notification it SHALL resolve the entity by
making a single call to the server-side REST endpoint
`GET /api/entities/{type}/{uuid}/root-idea` (authenticated with its agent API key) and
SHALL use the response's `directIdeaUuid` as the session anchor. The daemon SHALL NOT
perform any client-side lineage walk of its own; the server's `directIdeaUuid`
(including `null`) is authoritative. The daemon SHALL continue to read the response's
`rootIdeaUuid` for execution-state reporting, but SHALL NOT use it for session
anchoring. The daemon SHALL report the server-resolved `rootIdeaUuid` in its execution
snapshot and SHALL NOT derive that reported root from the session-anchor key — because
the anchor key now carries the direct idea, the reported `rootIdeaUuid` and the
direct-idea anchor key SHALL be threaded as separate values, never re-derived from one
another.

The daemon SHALL use a single, explicit spawn working directory for both the on-disk
transcript probe and the subprocess spawn, so the build-vs-resume decision is made
against the same directory in which the session is created.

The Claude session id SHALL be the `directIdeaUuid` itself — a deterministic id, not a
randomly generated one. The daemon SHALL NOT maintain any persisted map from idea to
session id; the prior `~/.chorus/sessions.json` session map SHALL be removed. To decide
whether a wake starts a new session or resumes an existing one, the daemon SHALL probe
the on-disk Claude transcript for the deterministic id at
`<config-dir>/projects/<cwd-escaped>/<directIdeaUuid>.jsonl`, where `<config-dir>`
honors `CLAUDE_CONFIG_DIR` (falling back to `~/.claude`) and `<cwd-escaped>` is the
daemon's spawn working directory with the platform's Claude Code escaping applied. When
the transcript file is absent the daemon SHALL spawn with `--session-id <directIdeaUuid>`
(new session); when it is present the daemon SHALL spawn with `--resume <directIdeaUuid>`
(continue). This disk-probe path is specific to the Claude Code transcript layout and
SHALL NOT be assumed for other agent CLIs.

Before spawning, the daemon SHALL validate that the session id is a well-formed,
lowercase UUID; if it is not, the daemon SHALL log the failure visibly and SHALL NOT
spawn (no silent error). When the endpoint returns no direct idea (a `null`
`directIdeaUuid`) or the call fails for any reason, the daemon SHALL fall back to a
per-entity session key. Resolution results MAY be cached per run so the same entity is
not resolved twice within one daemon run.

#### Scenario: Session id equals the direct idea uuid

- **WHEN** a notification resolves to a `directIdeaUuid`
- **THEN** the daemon spawns Claude with that uuid as the session id, so a human can
  later run `claude --resume <directIdeaUuid>` from the daemon's working directory to
  take over the session

#### Scenario: Parent and child ideas get separate sessions

- **WHEN** one notification resolves to a child idea and another to its parent idea
- **THEN** the daemon anchors each on its own `directIdeaUuid`, spawning two distinct
  Claude sessions — cross-idea context is intentionally not shared

#### Scenario: Same direct idea resumes the same session

- **WHEN** two notifications (e.g. a task execution then a later proposal rejection)
  both resolve to the same `directIdeaUuid`
- **THEN** the second wake finds the transcript on disk and resumes the same session via
  `--resume <directIdeaUuid>`

#### Scenario: First wake for a direct idea creates the deterministic session

- **WHEN** a notification resolves to a `directIdeaUuid` whose transcript file does not
  exist on disk
- **THEN** the daemon spawns with `--session-id <directIdeaUuid>`, creating the session
  under the deterministic id, with no persisted map write

#### Scenario: Build-vs-resume is decided by probing the transcript on disk

- **WHEN** the daemon must decide whether to start or resume a session for a direct idea
- **THEN** it checks for `<config-dir>/projects/<cwd-escaped>/<directIdeaUuid>.jsonl`,
  honoring `CLAUDE_CONFIG_DIR`, rather than consulting any persisted session map or
  relying on parsing a Claude error string

#### Scenario: Root idea is still reported but not used for anchoring

- **WHEN** a notification resolves with both a `directIdeaUuid` and a different
  `rootIdeaUuid`
- **THEN** the daemon anchors the session on `directIdeaUuid` and reports `rootIdeaUuid`
  in its execution snapshot, never the reverse

#### Scenario: Snapshot root is the resolved root, not the anchor key

- **WHEN** a notification resolves with `directIdeaUuid !== rootIdeaUuid` and the daemon
  builds an execution snapshot for it
- **THEN** the snapshot's `rootIdeaUuid` is the server-resolved root idea — not the
  direct idea that the serialization/anchor key carries — and is not obtained by parsing
  the anchor key

#### Scenario: The probe and the spawn use the same working directory

- **WHEN** the daemon probes for the transcript and then spawns the subprocess
- **THEN** both use the same explicit spawn working directory, so the new-vs-resume
  decision is made against the directory in which the session is (or will be) created

#### Scenario: Invalid session id is refused visibly, not spawned

- **WHEN** the resolved session id is not a well-formed UUID
- **THEN** the daemon logs the failure visibly and does not spawn a subprocess

#### Scenario: No direct idea degrades to a per-entity key

- **WHEN** the resolution endpoint returns a `null` `directIdeaUuid`, is unreachable,
  returns a non-2xx status, or returns a malformed body
- **THEN** the daemon anchors the session on a per-entity key, without crashing

## REMOVED Requirements

### Requirement: Per-root-idea wake serialization

## ADDED Requirements

### Requirement: Per-direct-idea wake serialization

The daemon SHALL ensure that at most one wake runs at a time for any given
direct-idea session key (because each direct idea maps to a single deterministic
Claude session), while allowing wakes for different direct ideas to run concurrently. The serialization
key SHALL be the same value used for session anchoring (the `directIdeaUuid`, or the
per-entity fallback key when there is no direct idea). Wakes targeting the same direct
idea SHALL be queued and executed in arrival order, so the daemon never runs two
concurrent subprocesses that resume the same session. Enqueuing a wake SHALL NOT block
the notification subscription loop, and a failing wake SHALL NOT permanently block
subsequent wakes for the same direct idea.

#### Scenario: Two notifications for the same direct idea run sequentially

- **WHEN** two notifications that resolve to the same `directIdeaUuid` arrive in close
  succession
- **THEN** the daemon runs the first wake to completion before spawning the second, so
  no two concurrent subprocesses resume the same session id

#### Scenario: Notifications for different direct ideas run concurrently

- **WHEN** two notifications that resolve to different direct ideas arrive in close
  succession — including a parent idea and its child idea
- **THEN** the daemon may run both wakes concurrently, each on its own session

#### Scenario: A failed wake does not wedge the queue

- **WHEN** a queued wake for a direct idea fails or its subprocess errors
- **THEN** the failure is logged and the next queued wake for that same direct idea
  still proceeds
