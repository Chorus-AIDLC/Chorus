# resource-links Specification

## Purpose
TBD - created by archiving change add-resource-links-settings-onboarding. Update Purpose after archive.
## Requirements
### Requirement: Resource links control
The system SHALL provide a reusable resource-links control that renders exactly two external-link buttons — a GitHub button and a Docs button — each shown as an icon plus a translated text label, and each opening its destination in a new browser tab with `rel="noopener noreferrer"`.

#### Scenario: GitHub button target
- **WHEN** a user activates the GitHub button
- **THEN** a new tab opens at `https://github.com/Chorus-AIDLC/Chorus`
- **AND** the original tab is unchanged and retains no `window.opener` reference to the new tab

#### Scenario: Docs button opens in a new tab
- **WHEN** a user activates the Docs button
- **THEN** the localized documentation site opens in a new browser tab
- **AND** the original tab is unchanged and retains no `window.opener` reference to the new tab

#### Scenario: Labels are localized
- **WHEN** the control renders under any supported UI locale (en, zh, ja, ko)
- **THEN** both buttons display labels and accessible names from that locale's `resourceLinks` translations, with no hardcoded English fallback text

### Requirement: Docs link follows the current UI locale
The Docs button destination SHALL be derived from the active UI locale: the `en` locale SHALL link to the documentation site root `https://doc.chorus-ai.dev`, and every other supported locale SHALL link to the locale-prefixed path `https://doc.chorus-ai.dev/<locale>`.

#### Scenario: English locale links to root
- **WHEN** the active UI locale is `en`
- **THEN** the Docs button href is `https://doc.chorus-ai.dev`

#### Scenario: Non-English locale links to prefixed path
- **WHEN** the active UI locale is `zh`, `ja`, or `ko`
- **THEN** the Docs button href is `https://doc.chorus-ai.dev/<locale>` (e.g. `https://doc.chorus-ai.dev/zh`)

### Requirement: Placement on settings and onboarding
The resource-links control SHALL appear at the top-right of the settings page header and as a persistent footer within the onboarding wizard that is visible on every step of the flow.

#### Scenario: Settings page header
- **WHEN** a user views the settings page
- **THEN** the GitHub and Docs buttons are rendered in the page header aligned to the top-right, alongside the page title

#### Scenario: Onboarding wizard footer on every step
- **WHEN** a user is on any step of the onboarding wizard
- **THEN** the GitHub and Docs buttons are visible in the wizard footer

### Requirement: Theme correctness
The resource-links control SHALL render correctly in both light and dark themes, using semantic design tokens rather than hardcoded colors.

#### Scenario: Dark theme rendering
- **WHEN** the app is in dark theme
- **THEN** the buttons, icons, and labels remain legible with theme-appropriate contrast and no fixed-light color artifacts

