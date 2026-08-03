## Context

The predecessor change added per-user `(project, Agent)` fixed cwd preferences and directed
execution for paths that are not daemon startup cwds. Consumption is currently fragmented:
`wake-preview`, `notification-turn`, and `stage-advance` each query preferences separately,
while assignment modals only understand registered `AgentInstance` rows. A discovered fixed
cwd therefore cannot consistently become the root Idea anchor that existing proposal/task
inheritance expects.

The existing wake chain already defines the safety model we need: a Task instance override
wins, then the root Idea hard pin, then online-first fallback. A hard pin that is offline is
notify-only for recoverable wakes and causes a distinct failure for `require_online`
operations. `DaemonSession.runtimeCwd` and the origin connection already keep an active
conversation in one directory.

## Goals / Non-Goals

**Goals:**

- Resolve fixed, temporary, registered-instance, and fallback targets through one service.
- Make a fixed preference authoritative at every new project workflow entry.
- Materialize or reuse a durable Agent instance identity for a fixed `(agent, host, cwd)` so
  the root Idea can use the existing hard-pin inheritance model.
- Keep active sessions immutable when preferences change.
- Return typed unavailable states without silently selecting another directory.
- Keep Agent A and Agent B preferences independent in the same project.

**Non-Goals:**

- Moving an active session to a new cwd.
- Making a user's preference project-shared.
- Changing daemon browse-root security or directory discovery.
- Allowing inline overrides while a fixed preference exists.

## Decisions

### Use one resolved-target contract

Add a project cwd anchoring service that accepts company, actor, project, Agent, and optional
operation-local target. It returns a discriminated result containing:

- `source`: `project_fixed`, `temporary`, `registered_instance`, or `unconfigured`
- `agentUuid`, `host`, `cwd`, and optional connection/instance identifiers
- `actorUserUuid`, identifying the user whose project preference authorized the anchor
- `status`: `ready`, `offline`, or `invalid`
- whether the caller must prompt

Callers consume this result instead of querying `ProjectAgentCwdPreference` directly.
Preference resolution precedes temporary and registered-instance choices. A stored
preference never degrades to `unconfigured`.

The workflow entry resolves exactly once and passes the complete result through all
subsequent stages of that operation. Later stages do not re-resolve against a changed actor,
preference, or connection registry. When the operation creates a durable Idea/Task anchor
or daemon session, that persisted target becomes the source for later independent
operations.

Alternative: keep a common helper that returns only the preference row. Rejected because
callers would still duplicate online-host lookup, hard-pin construction, and error policy.

### Anchor fixed targets through durable AgentInstance identity

When a fixed target is ready, resolve or materialize the durable
`AgentInstance(agentUuid, host, cwd)` identity even if the cwd is not a startup connection.
Assignment persists that instance on the root Idea or Task. Dispatch still chooses an online
connection on the same Agent and host and carries `runtimeCwd` for an unregistered path.

This lets all existing proposal/task inheritance and hard-pin rules work without adding a
second cwd reference to Idea or Task. It also means unattended flows use the Idea's persisted
target rather than guessing which user's preference to load later.

Alternative: store a new preference UUID on every Idea. Rejected because it couples an
immutable execution anchor to a mutable/deletable user preference and duplicates the
polymorphic assignment model.

### Preference changes affect only future anchors

Replacing or clearing a preference changes later assignment and stage-entry resolution. It
does not rewrite existing Idea/Task assignees and never mutates `DaemonSession.runtimeCwd` or
origin connection. Resume, continuation, and delivered turns remain attached to the session
that created them.

### Preserve hard-pin offline policy

A fixed target with no online connection on its host returns `offline`; an invalid path
returns `invalid`. Interactive surfaces show the fixed host/cwd and a project-settings link.
Recoverable wake paths keep the hard target and remain notify-only for reconnect backfill.
`Start Development`, `Yolo`, and other `require_online` actions fail with a typed target
error. No branch falls through to online-first.

### Suppress pickers but keep the anchor visible

Assignment and stage-entry surfaces do not render instance/cwd pickers when the resolver
returns `project_fixed`. They render a compact read-only host/cwd summary and a settings
action. Clearing the preference restores the existing auto-pin/picker/temporary browse flow.

## Risks / Trade-offs

- [A discovered cwd has no startup AgentInstance] -> Upsert only the durable identity; do not
  create a fake online connection, and continue dispatching with host plus `runtimeCwd`.
- [Preference is cleared after an Idea is anchored] -> Existing Idea remains intentionally
  pinned; only a new assignment can establish a new anchor.
- [Callers bypass the resolver] -> Add focused tests and repository searches covering every
  project workflow entry; keep direct preference reads confined to the resolver/settings.
- [Host is online but path became invalid] -> Validate at dispatch and return the typed
  invalid state; never reroute.

## Migration Plan

1. Introduce the resolver and durable fixed-target anchoring with compatibility tests.
2. Migrate assignment, wake-preview, and stage-entry callers to resolve once, propagate the
   actor-bearing result, and reuse it through each operation.
3. Add UI fixed-anchor states and remove picker rendering for fixed targets.
4. Run integration and browser acceptance across fixed, cleared, multi-Agent, offline, and
   session-continuity cases.

Rollback restores the old callers. Existing preference, instance, and session rows remain
compatible and require no cleanup.

## Open Questions

None. Round 1 established root-Idea anchoring, immutable active sessions, visible read-only
anchors, and alignment with current hard-pin offline behavior.
