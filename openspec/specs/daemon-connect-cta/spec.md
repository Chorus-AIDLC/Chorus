# daemon-connect-cta Specification

## Purpose
TBD - created by archiving change add-daemon-connect-onboarding-cta. Update Purpose after archive.
## Requirements
### Requirement: Shared daemon-connect call-to-action component

The system SHALL provide a single shared, presentational call-to-action component that guides a user with no online daemon connection to start a long-lived `chorus daemon`. The component SHALL be prop-driven (a size/emphasis variant), SHALL fetch no data, and SHALL be the only implementation of this guidance — the three empty-state surfaces (sidebar pill popover, onboarding completion screen, Agent Connections modal) SHALL render this same component rather than hand-written copies.

#### Scenario: Component renders command, copy, and learn-more

- **WHEN** the daemon-connect CTA component is rendered
- **THEN** it displays prose explaining that a long-lived `chorus daemon` keeps the agent online, the exact start command, a one-click copy control for that command, and a "Learn more" link to the onboarding install guide

#### Scenario: All three surfaces use the one component

- **WHEN** the daemon-connect guidance appears in the sidebar pill popover empty state, the onboarding completion screen, or the Agent Connections modal empty state
- **THEN** each surface renders the same shared component, so the command and prose cannot drift between surfaces

### Requirement: Command shown in npx form from a single constant

The CTA SHALL show the daemon command in the zero-install `npx` form, sourced from a single exported constant rather than a per-call-site literal. The start command SHALL be `npx @chorus-aidlc/chorus daemon`, and the CTA SHALL also surface the first-run login command `npx @chorus-aidlc/chorus login`. i18n message strings SHALL carry only the surrounding prose and SHALL NOT embed the command literal, so a future package or bin rename is a one-line constant change.

#### Scenario: Start command is the npx form

- **WHEN** a user views the daemon-connect CTA
- **THEN** the copyable command is `npx @chorus-aidlc/chorus daemon` (not a bare `chorus daemon`)
- **AND** the first-run login command `npx @chorus-aidlc/chorus login` is surfaced as the prerequisite step

#### Scenario: Command literal is not duplicated in i18n or per call site

- **WHEN** the command string must change (e.g. the published package name changes)
- **THEN** editing the single command constant updates all three surfaces
- **AND** no locale message file and no call site contains the command literal

#### Scenario: Copy control copies the command

- **WHEN** the user activates the copy control on the CTA
- **THEN** the start command is written to the clipboard and the control shows a transient confirmation
- **AND** if the clipboard write is unavailable, the command text remains visible and no error crashes the surface

### Requirement: Pill popover 0-online empty state shows the CTA, non-dismissible

The sidebar agent-presence pill popover SHALL render the daemon-connect CTA in place of a bare "no agents online" statement whenever zero connections are online. The CTA SHALL NOT be dismissible and SHALL NOT persist a dismissed preference; it SHALL disappear naturally once at least one daemon connection is online (the popover then renders the live connection list).

#### Scenario: Zero online agents

- **WHEN** the user opens the agent-presence pill popover and no connections are online
- **THEN** the popover shows the daemon-connect CTA (with command + copy + learn-more) instead of only a "no agents online" sentence

#### Scenario: An agent comes online

- **WHEN** at least one daemon connection becomes online
- **THEN** the popover renders the live connection list and the CTA is no longer shown, with no dismiss action required

#### Scenario: The resident pill remains visible

- **WHEN** zero connections are online
- **THEN** the pill trigger itself remains visible in the sidebar (the CTA lives inside the popover, not in place of the pill)

### Requirement: Onboarding completion screen shows a prominent next-step CTA

The onboarding completion screen SHALL display the daemon-connect CTA as a prominent "next step" block, in addition to the existing summary card and navigation buttons. The block SHALL emphasize that installing a plugin does not by itself keep an agent online and that running `chorus daemon` is required for the agent to auto-receive dispatched work. The existing "Go to projects" / "Go to settings" actions SHALL be preserved.

#### Scenario: Completion screen guides toward the daemon

- **WHEN** a user reaches the final onboarding completion step
- **THEN** a prominent next-step block shows the daemon-connect CTA emphasizing "installed plugin ≠ resident online — run the daemon"
- **AND** the existing "Go to projects" and "Go to settings" buttons are still present

### Requirement: i18n coverage in both locales

All user-facing strings introduced by the CTA (headline, body, completion-screen framing, copy button label and copied state, and learn-more link text) SHALL exist in both the English and Chinese locale files, under a single namespace used by all three surfaces. The previously hand-written Agent Connections empty-state command sentence SHALL be reconciled into the shared CTA so no duplicate command-bearing copy remains.

#### Scenario: Keys present in both locales

- **WHEN** the CTA renders in either the English or Chinese locale
- **THEN** every CTA string resolves from a translation key present in both `messages/en.json` and `messages/zh.json`
- **AND** no CTA string is hardcoded in JSX

