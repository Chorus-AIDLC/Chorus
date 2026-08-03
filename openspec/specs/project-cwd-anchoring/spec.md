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
hide that picker when a fixed target exists. The surface MUST display a read-only anchor
summary and a route to manage the preference in project settings.

#### Scenario: Fixed target is ready
- **WHEN** a fixed Agent target is available on an assignment or stage-entry surface
- **THEN** the surface MUST display the resolved host and cwd
- **AND** no selectable instance or temporary-directory control may be rendered

#### Scenario: Multiple Agents have fixed targets
- **WHEN** a project has independent fixed cwd preferences for Agent A and Agent B
- **THEN** selecting either Agent MUST display only that Agent's anchor
- **AND** changing one preference MUST NOT alter the other Agent's UI or resolution
