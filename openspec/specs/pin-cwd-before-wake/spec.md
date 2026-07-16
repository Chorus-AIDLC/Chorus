# pin-cwd-before-wake Specification

## Purpose
TBD - created by archiving change pin-cwd-before-wake. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL expose a read-only wake-target preview for an Idea

The system SHALL provide a read-only, company-scoped endpoint that reports, for a given Idea and its resolved assignee agent, which of three pre-wake outcomes applies, so the client knows whether to prompt for a cwd, silently pin a cwd, or wake directly. The preview SHALL classify the outcome as exactly one of:

- **`pick`** — the Idea's assignee is a bare agent (`assigneeType = "agent"`, not `"agent_instance"`) and that agent has **two or more** effectively-online daemon connections. The client SHALL prompt with the online instance list and persist the choice. This outcome SHALL NOT be suppressed by the Idea already having an online session-origin connection — a bare agent with two or more online connections ALWAYS prompts, so a conversational-entry / already-elaborated Idea (which always has a session-origin before the wake button is clicked) is still durably pinned to the chosen cwd rather than silently re-waking its existing session.
- **`auto_pin`** — the assignee is a bare agent with **exactly one** effectively-online connection. The client SHALL persist that single instance as the assignee (no prompt) before waking, so the Idea becomes durably pinned to the cwd it will actually run in.
- **`direct`** — every other case: the Idea is already `agent_instance`-pinned; OR the agent has no online connection; OR the Idea has no agent assignee. The client SHALL wake directly with no prompt and no reassign.

The preview SHALL return the agent's currently-online `(host, cwd)` candidate instances, each carrying its durable `AgentInstance` reference so a subsequent pin can persist it, plus the resolved assignee agent uuid. The preview SHALL NOT wake the agent, mutate the assignee, or emit any activity. "Effectively online" SHALL reuse the daemon-connection registry's existing status+staleness rule rather than defining a new threshold.

#### Scenario: A bare-agent idea with two online cwds yields pick

- **GIVEN** an Idea assigned to a bare `agent` whose agent has two effectively-online daemon connections on different cwds
- **WHEN** the wake-target preview is requested for that Idea
- **THEN** the preview MUST report outcome `pick`
- **AND** it MUST return both online `(host, cwd)` instances with their durable `AgentInstance` references

#### Scenario: A bare-agent idea with two online cwds still yields pick even with an online session-origin

- **GIVEN** an Idea assigned to a bare `agent` whose agent has two effectively-online daemon connections
- **AND** the Idea already has an effectively-online session-origin connection
- **WHEN** the wake-target preview is requested for that Idea
- **THEN** the preview MUST report outcome `pick` (the session-origin MUST NOT suppress the prompt)
- **AND** the chosen instance MUST be persisted as the Idea's assignee so its cwd shows on the assignee line

#### Scenario: A bare-agent idea with exactly one online connection yields auto_pin

- **GIVEN** an Idea assigned to a bare `agent` whose agent has exactly one effectively-online connection
- **WHEN** the wake-target preview is requested
- **THEN** the preview MUST report outcome `auto_pin`
- **AND** it MUST return that single online instance with its durable `AgentInstance` reference

#### Scenario: An already-instance-pinned idea yields direct

- **GIVEN** an Idea whose `assigneeType` is `"agent_instance"`
- **WHEN** the wake-target preview is requested
- **THEN** the preview MUST report outcome `direct`

#### Scenario: The preview never wakes or mutates

- **WHEN** the wake-target preview is requested for any Idea
- **THEN** no daemon wake, no assignee change, and no activity MUST result from the request

### Requirement: The system SHALL provide a non-waking instance-reassign action

The system SHALL provide a server action that promotes an Idea's (or Task's) assignee from a bare `agent` to a specific `agent_instance`, identified by a durable `AgentInstance.uuid`, WITHOUT producing any daemon wake. This action SHALL persist the pin (the assignee becomes `assigneeType = "agent_instance"`) and SHALL emit only the ordinary UI-refresh change event — it SHALL NOT emit the `assigned` activity that the waking assign path emits, and therefore SHALL NOT create a wake notification or turn. The action SHALL be company-scoped and callable only by a `user` or `super_admin` auth type. The referenced `AgentInstance` MUST belong to the caller's company; a foreign or missing instance SHALL be rejected without mutating the assignee.

