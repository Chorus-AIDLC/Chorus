## ADDED Requirements

### Requirement: Research SHALL require an assigned online agent

The Tracker Research UI SHALL require an agent or agent-instance assignment with
an owning agent having at least one presence connection whose effectiveStatus is
online. It SHALL keep the unavailable action visible and prevent dispatch and
picker opening. It SHALL use the same agent-level presence baseline as YOLO;
exact origin, instance and cwd availability SHALL remain server-authoritative.

#### Scenario: No agent assignment
- **WHEN** the Idea has no assignee or is assigned to a human
- **THEN** Research is disabled and explains that an agent must be assigned first
- **AND** activation opens no agent chooser and sends no Research request

#### Scenario: Assigned agent offline
- **WHEN** the owning agent has no effectively online connections, including absent presence data
- **THEN** Research is disabled with an actionable offline explanation
- **AND** stale connections or connections of another agent do not enable it

#### Scenario: Assigned agent instance online
- **WHEN** an agent-instance assignee's owning agent has an effectively online connection and the other Research prerequisites are met
- **THEN** Research can be triggered using the existing Research dispatch flow

### Requirement: Research availability SHALL update with mounted UI state

Research SHALL update its availability as presence and assignment change without
requiring a page reload. Existing stage eligibility and submission constraints
SHALL continue to apply, including when the agent returns online.

#### Scenario: Disconnect and reconnect
- **WHEN** the assigned agent disconnects while the action menu is open
- **THEN** Research becomes disabled before another selection can dispatch
- **AND** reconnecting enables it only when assignment, stage and busy prerequisites are satisfied

#### Scenario: Assignment changes
- **WHEN** the Idea is unassigned or assigned to a different agent while mounted
- **THEN** Research evaluates the current owning agent and cannot use the previous agent's online state

#### Scenario: Other blocking conditions
- **WHEN** eligibility is loading, fails, rejects development/completion, or submission is in flight
- **THEN** online presence alone does not enable Research

### Requirement: Research SHALL explain unavailability across input surfaces

Desktop and mobile actions SHALL expose localized English and Chinese reasons,
aria-disabled and an accessible description. Disabled items SHALL remain
discoverable by keyboard. Pointer and keyboard activation SHALL not dispatch.

#### Scenario: Desktop disabled action
- **WHEN** a user focuses or hovers unavailable Research in the desktop menu
- **THEN** its reason is accessible and discoverable through the existing tooltip pattern
- **AND** click, Enter and Space do not dispatch or open a picker

#### Scenario: Mobile disabled action
- **WHEN** Research is unavailable in the mobile action sheet
- **THEN** the reason is visible inline and tapping or keyboard activation cannot dispatch

### Requirement: Research SHALL retain assigned-agent dispatch safeguards

Research SHALL preserve server eligibility, authorization and origin checks,
assigned-agent cwd selection, single in-flight submission, accepted-request
queued feedback, and error/retry behavior. It SHALL NOT change Verify/Resolve
or YOLO behavior.

#### Scenario: Assigned agent needs cwd selection
- **WHEN** an assigned online agent's new Research root requires cwd disambiguation
- **THEN** the existing pin-then-wake flow can select its target and retry Research atomically without a generic lifecycle assignment

#### Scenario: Client presence is stale
- **WHEN** the client allows Research but the server rejects its target as offline or changed
- **THEN** the UI reports the existing failure and does not claim successful dispatch

#### Scenario: Repeat requests
- **WHEN** a Research submission is already in flight
- **THEN** duplicate clicks send no additional request
- **AND** after acceptance or retryable failure another explicit request is possible if prerequisites still hold
