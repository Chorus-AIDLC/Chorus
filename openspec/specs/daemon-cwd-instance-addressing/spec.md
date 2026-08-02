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

When an owner @-mentions an agent in a comment, the mention SHALL remain addressed to the agent. The picker-trigger behavior SHALL first honor the pin state of the comment's **root Idea** (resolved via the shared root-idea resolver) for the Idea's assignee agent:

- **When the @-mentioned agent IS the root Idea's assignee agent AND the root Idea is pinned to an instance** (`assigneeType = "agent_instance"`), the mention SHALL inherit that idea's `(host, cwd)` pin with NO picker — even when that instance is currently offline (the inherited pin is HARD: the resulting wake is notify-only, never re-routed to another cwd). The system SHALL NOT prompt the owner to re-choose a cwd that the Idea already fixes.
- **When the @-mentioned agent IS the root Idea's assignee agent AND the root Idea is NOT instance-pinned**, the picker SHALL follow the online-instance rule below (two or more online instances → picker; exactly one → auto-select; none → un-pinned).
- **When the @-mentioned agent is NOT the root Idea's assignee agent** (a different agent, or the comment has no root Idea), the picker SHALL follow the online-instance rule below, and the chosen instance SHALL NOT be persisted to the Idea — the owner re-chooses on each such mention.

The online-instance rule (applied in the two non-inheriting cases above): when the mentioned agent has two or more live instances, the UI SHALL present a secondary picker letting the owner choose which `(host, cwd)` instance the mention targets; when the agent has exactly one live instance the UI SHALL auto-select it with no additional interaction. The pin inherited or chosen SHALL always be the root Idea's pin (never a per-resource / per-task pin) when inheriting, and SHALL be expressed as `(host, cwd)` (a durable "place") rather than a specific connection id, and SHALL never be inferred from the comment's project. A mention that carries no pin SHALL behave exactly as before this change.

#### Scenario: Mentioning the idea's assignee agent inherits the idea's pin with no picker

- **GIVEN** a comment box on an Idea (or a Task derived from that Idea) whose root Idea is pinned to instance A of agent G
- **WHEN** the owner @-mentions agent G
- **THEN** the mention MUST inherit instance A's `(host, cwd)` pin
- **AND** no secondary picker MUST be presented, even if agent G has other online instances

#### Scenario: Mentioning the idea's assignee agent when the idea is unpinned still prompts on ambiguity

- **GIVEN** a comment box whose root Idea is assigned to a bare agent G (not instance-pinned) and G has two or more online instances
- **WHEN** the owner @-mentions agent G
- **THEN** the UI MUST present the secondary picker of G's online instances

#### Scenario: Mentioning a different agent is not persisted and prompts each time

- **GIVEN** a comment box whose root Idea is pinned to agent G, and a different agent H with two or more online instances
- **WHEN** the owner @-mentions agent H
- **THEN** the UI MUST present the secondary picker for H
- **AND** the chosen instance MUST NOT change the Idea's assignee (it is re-chosen on the next such mention)

#### Scenario: Inheriting an offline idea pin stays notify-only

- **GIVEN** a comment box whose root Idea is pinned to instance A of agent G, and instance A currently has no online connection
- **WHEN** the owner @-mentions agent G and posts the comment
- **THEN** the mention MUST carry instance A's pin
- **AND** the resulting wake MUST be notify-only (not re-routed to another online cwd of G)

#### Scenario: A single live instance is auto-selected

- **GIVEN** an owner @-mentions an agent that has exactly one live instance and no inheritable idea pin applies
- **WHEN** the mention is being composed
- **THEN** that instance MUST be auto-selected with no additional picker interaction required

#### Scenario: A mention with no pin behaves as before

- **GIVEN** an owner @-mentions an agent with no live instances and no inheritable idea pin
- **WHEN** the mention is composed and posted
- **THEN** the mention MUST carry no pin and behave exactly as before this change

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

