# daemon-cwd-instance-addressing Specification

## Purpose
TBD - created by archiving change add-cwd-addressable-instances. Update Purpose after archive.
## Requirements
### Requirement: Presence SHALL drill an agent down to its per-instance cwd rows

The agent-presence surface (the presence popover and the connections list) SHALL keep one row per agent and SHALL allow that agent row to expand to one sub-row per live daemon instance, where an instance is a distinct `DaemonConnection` identified by `(agentUuid, clientType, host, cwd)`. Each instance sub-row SHALL display its own `cwd` as the primary label and its own `effectiveStatus` (online/offline) independently of sibling instances. A connection whose `cwd` is null (a legacy daemon that did not self-report a working directory) SHALL be rendered as an explicit "unknown path" instance that is still individually listed. The grouping SHALL reuse the existing `listConnectionsForAgent` output and the registry's `effectiveStatus` rule; it SHALL NOT introduce a new endpoint, permission bit, or liveness threshold.

#### Scenario: An agent with multiple live cwds expands to per-instance rows

- **GIVEN** an agent with three live `DaemonConnection` rows differing by `cwd` and/or `host`
- **WHEN** the owner expands that agent in the presence surface
- **THEN** the UI MUST render three instance sub-rows, each showing its own cwd as the primary label and its own online/offline state

#### Scenario: A legacy null-cwd connection renders as an unknown-path instance

- **GIVEN** a live `DaemonConnection` whose `cwd` is null
- **WHEN** the owner views that agent's instances
- **THEN** that instance MUST be shown as an explicit "unknown path" instance and MUST still be individually listed (and, when online, selectable as a target)

### Requirement: Instance surfaces SHALL display cwd path-first and host host-conditionally

On every surface that displays a daemon instance (presence rows, the @-mention instance picker, the task-assignment cwd picker, the ad-hoc send picker, and target confirmations), `cwd` SHALL be the primary label. `host` SHALL NOT be removed — it is part of the instance's unique identity, so the same `cwd` on two different hosts denotes two distinct instances — but it SHALL be de-emphasized: for an agent whose live instances are all on a single host, the host SHALL be shown once (e.g. at the agent header) rather than repeated on every instance row; for an agent whose live instances span two or more distinct hosts, each instance row SHALL render its host as a secondary per-row suffix so the rows remain distinguishable. A dispatch/mention/send target confirmation SHALL include the host only when the host is needed to disambiguate the chosen instance.

#### Scenario: Single-host agent does not repeat the host on every row

- **GIVEN** an agent whose live instances are all on host `Laptop-Q3`
- **WHEN** its instance rows render
- **THEN** each row MUST lead with its cwd as the primary label
- **AND** the host MUST be shown once (not repeated per instance row)

#### Scenario: Same cwd on two hosts stays distinguishable

- **GIVEN** an agent with two live instances that share the cwd `dev/chorus` but differ by host (`Laptop-Q3` versus `ci-runner-02`)
- **WHEN** its instance rows render
- **THEN** each row MUST show its host as a secondary suffix so the two same-cwd rows are visually distinct

### Requirement: The UI SHALL truncate long paths and hosts without losing the disambiguating part

