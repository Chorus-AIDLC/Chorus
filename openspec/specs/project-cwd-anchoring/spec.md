# project-cwd-anchoring Specification

## Purpose
TBD - created by archiving change unify-project-agent-cwd-anchoring. Update Purpose after archive.
## Requirements
### Requirement: Fixed project-Agent cwd is the authoritative new-work anchor

For the current user, Chorus SHALL resolve a saved fixed cwd before any temporary cwd,
registered instance, auto-selection, or picker behavior whenever new project work targets
that Agent. The resolved target MUST include the actor user, Agent, host, cwd, source, and
availability state, and callers MUST NOT independently reinterpret the preference.

#### Scenario: Idea is assigned to an Agent with a fixed cwd
- **WHEN** a user assigns a new or existing Idea to an Agent with a ready fixed cwd
- **THEN** Chorus MUST persist that host and cwd as the Idea's hard execution anchor
- **AND** it MUST NOT display an instance or cwd picker

#### Scenario: Task targets another Agent
- **WHEN** a Task is assigned to Agent B while its root Idea is anchored to Agent A
- **THEN** Chorus MUST resolve Agent B's own project preference independently
- **AND** it MUST NOT inherit Agent A's cwd

#### Scenario: Fixed preference is cleared
- **WHEN** the user clears the Agent's fixed cwd and starts a later assignment
- **THEN** Chorus MUST restore the existing online-instance auto-selection or picker behavior
- **AND** temporary discovered-cwd selection MUST again be available for that operation

#### Scenario: One operation spans multiple stages
- **WHEN** an assignment or stage-entry operation resolves its project-Agent cwd target
- **THEN** every later stage of that operation MUST reuse the same actor-bearing resolved target
- **AND** it MUST NOT re-resolve against a changed preference, actor, or connection registry

### Requirement: Root Idea anchor governs same-Agent downstream flows

Once a root Idea has a hard cwd anchor, Chorus MUST make same-Agent proposal, task,
stage-advance, Yolo, wake, and continuation entry points inherit that immutable target
through the shared resolution chain. They MUST NOT reopen an instance/cwd picker or re-read
a mutable project preference to replace the established anchor.

#### Scenario: Start Development inherits the root anchor
- **WHEN** Start Development is invoked for an Idea anchored to a fixed host and cwd
- **THEN** Chorus MUST use that exact target without another picker

#### Scenario: Proposal stage advance inherits the root anchor
- **WHEN** an approval or elaboration transition wakes the same Agent under an anchored Idea
- **THEN** the wake MUST target the root Idea's host and cwd

#### Scenario: Preference changes after anchoring
- **WHEN** a user replaces or clears the project preference after an Idea was anchored
- **THEN** the existing Idea and its active sessions MUST keep their original target
- **AND** the new preference MUST apply only to later anchors

### Requirement: Fixed anchors preserve hard-pin failure behavior

A fixed project cwd SHALL remain a hard target when its host is offline or its path is
invalid. Chorus MUST expose a typed state and MUST NOT silently fall back to another
connection, cwd, or Agent instance.

#### Scenario: Recoverable wake targets an offline fixed host
- **WHEN** a recoverable wake resolves to a fixed target whose host is offline
- **THEN** delivery MUST remain notify-only for that target
- **AND** reconnect backfill MAY deliver it only to the original host and cwd

#### Scenario: Require-online action targets an unavailable fixed cwd
- **WHEN** Start Development, Yolo, or another require-online action resolves an offline or invalid fixed target
- **THEN** the action MUST fail with a distinguishable typed error
- **AND** no other cwd of the Agent may be woken

#### Scenario: UI encounters an unavailable fixed cwd
- **WHEN** an assignment or stage-entry surface resolves an offline or invalid fixed target
- **THEN** it MUST show the fixed host, cwd, and state with a project-settings replace or clear action
- **AND** it MUST NOT show an alternate cwd picker

### Requirement: Active session cwd remains sticky

Every directed session SHALL persist its runtime cwd and origin connection, and resume,
continuation, and delivered instruction turns MUST reuse those values regardless of later
project preference changes.

#### Scenario: Preference changes during an active session
- **WHEN** the user replaces or clears the fixed cwd after a directed session starts
- **THEN** the next resume or continuation MUST use the session's original runtime cwd and origin connection

#### Scenario: Origin host is unavailable during resume
- **WHEN** an active session's origin host is offline
- **THEN** Chorus MUST report the existing resume failure state
- **AND** it MUST NOT start a replacement session in the current project preference

### Requirement: Fixed-anchor UI suppresses cwd selection

Every project workflow surface that would otherwise ask for an Agent instance or cwd SHALL
hide that picker when a fixed target exists. Assignment and stage-entry surfaces other
than the Proposal header MUST display a read-only anchor summary and a route to manage the
preference in Project Settings. The Proposal header MUST suppress its redundant read-only
anchor card while retaining fixed-target execution behavior.

