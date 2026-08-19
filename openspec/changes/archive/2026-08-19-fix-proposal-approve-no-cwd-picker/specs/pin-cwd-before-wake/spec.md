## MODIFIED Requirements

### Requirement: Wake-triggering buttons SHALL resolve the cwd before waking per the preview outcome

For the stage-advance wake entry points on the idea-detail panel — Verify Elaborate, Start Development, and Yolo — the UI SHALL, before firing the wake, consult the wake-target preview for the target Idea and act on its outcome:

- **`pick`** → present the online-instance cwd picker; upon the user choosing an instance, call the non-waking instance-reassign action to persist that instance as the assignee, and only then fire the original wake action.
- **`auto_pin`** → without prompting, call the non-waking instance-reassign action to persist the single online instance as the assignee, then fire the wake. (This honors the owner decision that a single online connection is durably pinned, not just transiently targeted.)
- **`direct`** → fire the wake directly with no picker and no reassign.

The picker SHALL reuse the shared online-only instance picker and SHALL offer only effectively-online instances. If the wake step fails after a reassign step (pick or auto_pin) succeeded, the persisted pin SHALL NOT be rolled back and the UI SHALL allow retrying the wake.

The proposal review actions — Proposal approve and Proposal reject — SHALL NOT participate in this pin-then-wake flow: they SHALL NOT consult the wake-target preview, SHALL NOT present a cwd picker, and SHALL NOT persist a pin. Their wake target is resolved entirely on the server (see the daemon-cwd-instance-addressing capability's proposal-review wake resolution requirement).

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

#### Scenario: A persisted pin survives a failed wake

- **GIVEN** the user picked (or auto-pinned) an instance and the non-waking reassign succeeded
- **WHEN** the subsequent wake action fails
- **THEN** the Idea MUST remain pinned to the chosen instance
- **AND** the UI MUST allow retrying the wake without re-picking

#### Scenario: Proposal approve/reject do not consult the pin-then-wake preview

- **GIVEN** a pending Proposal whose input Idea is assigned to a bare agent with two online instances
- **WHEN** the user clicks Approve (or Reject)
- **THEN** the UI MUST NOT request the wake-target preview
- **AND** MUST NOT present a cwd picker
- **AND** MUST NOT persist a pin on the Idea
- **AND** MUST fire the approve (or reject) action directly