When a `task_assigned` or `mentioned` notification wakes an agent, the connection-selection step SHALL honor a pinned target instance if one was recorded with the trigger: it SHALL resolve the `DaemonConnection` matching the pinned `(agentUuid, host, cwd)` AND being ONLINE, and pin the session origin to it. A trigger with NO pin SHALL fall back to the existing online-first connection selection, exactly as before this change. A PINNED trigger whose pin matches NO online connection (the pinned instance is offline, or the place is not registered) SHALL create NO turn and SHALL wake NO instance: the already-recorded notification SHALL stand as the plain record (notify-only) — the wake SHALL NOT silently fall back to a different online instance, because routing a pinned wake to a cwd the user did not choose is the user-visible defect this change fixes. When the agent has NO online connection at all (pinned or not), the wake likewise SHALL create no turn and the notification SHALL stand as the plain record. There is no durable queue or backfill that holds a pinned turn until its instance comes online. The wake SHALL NOT infer a cwd from the project under any circumstance.

Beyond selecting the origin connection, the LIVE wake for a PINNED `task_assigned` or `mentioned` notification SHALL be DIRECTED so that only the daemon at the resolved online `(host, cwd)` instance wakes and answers. The server SHALL emit a `deliver_turn` control ping on the resolved target connection's `control:{connectionUuid}` channel carrying the created turn's precise `turnUuid`, reusing the existing reverse-control / pending-turn machinery that already delivers `human_instruction` turns. Because the notification SSE stream is per-agent (every online connection of the agent receives the same `new_notification`), the resolved target connection SHALL ALSO be communicated to the daemon as transport-only data on the notification the daemon reads (NOT a persisted column) so that each daemon can compare it to its own registered connection identity: a daemon whose own connection identity is NOT the resolved target SHALL suppress the broadcast wake for that pinned notification; the daemon whose connection identity IS the target SHALL wake (and the target's broadcast copy and `deliver_turn` delivery SHALL collapse to exactly one wake via the shared dedup set). A wake that carries NO resolved target (an un-pinned `task_assigned`/`mentioned`, or a pinned/offline wake for which no turn was created) SHALL behave exactly as before this change — no `deliver_turn` is emitted, no suppression occurs, and an un-pinned broadcast wakes the online-first daemon. A daemon that has not yet learned its own connection identity (before the SSE handshake completes) SHALL treat a targeted wake as "not mine" and suppress it, relying on the `deliver_turn` delivery to the actual target and the reconnect pending-turn backfill. The directed-delivery transport SHALL reuse the existing reverse control channel and pending-turn machinery (`control:{connectionUuid}` / `deliver_turn` / the connection-scoped pending-turns read); it SHALL NOT add a new transport, a new permission bit, or a schema migration.

For the session business key, a DIRECTED idea-anchored wake SHALL keep ONE conversation per idea per agent (`sessionId === directIdeaUuid`) and SHALL NOT fork a per-instance session. When the resolved online origin connection differs from the idea's existing canonical session origin (the cross-cwd case), the wake SHALL RE-POINT that canonical session's `originConnectionUuid` to the resolved online origin and create the turn on the SAME session row, so the user's turn and the daemon's transcript/turn-lifecycle reports land on the same conversation. This re-point is the second — and only other — deliberate, companyUuid-scoped reversal of the write-once `originConnectionUuid` invariant, alongside the explicit `repointSessionOriginAndSend` send path; the autonomous wake SHALL NOT create a `${directIdeaUuid}::${connectionUuid}` per-instance session. Re-pointing is safe because the daemon probes the on-disk transcript per-cwd and starts a fresh session in a new cwd rather than failing `claude --resume`; prior turns remain as read-only history on the same row. This re-point SHALL NOT add a schema migration, a new column, or a new endpoint.

#### Scenario: A pinned online instance is honored at wake time

- **GIVEN** a `task_assigned` notification whose assignment pinned `(Laptop-Q3, dev/chorus)`
- **AND** an ONLINE connection matching that `(agent, host, cwd)` exists
- **WHEN** the wake selects a connection
- **THEN** it MUST pin the session origin to that matching online connection rather than the first online connection

#### Scenario: A pin matching an offline instance wakes no instance (notify-only)

- **GIVEN** a `mentioned` (or `task_assigned`) wake whose pin matches an OFFLINE connection while another instance of the same agent is online
- **WHEN** the wake resolves its target
- **THEN** it MUST create no turn and wake NO instance (the already-recorded notification stands as the plain record)
- **AND** it MUST NOT silently fall back to the other online instance (routing to an unchosen cwd is the defect being fixed)
- **AND** the pinned turn MUST NOT be queued or backfilled to wait for the pinned instance to come online

#### Scenario: An unpinned wake uses online-first as before

- **GIVEN** a wake notification that carries no pinned instance
- **WHEN** the wake selects a connection
- **THEN** it MUST select the first online connection exactly as before this change, with no cwd inference from the project

#### Scenario: Only the pinned daemon wakes when two instances are online

- **GIVEN** an agent with two ONLINE instances, `(Laptop-Q3, dev/ai-pm)` and `(Laptop-Q3, dev/strands)`
- **AND** a `mentioned` notification pinned to `(Laptop-Q3, dev/ai-pm)`
- **WHEN** both daemons receive the agent-wide `new_notification` broadcast
- **THEN** only the `dev/ai-pm` daemon MUST wake and answer
- **AND** the `dev/strands` daemon MUST suppress the wake because it is not the resolved target

#### Scenario: An un-pinned mention still wakes the online-first daemon

- **GIVEN** an agent with two online instances
- **AND** a `mentioned` notification that carries no pin
- **WHEN** both daemons receive the broadcast
- **THEN** the wake MUST proceed exactly as before this change (no target is stamped, so no suppression occurs and the online-first daemon answers)

#### Scenario: A daemon that has not yet registered suppresses a targeted wake

- **GIVEN** a pinned `mentioned` notification carrying a resolved target connection
- **AND** a daemon that has not yet learned its own connection identity (handshake incomplete)
- **WHEN** that daemon receives the broadcast
- **THEN** it MUST treat the targeted wake as "not mine" and suppress it
- **AND** delivery MUST rely on the precise reverse-channel delivery / reconnect pending-turn backfill to the actual target

#### Scenario: A cross-cwd directed idea wake re-points the canonical session instead of forking

- **GIVEN** an idea whose existing daemon session origin is the ONLINE-or-offline instance `(Laptop-Q3, dev/ai-pm)` and whose session has `sessionId === directIdeaUuid`
- **AND** a directed idea-anchored wake (e.g. a pinned `task_assigned`, or a `human_instruction` resolved to a different instance) resolves to a different ONLINE instance `(Laptop-Q3, dev/strands)`
- **WHEN** the wake creates the turn
- **THEN** it MUST re-point the SAME canonical session's `originConnectionUuid` to `(Laptop-Q3, dev/strands)` and create the turn on that same session row (keeping `sessionId === directIdeaUuid`, `directIdeaUuid` non-null)
- **AND** it MUST NOT create a `${directIdeaUuid}::${connectionUuid}` per-instance session
- **AND** the user's turn and the daemon's later transcript/turn-lifecycle reports MUST land on the same conversation so the running turn is interruptible from the thread the user is viewing

### Requirement: The chat transcript header SHALL surface the session's cwd

The daemon conversation transcript header SHALL display the session's working directory (`cwd`) inline as the conversation's instance identity, rendered with the same path-first treatment used elsewhere. The connection's `host` SHALL remain in the existing "Connection details" disclosure rather than the headline, surfaced inline only when needed to disambiguate across hosts. When the session's origin connection reports no cwd, the header SHALL show the "unknown path" treatment consistent with the presence surface.

#### Scenario: The header shows which directory a conversation runs in

- **GIVEN** an open daemon conversation whose origin connection has cwd `dev/chorus`
- **WHEN** the transcript header renders
- **THEN** it MUST show `dev/chorus` inline (path-first) as the conversation's instance identity
- **AND** the host MUST remain in the "Connection details" disclosure rather than the headline

### Requirement: The proposal-writing wake SHALL be directed to the idea's existing session origin

An autonomous, idea-anchored wake SHALL be directed to the daemon instance where that idea's conversation already lives — its existing `DaemonSession.originConnectionUuid` for the idea-anchored session (`sessionId === directIdeaUuid`) — rather than fanning out to an arbitrary online instance of the agent, whenever the connection selection would otherwise fall to agent-overall online-first. This direction SHALL apply to the autonomous idea-anchored trigger family: the elaboration-resolve / "Verify Elaborate" handoff wake (`elaboration_verified`), the proposal-review wakes (`proposal_approved` and `proposal_rejected`), the idea-claimed wake (`idea_claimed`), the elaboration request/answer wakes (`elaboration_requested` / `elaboration_answered`), and the task-assignment wakes (`task_assigned` / `task_verified` / `task_reopened`) — every wake that resolves to an Idea anchor and is not already pinned. It SHALL NOT apply to a `mentioned` wake (an un-pinned mention is contractually a broadcast → online-first wake, and a pinned mention is resolved as a hard pin) nor to a `human_instruction` wake (whose exact target session and live delivery are resolved by the instruction send path, not the wake chokepoint).

The `Idea` entity carries no pinned-instance columns, so the origin SHALL be taken from the idea's existing session. This direction SHALL apply ONLY when no higher-priority pin matched — that is, only when the connection selection is online-first; a hard mention pin or a soft assignment / idea-instance pin that resolves to an online connection takes priority and SHALL skip this upgrade, preserving the resolution order hard mention pin → soft assignment/idea-instance pin → idea session origin → agent online-first. When the idea has NO existing daemon session (it was elaborated entirely in the UI and the daemon was never woken on it), or that session's origin is offline, the wake SHALL fall back to the existing online-first selection. This wake SHALL reuse the same directed-delivery transport as the pinned `mentioned` / `task_assigned` wakes (the resolved target communicated to the daemon for broadcast suppression); it SHALL NOT introduce an Idea pin column, a new picker, a new permission bit, or a schema migration.

#### Scenario: A proposal-approval wake targets the idea's session origin

- **GIVEN** an idea with an existing daemon session whose origin is the ONLINE instance `(Laptop-Q3, dev/ai-pm)`
- **AND** the same agent also has another online instance `(Laptop-Q3, dev/strands)`
- **AND** the idea is NOT pinned to any `agent_instance`
- **WHEN** that idea's proposal is approved and the `proposal_approved` wake is dispatched
- **THEN** only the `dev/ai-pm` daemon MUST wake to handle the approval
- **AND** the `dev/strands` daemon MUST suppress the wake

#### Scenario: A proposal-rejection wake targets the idea's session origin

- **GIVEN** an idea with an existing daemon session whose origin is an ONLINE instance, the agent having another online instance, and the idea not pinned to an `agent_instance`
- **WHEN** that idea's proposal is rejected and the `proposal_rejected` wake is dispatched
- **THEN** only the daemon at the idea's session origin MUST wake to handle the rejection
- **AND** the agent's other online instance MUST suppress the wake

#### Scenario: An idea-claimed wake targets the idea's session origin

- **GIVEN** an idea with an existing online session origin and an un-pinned assignment, the agent having another online instance
- **WHEN** the `idea_claimed` wake is dispatched
- **THEN** the wake MUST be directed to the idea's session origin rather than agent-overall online-first

#### Scenario: Verify Elaborate wakes the cwd where the idea conversation already lives

- **GIVEN** an idea with an existing daemon session whose origin is the ONLINE instance `(Laptop-Q3, dev/ai-pm)`
- **AND** the same agent also has another online instance `(Laptop-Q3, dev/strands)`
- **WHEN** a human clicks "Verify Elaborate" and the `elaboration_verified` wake is dispatched
- **THEN** only the `dev/ai-pm` daemon MUST wake to write the proposal
- **AND** the `dev/strands` daemon MUST suppress the wake

#### Scenario: An instance-pinned idea takes the pin over the session origin

- **GIVEN** an idea pinned to the ONLINE `agent_instance` A
- **AND** the idea's existing daemon session origin is a DIFFERENT online instance B of the same agent
- **WHEN** a `proposal_approved` (or any autonomous idea-anchored) wake is dispatched
- **THEN** the wake MUST target instance A (the higher-priority pin)
- **AND** the session-origin upgrade MUST be skipped

#### Scenario: Falls back to online-first when no session exists

- **GIVEN** an idea that was elaborated entirely in the UI, with NO existing daemon session
- **WHEN** an autonomous idea-anchored wake (e.g. `proposal_approved` or `elaboration_verified`) is dispatched
- **THEN** the wake MUST fall back to the existing online-first selection (no target is stamped)
- **AND** the behavior MUST match the pre-change wake exactly

#### Scenario: Falls back when the idea's session origin is offline

- **GIVEN** an idea whose existing session origin instance is OFFLINE
- **AND** the agent has another online instance
- **WHEN** an autonomous idea-anchored wake is dispatched
- **THEN** it MUST fall back to online-first selection (the offline origin is not wakeable and is not queued)

#### Scenario: An un-pinned mention is not redirected to the idea session origin

- **GIVEN** an agent with two online instances, one of which is the origin of some idea's session
- **AND** a `mentioned` notification that carries no pin
- **WHEN** the wake selects a connection
- **THEN** it MUST select the online-first connection with NO target stamped (broadcast), exactly as before this change
- **AND** it MUST NOT be redirected to any idea's session origin

#### Scenario: A human instruction is not re-targeted by the wake chokepoint

- **WHEN** a `human_instruction` wake is processed at the notification chokepoint
- **THEN** the chokepoint MUST NOT apply the idea-session-origin upgrade to it
- **AND** its target and live delivery MUST come solely from the instruction send path

### Requirement: The instance-picker dialog stays usable on a short viewport

The `@`-mention cwd picker dialog SHALL remain fully operable regardless of the visible viewport height, including when a mobile soft keyboard or browser URL bar shrinks the visible viewport.
The dialog is shown when a mentioned agent has two or more online instances. The dialog's
title and its action footer (the Cancel control and the Pin-instance / confirm control) SHALL
always be visible and clickable; only the instance list SHALL scroll when the instances do not
all fit. The dialog SHALL cap its height to the visible viewport using a dynamic-viewport
height unit (e.g. `svh`/`dvh`) rather than a static layout-viewport unit (`vh`), so the cap
tracks the soft keyboard. The dialog SHALL NOT overflow past the top or bottom edge of the
visible viewport, and the confirm control SHALL NOT be pushed off-screen with no means to
reach it.

#### Scenario: Many instances on a short mobile viewport keep the confirm button reachable

- **WHEN** an owner opens the `@`-mention cwd picker for an agent with enough online
  instances that the picker's natural height exceeds the visible (soft-keyboard-shortened)
  mobile viewport
- **THEN** the dialog's height is capped to the visible viewport, the instance list scrolls
  inside the dialog, and the Pin-instance confirm button remains visible and clickable at
  the bottom of the dialog

#### Scenario: Selecting a cwd on mobile enables and exposes the confirm button

- **WHEN** an owner selects one of the cwd rows in the `@`-mention cwd picker on a mobile
  viewport
- **THEN** the Pin-instance confirm button becomes enabled AND is within the visible
  viewport so the owner can tap it to pin the chosen instance

#### Scenario: A short instance list renders without an internal scrollbar

- **WHEN** an owner opens the `@`-mention cwd picker for an agent whose online instances all
  fit within the viewport-capped dialog height
- **THEN** the dialog renders the full list with the title and footer visible and introduces
  no internal scrolling beyond what the content needs

### Requirement: A wake SHALL have one immutable runtime working directory
Every daemon wake SHALL resolve exactly one runtime working directory before transcript probing or process spawn. For a startup-connection wake, that directory SHALL remain the connection-bound cwd. For a directed discovered-cwd wake, it SHALL be the validated `runtimeCwd` persisted on the daemon session. Transcript probing, spawn, resume, and subsequent turns MUST all consume that same value. A directed runtime cwd MUST NOT mutate the daemon's process cwd, startup `cwds`, or another concurrent wake's directory.

#### Scenario: Startup connection wake
- **WHEN** a wake is delivered through an existing cwd-bound connection without a directed runtime cwd
- **THEN** probing and spawn MUST use that connection's cwd exactly as before

#### Scenario: Directed discovered-cwd wake
- **WHEN** an authorized wake targets an allowed runtime cwd on the connection's host
- **THEN** the daemon MUST create or reuse an isolated runtime context bound to that cwd
- **AND** probing and spawn MUST use the runtime cwd

#### Scenario: Concurrent runtime directories
- **WHEN** one daemon runs wakes for two different runtime cwd values concurrently
- **THEN** each wake MUST retain its own cwd, transcript namespace, execution state, and session continuation without cross-talk