#### Scenario: Fixed target is ready
- **WHEN** a fixed Agent target is available on an assignment or stage-entry surface other than the Proposal header
- **THEN** the surface MUST display the resolved host and cwd
- **AND** no selectable instance or temporary-directory control may be rendered

#### Scenario: Proposal header has a fixed target
- **WHEN** Proposal actions resolve a fixed Agent target
- **THEN** the Proposal header MUST NOT render `FixedCwdAnchor`
- **AND** proposal actions MUST retain the fixed target for execution without showing an alternate cwd picker

#### Scenario: Multiple Agents have fixed targets
- **WHEN** a project has independent fixed cwd preferences for Agent A and Agent B
- **THEN** selecting either Agent outside the Proposal header MUST display only that Agent's anchor
- **AND** changing one preference MUST NOT alter the other Agent's UI or resolution

### Requirement: Autonomous wakes resolve the agent-owner's fixed project cwd
Autonomous server-minted wakes SHALL resolve a fixed project-Agent cwd before falling back to raw first-online-connection selection, closing the gap where only UI-threaded and stage-advance wakes honored the fixed anchor. The project pin SHALL replace exactly the first-online ("first cwd") fallback and SHALL sit below the existing higher-priority resolution steps: it SHALL apply only when the selection would otherwise be a raw first-online pick — that is, when no idea/task instance pin, no pre-resolved cwd target, and no existing ONLINE idea-session-origin apply. An existing online idea-session-origin (the cwd where the idea's live conversation already runs) SHALL take precedence over the project pin so a live conversation is never rerouted. When those higher-priority steps do not apply, Chorus SHALL look up the `ProjectAgentCwdPreference` of that **Agent's owner** for the wake's `(project, Agent)` pair, and when one exists SHALL treat its `(host, cwd)` as a hard execution anchor and SHALL NOT select the first online connection. When the Agent owner has no preference for that `(project, Agent)`, resolution SHALL fall back to the existing online-first behavior unchanged. This change SHALL add no database schema change, no migration, and no new permission bit.

For this fallback, "autonomous server-minted wakes" SHALL include the un-pinned `mentioned` wake: the `Agent` is the mentioned agent, and the `project` is the mention target's project (via the mention's root Idea when one exists). Thus an `@mention` of an agent that is pinned only at the project level — with no explicit in-mention pin, no instance pin, and no online idea-session-origin for that agent — SHALL land in the owner-pinned `(host, cwd)` rather than an arbitrary first-online cwd. A `human_instruction` wake SHALL remain excluded from this fallback (its target is resolved by the instruction send path, not this chokepoint).

#### Scenario: Autonomous wake uses the owner's project pin instead of the first cwd
- **WHEN** an autonomous wake is minted for an Agent that has a fixed project cwd pin set by its owner, the Idea/Task carries no instance pin, and the Agent is online in that pinned cwd plus another cwd
- **THEN** the wake MUST target the owner-pinned `(host, cwd)`
- **AND** it MUST NOT select the other (first-online) cwd

#### Scenario: An un-pinned mention uses the owner's project pin
- **WHEN** an un-pinned `@mention` wakes an Agent whose owner has a fixed project cwd pin for the mention target's project, the mention carries no explicit pin, no instance pin applies, and the mentioned Agent has no online idea-session-origin for that idea
- **THEN** the wake MUST target the owner-pinned `(host, cwd)`
- **AND** it MUST NOT select an arbitrary first-online cwd

#### Scenario: Pinned cwd offline does not reroute
- **WHEN** an autonomous wake resolves to the owner's fixed project cwd but that `(host, cwd)` has no online connection, while the same Agent is online in a different cwd
- **THEN** the wake MUST NOT reroute to the other online cwd
- **AND** it MUST follow the existing fixed-anchor hard-pin failure behavior (notify-only for a recoverable wake, reconnect backfill only to the original host and cwd)

#### Scenario: An online idea-session-origin outranks the project pin
- **WHEN** an autonomous idea-anchored wake has no instance pin, the idea already has an online session-origin in cwd A, and the Agent owner's project pin names a different cwd B
- **THEN** the wake MUST target the existing online session-origin cwd A (the live conversation)
- **AND** it MUST NOT reroute to the project-pinned cwd B

#### Scenario: No owner preference falls back to online-first
- **WHEN** an autonomous wake is minted for an Agent whose owner has no fixed project cwd preference for that project and Agent
- **THEN** resolution MUST fall back to the existing online-first selection unchanged

#### Scenario: Pre-resolved and instance-pinned wakes are unaffected
- **WHEN** a wake already carries a pre-resolved cwd target or an idea/task instance pin
- **THEN** its existing resolution precedence MUST be preserved
- **AND** the owner-project-pin step MUST NOT override it