#### Scenario: Reassign to an instance persists the pin without waking

- **GIVEN** an Idea assigned to a bare `agent`
- **WHEN** the non-waking instance-reassign action is invoked with one of that agent's `AgentInstance` uuids
- **THEN** the Idea's `assigneeType` MUST become `"agent_instance"` referencing that instance
- **AND** no wake notification, turn, or `assigned` activity MUST be produced

#### Scenario: A foreign instance is rejected

- **GIVEN** an `AgentInstance` that belongs to another company
- **WHEN** the non-waking instance-reassign action is invoked with that instance uuid
- **THEN** the action MUST fail
- **AND** the Idea's assignee MUST be unchanged

#### Scenario: An agent caller is rejected

- **WHEN** a caller whose auth type is `agent` invokes the non-waking instance-reassign action
- **THEN** the action MUST reject the call and MUST NOT change the assignee

### Requirement: Wake-triggering buttons SHALL resolve the cwd before waking per the preview outcome

For the stage-advance and proposal wake entry points — Verify Elaborate, Start Development, Yolo, Proposal approve, and Proposal reject — the UI SHALL, before firing the wake, consult the wake-target preview for the target Idea and act on its outcome:

- **`pick`** → present the online-instance cwd picker; upon the user choosing an instance, call the non-waking instance-reassign action to persist that instance as the assignee, and only then fire the original wake action.
- **`auto_pin`** → without prompting, call the non-waking instance-reassign action to persist the single online instance as the assignee, then fire the wake. (This honors the owner decision that a single online connection is durably pinned, not just transiently targeted.)
- **`direct`** → fire the wake directly with no picker and no reassign.

For the two proposal entry points (approve / reject), the UI SHALL resolve the target Idea uuid from the proposal (the proposal's input Idea) before requesting the idea-scoped preview. The picker SHALL reuse the shared online-only instance picker and SHALL offer only effectively-online instances. If the wake step fails after a reassign step (pick or auto_pin) succeeded, the persisted pin SHALL NOT be rolled back and the UI SHALL allow retrying the wake.

#### Scenario: A pick-outcome Yolo click prompts, pins, then wakes

- **GIVEN** an Idea whose wake-target preview reports outcome `pick` with two online instances
- **WHEN** the user clicks Yolo
- **THEN** the UI MUST present the cwd picker of the two online instances
- **AND** upon selection the UI MUST call the non-waking reassign to persist that instance
- **AND** only then MUST it fire the Yolo wake

#### Scenario: An auto_pin-outcome click persists then wakes without prompting

- **GIVEN** an Idea whose wake-target preview reports outcome `auto_pin` with one online instance
- **WHEN** the user clicks Start Development
- **THEN** the UI MUST call the non-waking reassign to persist that single instance (no picker)
- **AND** then MUST fire the Start Development wake

#### Scenario: A direct-outcome click wakes immediately

- **GIVEN** an Idea whose wake-target preview reports outcome `direct`
- **WHEN** the user clicks Start Development
- **THEN** the UI MUST fire the wake directly without presenting a picker and without reassigning

#### Scenario: Proposal approve resolves the idea before previewing

- **GIVEN** a pending Proposal whose input Idea is assigned to a bare agent with two online instances and no online session-origin
- **WHEN** the user clicks Approve
- **THEN** the UI MUST resolve the Idea uuid from the proposal and request the idea-scoped wake-target preview
- **AND** MUST present the picker (outcome `pick`) before firing the approve wake

#### Scenario: A persisted pin survives a failed wake

- **GIVEN** the user picked (or auto-pinned) an instance and the non-waking reassign succeeded
- **WHEN** the subsequent wake action fails
- **THEN** the Idea MUST remain pinned to the chosen instance
- **AND** the UI MUST allow retrying the wake without re-picking

