# cli-daemon Specification (delta)

## MODIFIED Requirements

### Requirement: Lineage-anchored session continuity

The daemon SHALL key each local Claude session on the **root idea** of the dispatched
entity. It SHALL resolve any inbound event to its root idea by **preferring the
server-side `chorus_resolve_root_idea` tool** (the single source of truth), and SHALL
**fall back** to a client-side lineage walk (`task → proposal → idea`, then following
`idea.parentUuid`) only when that tool is unavailable — for example an older server
that does not register it, or a transport failure. A well-formed server response SHALL
be authoritative, including a `rootIdeaUuid` of `null`, which the daemon SHALL NOT
override via the fallback walk. The daemon SHALL maintain a persisted map from root
idea to Claude session id. When a notification resolves to a root idea that already
has a session, the daemon SHALL resume that session (`--resume`); when it resolves to
a new root idea, the daemon SHALL start a fresh session and persist the newly created
session id. When no idea ancestor exists (a `null` root idea), the daemon SHALL fall
back to a per-entity session key.

#### Scenario: Same root idea resumes the same session

- **WHEN** two notifications (e.g. a task execution then a later proposal rejection)
  both resolve up the lineage to the same root idea
- **THEN** the second wake resumes the same Claude session id used by the first via
  `--resume`

#### Scenario: Different root idea starts a fresh session

- **WHEN** a notification resolves to a root idea that has no recorded session
- **THEN** the daemon starts a fresh Claude session, captures the new session id from
  the subprocess output, and persists it under that root idea

#### Scenario: Server resolution is preferred when available

- **WHEN** the server exposes `chorus_resolve_root_idea` and it returns a well-formed
  response for an inbound event
- **THEN** the daemon uses the server's `rootIdeaUuid` (including a `null` result)
  without performing its own multi-hop lineage walk

#### Scenario: Client walk is used when the server tool is unavailable

- **WHEN** `chorus_resolve_root_idea` is not registered on the server or the call
  fails at the transport layer
- **THEN** the daemon falls back to its client-side `task → proposal → idea →
  parentUuid` walk and anchors the session on the resulting root idea, preserving the
  pre-existing behavior
