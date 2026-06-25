# AgentInstance addressing: idea-rooted pin-once-inherit, a first-class (agent, host, cwd) actor

## Why

Daemon "pinning" was built per-entity and the wrong way around. `cwd` is not a property
of the work item — it is a property of **which agent you are talking to**. A "Claude agent
fixed at host X under /path Y" is itself a distinct, addressable actor. But the current code
treats the pinned place as data scattered across each entity:

- **Task** carries `targetHost` / `targetCwd` columns (`prisma/schema.prisma:226-227`).
- **Mention** markup carries a `?cwd=…&host=…` suffix (`src/lib/mention-format.ts`,
  `src/services/mention.service.ts` `MENTION_REGEX`).
- **Idea** — the root of the whole conversation — carries **nothing**, so the one place a
  pin would naturally cascade from cannot be pinned at all.

The result is three independent pin surfaces and no inheritance. The wake path proves the
gap: `resolvePinnedTarget()` (`src/services/notification-turn.ts:200-234`) reads a pin only
for `trigger==="mentioned"` or (`trigger==="task_assigned"` && `entityType==="task"`).
Every other wake — crucially the **elaboration-resolve / Verify-Elaborate handoff** that
turns an idea into a proposal — falls to agent-overall online-first and ignores intent
entirely.

A second, structural problem blocks any "single instance reference": `DaemonConnection.uuid`
churns on every reconnect (`@@unique([agentUuid, clientType, host, cwd])`,
`schema.prisma:449`), so it cannot be a durable pointer. The stable identity is the
`(agent, host, cwd)` triple, which today has no row of its own.

So this change introduces one durable abstraction — **`AgentInstance`** — and points
assignment and mention at it, with the **idea as the authoritative root**: pin once at the
idea, and proposals / tasks / wakes for the **same agent** inherit it. The pin is a soft
state attached to a reachable instance: when the instance is unreachable the assignment
gracefully degrades back to a plain agent (un-pin), never hangs.

## What Changes

- **New first-class `AgentInstance` entity** keyed `@@unique([companyUuid, agentUuid, host, cwd])`,
  created by upsert when a daemon first reports a `(host, cwd)`. It holds only durable
  identity (`companyUuid, agentUuid, host, cwd, createdAt, updatedAt`). Liveness stays on
  `DaemonConnection`, which gains an `agentInstanceUuid` FK to "the connection currently
  serving this instance".
- **A third polymorphic assignee type `agent_instance`.** A pinned assignment is
  `assigneeType="agent_instance"`, `assigneeUuid=AgentInstance.uuid` (the row carries its
  own `agentUuid`, so "this belongs to agent A" is still resolvable). An un-pinned
  assignment stays `assigneeType="agent"`. No new columns on Idea or Task — the existing
  polymorphic `assigneeType`/`assigneeUuid` pair carries it.
- **Idea-rooted inheritance with a same-agent guard.** Wake resolution becomes
  `task's own instance (override) ?? root idea's instance ?? agent-overall online-first`.
  A child resource inherits the root idea's instance **only when it resolves to the same
  agent**; a task assigned to a *different* agent does not inherit (it resolves against its
  own agent). The elaboration-resolve / Verify-Elaborate wake now reads the idea's pinned
  instance — closing the gap above.
- **Drop `Task.targetHost` / `Task.targetCwd`.** Their role is replaced by
  `assigneeType="agent_instance"` on the Task row (the explicit override). DDL-only
  migration, no backfill — existing dev pins are rebuilt when daemons reconnect.
- **Mention markup is unchanged on the wire.** `@[Name](agent:uuid?cwd=…&host=…)` keeps the
  `?cwd=&host=` codec shipped in #358; only the *semantics* converge — the suffix now
  identifies the matching `AgentInstance`. Zero migration of existing comment tokens.
