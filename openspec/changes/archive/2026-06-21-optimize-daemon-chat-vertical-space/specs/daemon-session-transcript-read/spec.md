# daemon-session-transcript-read Specification (delta)

## ADDED Requirements

### Requirement: The daemon conversation surface SHALL minimize header chrome and top-align content

The daemon conversation surface ("View all" chat modal) SHALL NOT render a visible header subtitle describing the surface; the surface's visible heading (title) SHALL be retained, but the explanatory subtitle line SHALL be removed so it does not consume vertical space inside the conversation view. The conversation content (the two-pane layout on desktop, the list/drill-down on mobile) SHALL be top-aligned — its top edge SHALL sit close to the modal's top edge, without the excess vertical padding/gap that previously pushed it down. Removing the visible subtitle SHALL NOT remove the modal's accessibility description: the hidden Radix `DialogDescription` used to satisfy the dialog's "described-by" requirement SHALL continue to resolve a localized string, independent of the visible header.

#### Scenario: No visible subtitle in the conversation header

- **WHEN** the daemon conversation surface renders (desktop or mobile)
- **THEN** the visible heading (title) MUST be present
- **AND** no visible explanatory subtitle line MUST be shown beneath it

#### Scenario: Content is top-aligned on desktop

- **WHEN** the surface renders on a desktop-width (`lg`+) viewport
- **THEN** the two-pane conversation content's top edge MUST sit near the modal's top edge, with no large empty band above it

#### Scenario: The dialog accessibility description is preserved

- **WHEN** the conversation modal mounts after the visible subtitle is removed
- **THEN** the modal MUST still provide an accessibility description (a hidden `DialogDescription`) that resolves a localized string
- **AND** that description MUST be a separate node from the (now removed) visible subtitle

### Requirement: Running status SHALL be carried in the transcript header rather than a standalone footer card

The conversation's running status — a running indicator plus the elapsed run time of the conversation's running execution — SHALL be presented in the transcript header (alongside the existing running marker), and the standalone running/interrupted execution card SHALL NOT occupy a separate row in the conversation footer. The elapsed time SHALL update live (using the same monotonic elapsed formatter the execution rows use) and SHALL respect reduced-motion for any animated indicator. The running status in the header SHALL NOT include a deep-link to the underlying task/idea; the conversation's header title remains the navigational affordance. Removing the standalone footer card SHALL NOT remove the visibility of which work is running and for how long.

#### Scenario: Elapsed run time appears in the header while running

- **WHEN** the open conversation has a running execution
- **THEN** the transcript header MUST show a running indicator and the elapsed run time
- **AND** the elapsed time MUST advance live without a manual refresh

#### Scenario: No standalone running card in the footer

- **WHEN** the open conversation has a running or interrupted execution
- **THEN** the footer MUST NOT render a standalone execution card on its own row above the input
- **AND** the running-state information MUST instead be available in the header (running + elapsed)

#### Scenario: The header running status carries no deep link

- **WHEN** the running status renders in the header
- **THEN** it MUST show only the running indicator and elapsed time (no separate link to the task/idea)
- **AND** the conversation header title MUST remain the navigational affordance

### Requirement: Interrupt, Resume, and Send SHALL be consolidated into the reply input's action row

The reply composer SHALL present a single action area at the bottom-right of the input box that hosts the conversation's controls together: Send SHALL always be present; when the conversation has a running execution, an Interrupt control SHALL appear alongside Send; when the conversation has a user-interrupted execution, a Resume control SHALL appear; a crash-interrupted execution SHALL show no Resume control (the existing "auto-recovers" hint is retained and remains visible). The Interrupt control SHALL retain its confirmation dialog (a destructive-action confirm) wherever it is rendered. The Interrupt and Resume controls SHALL issue the same control/resume requests they do today (no change to the `/api/daemon/control` interrupt or `/api/daemon/resume` resume behavior). While a turn is running, the input textarea SHALL remain usable so the user can compose and send a follow-up instruction mid-run (reusing the existing instruction endpoint, which appends a `human_instruction` turn regardless of run state); this send-while-running SHALL require no backend change. When the conversation's origin connection is offline, the composer SHALL remain hard-disabled with its visible read-only reason, unchanged. This consolidated layout SHALL apply on both desktop (inline action row) and mobile (stacked action row beneath the textarea).

#### Scenario: Send is always present; Interrupt joins it while running

- **WHEN** the open conversation has a running execution and its origin is online
- **THEN** the input action row MUST show Send and, beside it, an Interrupt control
- **AND** the input textarea MUST remain usable (not disabled by the running state)

#### Scenario: Interrupt keeps its confirmation dialog

- **WHEN** the user activates the Interrupt control in the input action row
- **THEN** a confirmation dialog MUST be shown before any interrupt request is issued
- **AND** confirming MUST issue the same interrupt request as the prior standalone control

#### Scenario: Resume appears for a user-interrupted conversation; crash shows no Resume

- **WHEN** the open conversation's execution is interrupted with reason `user`
- **THEN** the input action row MUST show a Resume control
- **WHEN** instead the execution is interrupted with reason `crash`
- **THEN** no Resume control MUST be shown, and the existing "auto-recovers" hint MUST remain visible

#### Scenario: Sending a follow-up while a turn is running

- **GIVEN** the open conversation has a running execution and its origin is online
- **WHEN** the user types an instruction and sends it
- **THEN** the instruction MUST be submitted via the existing session instruction endpoint (appending a `human_instruction` turn)
- **AND** no backend change MUST be required for this to work

#### Scenario: Offline origin still hard-disables the composer

- **WHEN** the open conversation's origin connection is offline
- **THEN** the composer MUST be disabled with its visible localized read-only reason
- **AND** Send MUST NOT issue a request

#### Scenario: Consolidated controls on mobile use the stacked layout

- **WHEN** the conversation footer renders on a mobile (`< lg`) drill-down
- **THEN** the standalone execution card MUST NOT be present
- **AND** Send plus any Interrupt/Resume control MUST render in the stacked action area beneath the textarea
