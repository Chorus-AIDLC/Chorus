## ADDED Requirements

### Requirement: Failed turns show summaries and expandable diagnostic details

The daemon conversation SHALL display a localized failure summary within the failed turn and SHALL offer accessible expandable details when bounded error text, exit code or signal is available. The summary SHALL be visible even without transcript messages and with a partial reply. Error data SHALL remain visible after refresh and through the existing live turn refresh mechanism. Diagnostics SHALL render as escaped plain text, fit narrow layouts and remain legible in both themes.

#### Scenario: A failed wake has no assistant reply
- **WHEN** a crash/invalid-path turn has a diagnostic and no assistant messages
- **THEN** its error summary SHALL be visible without expanding details or opening local daemon logs

#### Scenario: A user expands details
- **WHEN** the user activates the failed turn's diagnostic control
- **THEN** bounded plain-text details and any available exit code/signal SHALL appear
- **AND** the control SHALL expose its expanded state and allow collapsing again

#### Scenario: A historical crash lacks a diagnostic
- **WHEN** a crash/invalid-path turn from an older daemon has no valid saved diagnostic
- **THEN** the conversation SHALL show a localized generic failure reason
- **AND** SHALL NOT offer an empty diagnostic-details control

#### Scenario: A user interrupt or daemon shutdown occurs
- **WHEN** a turn is interrupted by the user, shutdown or an offline reconcile
- **THEN** the conversation SHALL retain the existing interruption behavior without presenting a wake-error block

#### Scenario: Error text contains markup or a long line
- **WHEN** a diagnostic contains markup or a long unbroken line
- **THEN** the markup SHALL remain inert text and the detail area SHALL remain inside the conversation width