- **Graceful offline degradation.** The InstancePicker offers only currently-online
  instances; pinning an offline instance is meaningless because it would immediately
  degrade. When a pinned instance goes unreachable, the assignment behaves as a plain
  `agent` (un-pin): later `@`/resolve wakes have no pin to inherit and go online-first; the
  UI re-pins via a secondary instance menu.
- **Idea assignment learns instances + re-assignment.** `assign-idea-modal` gains the
  InstancePicker (today only `assign-task-modal` has it) and can re-assign — to a different
  agent, or back to a plain agent.
- **Codebase-wide collapse to a shared helper.** Every site that filters / branches /
  resolves on `assigneeType==="agent"` must also account for `agent_instance` or it
  silently drops instance-pinned work (the checkin `ideaTracker` is the canonical example:
  its flat `{assigneeType:"agent", assigneeUuid:actorUuid}` condition can never match an
  `agent_instance` row, whose `assigneeUuid` is an instance uuid). Two helpers in
  `src/lib/uuid-resolver.ts` — `resolveAssigneeAgentUuid()` and `buildAssigneeMatch()` —
  become the single source of truth, called from the tracker, my-assignments, the
  ownership gates (release/report/proposal/elaboration), and notification recipient
  resolution.
- **Two same-root bugs fixed in passing:** `task-detail-panel` `isAssignedToMe` compares
  only uuid (not type), and `InstanceCandidate` / `AgentInstanceCandidate` are duplicate
  shapes — both are assignee-polymorphism hazards that the new third type would aggravate.

## Capabilities

- **agent-instance** — a durable `(agent, host, cwd)` identity, created on first daemon
  report, with `DaemonConnection` linked to it for liveness.
- **instance-addressed-assignment** — the `agent_instance` polymorphic assignee type, the
  idea-rooted same-agent inheritance, graceful offline degradation, and the codebase-wide
  resolution via shared helpers (including the previously-unpinned elaboration-resolve wake).

## Impact

- **Schema (DDL-only migration):** new `AgentInstance` model; `DaemonConnection.agentInstanceUuid`
  FK + back-relation; **DROP** `Task.targetHost` and `Task.targetCwd`. No backfill, no DML.
- **Services:** `daemon-connection.service.ts` (upsert AgentInstance + link connection;
  resolve instance for a connection), `notification-turn.ts` (`resolvePinnedTarget` reads
  instance + idea-root inheritance + same-agent guard + the resolve wake), `idea.service.ts`
  / `task.service.ts` (accept + persist `agent_instance` assignment; drop targetHost/targetCwd),
  `mention.service.ts` (suffix → AgentInstance), `idea-tracker.service.ts`
  (`getAssigneeConditions` → `buildAssigneeMatch`), `notification-listener.ts` (recipient
  resolution via `resolveAssigneeAgentUuid`), `proposal.service.ts` + `elaboration.service.ts`
  (ownership via the helper).
- **Shared lib:** `src/lib/uuid-resolver.ts` gains `ActorType` `"agent_instance"`,
  `resolveAssigneeAgentUuid()`, `buildAssigneeMatch()`.
- **API / MCP:** claim/assign routes + `chorus_pm_assign_task` learn an optional instance
  reference; assignee-type enums extended.
- **UI:** `assign-idea-modal` gains InstancePicker + re-assignment; `assign-task-modal`
  override; `task-detail-panel` `isAssignedToMe` fix; `InstanceCandidate` dedup; assignee
  rendering shows the instance.
- **i18n:** every new user-facing string added to `messages/en.json` + `messages/zh.json`.
- **Tests (first-class this change):** comprehensive unit coverage at the 95%/85% thresholds
  for the new entity, helpers, wake resolution, and migration semantics; plus integration
  (pseudo-e2e fixture) tests for the full pin → inherit → degrade → re-pin lifecycle to
  prevent regression across the many touched call sites.
- **Out of scope:** comment mention-badge rendering (shipped #358); soft-delete / background
  GC of AgentInstance (not introduced); declaring instances that have never connected.
- **design.pen:** not updated this round (Pencil MCP unreachable in this environment; waived
  by the requester).
