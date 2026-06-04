# agent-install-guide Specification

## ADDED Requirements

### Requirement: Shared chrome-free agent install guide component

The agent install/config guide SHALL be implemented as a single shared, host-agnostic React component (the "install guide component") that renders the per-client setup instructions and nothing else. The component SHALL accept an `apiKey: string | null` prop and SHALL render install snippets for all five supported client types — Claude Code, Codex, OpenCode, OpenClaw, and Other Agents — using the existing `onboarding.install.*` translation keys.

The component SHALL NOT render any host-specific chrome: no page or step heading, no wizard navigation (Back/Next) buttons, and no enclosing animation wrapper. Such chrome is the responsibility of whichever host renders the component.

When `apiKey` is a non-empty string, the rendered snippets (environment-variable exports and client config blocks) SHALL embed that exact key. When `apiKey` is `null`, the component SHALL substitute a literal placeholder (`<YOUR_API_KEY>`) in place of the key.

#### Scenario: Guide renders all five client tabs from a single component

- **WHEN** the install guide component is rendered with any `apiKey` value
- **THEN** it SHALL display selectable tabs for Claude Code, Codex, OpenCode, OpenClaw, and Other Agents, each showing that client's setup instructions, and SHALL NOT render a step heading or Back/Next navigation

#### Scenario: Live key is embedded in snippets

- **WHEN** the install guide component is rendered with a non-empty `apiKey` (e.g. a freshly created `cho_…` key)
- **THEN** the environment-variable exports and client config snippets across the tabs SHALL contain that exact key rather than a placeholder

#### Scenario: Placeholder when no key is available

- **WHEN** the install guide component is rendered with `apiKey` set to `null`
- **THEN** the snippets SHALL show the literal placeholder `<YOUR_API_KEY>` in place of a key

### Requirement: Single source of truth across onboarding and settings

The onboarding install step and the Settings "Create API Key" success state SHALL both render the install guide content exclusively through the shared install guide component, so that the guide shown in the two locations cannot drift. Neither location SHALL maintain its own copy of the per-client tab content.

The onboarding install step SHALL retain its existing wizard chrome (step heading, animation wrapper, Back/Next navigation) and render the shared component in place of its previously inline tabs, with no user-visible change to onboarding behavior.

#### Scenario: Onboarding install step is behavior-preserving

- **WHEN** a user reaches the install step of the onboarding wizard after creating their first agent
- **THEN** the step SHALL show the same heading, the same five-client guide, and the same Back/Next navigation as before, with the freshly created key embedded in the snippets

#### Scenario: Both locations stay in sync

- **WHEN** the shared install guide component's tab content is modified
- **THEN** both the onboarding install step and the Settings key-creation success state SHALL reflect the modification, because both render the same component

### Requirement: Install guide shown after creating a key in Settings

After an agent and its API key are created from the Settings "Create API Key" dialog, the dialog's success state SHALL render the shared install guide component inline, positioned below the displayed API key (and its copy control) and above the dialog's dismiss ("Done") control. The success state SHALL continue to display the "key created" confirmation, the one-time-visibility warning, the raw key, and a copy control as it did before.

The success state SHALL pass the freshly created key to the install guide component so that the snippets embed the real key while the dialog is open.

The Settings key-creation flow SHALL NOT include a connection-test step; it SHALL show the guide without waiting for or verifying an agent check-in.

#### Scenario: Guide appears inline with the new key

- **WHEN** a user creates an agent in Settings and the success state appears
- **THEN** the dialog SHALL show, in order, the key-created confirmation and warning, the raw key with a copy control, the five-client install guide with the real key embedded in its snippets, and a Done control

#### Scenario: No connection-test step in Settings

- **WHEN** the Settings key-creation success state is shown
- **THEN** it SHALL NOT wait for an agent check-in or render a connection-test step; it SHALL present the install guide and a Done control only

### Requirement: Install guide in Settings is creation-time only

The install guide in the Settings key-creation flow SHALL be available only during the success state of the creation dialog, while the raw key is in memory. When the dialog is dismissed, the guide SHALL no longer be accessible and the raw key SHALL be cleared. The system SHALL NOT provide a way to re-open the install guide for an existing agent from the agent list, and SHALL NOT offer key rotation to re-embed a live key into the guide.

#### Scenario: Guide is gone after dismissing the dialog

- **WHEN** a user dismisses the Settings key-creation dialog via Done
- **THEN** the guide and the raw key SHALL be cleared, and the agent list SHALL NOT offer any control to re-open the install guide for that agent