The UI SHALL provide a shared formatting rule for instance paths and hosts so that long values never break row layout or push status, tag, or action controls off the row. A `cwd` SHALL be displayed as its abbreviated tail (last two path segments); when even that exceeds the available width it SHALL be truncated from the left with a leading ellipsis while always preserving the final path segment (the working directory's own name) intact. A `host` SHALL be truncated from the right with a trailing ellipsis and capped at a fixed maximum width so it never crowds the path. The full absolute path and the full host SHALL be available on hover (title). Within a row, the status indicator and the selection control SHALL NOT shrink; only the path — and then the host — SHALL flex-shrink, with the path retaining shrink priority as the primary identity.

#### Scenario: A long path keeps its final segment and reveals the full path on hover

- **GIVEN** an instance whose absolute cwd is `/home/u/dev/payments-platform/services/billing-api`
- **WHEN** its path chip renders in a constrained row
- **THEN** the visible label MUST keep the final segment `billing-api` intact (truncating earlier segments with a leading ellipsis)
- **AND** the full absolute path MUST be available on hover

#### Scenario: A long host is right-truncated and width-capped

- **GIVEN** an instance whose host is `ip-10-0-42-118.ec2.internal`
- **WHEN** its host suffix renders
- **THEN** the host MUST be truncated from the right with a trailing ellipsis within a fixed maximum width
- **AND** it MUST NOT push the path or the status indicator out of the row

### Requirement: An owner SHALL be able to pin a target instance when @-mentioning an agent

When an owner @-mentions an agent in a comment, the mention SHALL remain addressed to the agent. When the mentioned agent has two or more live instances, the UI SHALL present a secondary picker letting the owner choose which `(host, cwd)` instance the mention targets; when the agent has exactly one live instance the UI SHALL auto-select it with no additional interaction. The chosen instance SHALL be pinned to the mention so that the resulting autonomous wake routes to that instance. The pinned target SHALL be expressed as `(host, cwd)` (a durable "place") rather than a specific connection id, and SHALL never be inferred from the comment's project. A mention that carries no pin SHALL behave exactly as before this change.

#### Scenario: Two live instances trigger a secondary picker

- **GIVEN** an owner @-mentions an agent that has two live instances
- **WHEN** the mention is being composed
- **THEN** the UI MUST present a secondary picker of the agent's live `(host, cwd)` instances for the owner to choose from

#### Scenario: A single live instance is auto-selected

- **GIVEN** an owner @-mentions an agent that has exactly one live instance
- **WHEN** the mention is being composed
- **THEN** that instance MUST be auto-selected with no additional picker interaction required

### Requirement: Instance pickers SHALL show only online instances; a fully-offline agent SHALL receive a plain notification

On every instance-picker surface (the @-mention secondary picker, the task-assignment cwd picker, and the ad-hoc send picker), the picker SHALL list ONLY online `(host, cwd)` instances. An offline instance SHALL NOT be shown at all — there SHALL be no disabled row and no "will queue" affordance, and an offline instance SHALL never be selectable. Over the online instances the rule SHALL be uniform across @-mention and task assignment: zero online instances → no picker is shown; exactly one → it is auto-pinned with no interaction; two or more → the picker is presented. Targeting an agent whose instances are ALL offline (a fully-offline agent) SHALL be allowed for both @-mention and task assignment and SHALL never be blocked; doing so SHALL record a PLAIN ordinary notification with NO pin and NO wake/turn/broadcast — there is no durable queue or backfill. When a task is assigned to a fully-offline agent, the assignment (assignee) SHALL still be persisted, but with NO `(host, cwd)` pin. A pinned target, when one is chosen, SHALL be persisted as `(host, cwd)` and SHALL never be inferred from the task's project.

#### Scenario: The picker shows only online instances

- **GIVEN** an agent with three instances, one online and two offline
- **WHEN** the owner opens the task-assignment or @-mention instance picker
- **THEN** the picker MUST list only the one online instance
- **AND** no offline row, disabled row, or "will queue" affordance MUST be shown

#### Scenario: Targeting a fully-offline agent records a plain notification

- **GIVEN** an owner assigns a task to (or @-mentions) an agent whose every instance is offline
- **WHEN** the action is submitted
- **THEN** it MUST be accepted (never blocked) and MUST record a plain notification with no pin
- **AND** NO DaemonSessionTurn MUST be created and NO wake/broadcast MUST be emitted (there is no durable queue)
- **AND** for a task assignment the assignee MUST still be persisted, with no `(host, cwd)` pin

#### Scenario: A single online instance is auto-pinned and a chosen pin is persisted

- **GIVEN** an owner assigns a task to an agent that has exactly one online instance
- **WHEN** the assignment is saved
- **THEN** that online instance MUST be auto-pinned and its `(host, cwd)` MUST be persisted with the assignment so a later autonomous wake can resolve it

### Requirement: The ad-hoc send flow SHALL let an owner pick an online instance

The immediate ad-hoc "send now" flow SHALL let the owner pick which online `(host, cwd)` instance receives the instruction. The picker SHALL list ONLY online instances — an offline instance is never a live-send target and SHALL NOT be shown — preserving the existing behavior that an instruction to an offline origin is rejected. The send confirmation SHALL show the resolved instance — including its host when the host is needed to disambiguate — before the instruction is sent.

#### Scenario: Only online instances appear in the ad-hoc picker

- **GIVEN** an agent with one online and one offline instance
- **WHEN** the owner opens the ad-hoc send picker
- **THEN** the picker MUST list only the online instance, and the offline one MUST NOT appear

#### Scenario: The send confirms the resolved instance

- **GIVEN** the owner has picked an online instance in the ad-hoc flow
- **WHEN** the send control renders
- **THEN** it MUST confirm the resolved `(host, cwd)` target before the instruction is sent

### Requirement: The autonomous wake SHALL honor a pinned cwd and fall back to online-first

When a `task_assigned` or `mentioned` notification wakes an agent, the connection-selection step SHALL honor a pinned target instance if one was recorded with the trigger: it SHALL resolve the `DaemonConnection` matching the pinned `(agentUuid, host, cwd)` AND being ONLINE, and pin the session origin to it. Only an online connection is wakeable — there is no durable queue, so a pin that matches an OFFLINE connection (or no connection at all), or a trigger with no pin, SHALL fall back to the existing online-first connection selection. When the agent has NO online connection at all, the wake SHALL create no turn and the already-recorded notification SHALL stand as the plain record. The wake SHALL NOT infer a cwd from the project under any circumstance. This behavior SHALL be additive: a trigger with no pin selects a connection exactly as before this change.

#### Scenario: A pinned online instance is honored at wake time

- **GIVEN** a `task_assigned` notification whose assignment pinned `(Laptop-Q3, dev/chorus)`
- **AND** an ONLINE connection matching that `(agent, host, cwd)` exists
- **WHEN** the wake selects a connection
- **THEN** it MUST pin the session origin to that matching online connection rather than the first online connection

#### Scenario: A pin matching an offline instance falls back to online-first (no queue)

- **GIVEN** a wake whose pin matches an OFFLINE connection while another instance is online
- **WHEN** the wake selects a connection
- **THEN** it MUST fall back to the online-first connection (the offline pin is not wakeable and is NOT queued/backfilled)

#### Scenario: An unpinned wake uses online-first as before

- **GIVEN** a wake notification that carries no pinned instance
- **WHEN** the wake selects a connection
- **THEN** it MUST select the first online connection exactly as before this change, with no cwd inference from the project

### Requirement: The chat transcript header SHALL surface the session's cwd

The daemon conversation transcript header SHALL display the session's working directory (`cwd`) inline as the conversation's instance identity, rendered with the same path-first treatment used elsewhere. The connection's `host` SHALL remain in the existing "Connection details" disclosure rather than the headline, surfaced inline only when needed to disambiguate across hosts. When the session's origin connection reports no cwd, the header SHALL show the "unknown path" treatment consistent with the presence surface.

#### Scenario: The header shows which directory a conversation runs in

- **GIVEN** an open daemon conversation whose origin connection has cwd `dev/chorus`
- **WHEN** the transcript header renders
- **THEN** it MUST show `dev/chorus` inline (path-first) as the conversation's instance identity
- **AND** the host MUST remain in the "Connection details" disclosure rather than the headline

