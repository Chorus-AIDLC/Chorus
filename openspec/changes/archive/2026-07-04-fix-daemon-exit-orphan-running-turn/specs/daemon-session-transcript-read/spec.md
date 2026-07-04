# daemon-session-transcript-read — delta: interrupted turn presentation

## ADDED Requirements

### Requirement: An interrupted turn SHALL render as a distinct terminal state, never as running

The conversation surface SHALL treat `status = "interrupted"` as a terminal turn state. An interrupted turn's band SHALL show an explicit "Interrupted" status label (localized in every supported locale), styled distinctly from both `running` (no spinner, no pulse, no elapsed-running timer) and plain `ended` (visually distinguishable as an abnormal termination). The transcript header's running probe and the conversation list's running indicator SHALL NOT match an interrupted turn. The `turn_status_changed` SSE event for a `running → interrupted` transition SHALL update the open conversation in place, exactly like the other status transitions, and the turn view payload SHALL carry `interruptedReason` so the UI can surface it.

#### Scenario: A turn interrupted by daemon exit stops rendering as running

- **GIVEN** an open conversation whose latest turn is `running`
- **WHEN** a `turn_status_changed` event arrives finalizing it `interrupted(offline)`
- **THEN** the turn band MUST switch to the "Interrupted" presentation without a page refresh
- **AND** the header running badge and the conversation list's running indicator MUST clear

#### Scenario: Interrupted is visually distinct from ended

- **WHEN** a transcript renders one `ended` turn and one `interrupted` turn
- **THEN** the two MUST be distinguishable (the interrupted band carries the "Interrupted" label)
- **AND** neither shows a spinner or running pulse
