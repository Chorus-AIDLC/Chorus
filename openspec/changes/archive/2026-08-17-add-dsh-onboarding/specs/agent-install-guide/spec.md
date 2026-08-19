## MODIFIED Requirements

### Requirement: Shared chrome-free agent install guide component

The agent install/config guide SHALL be implemented as a single shared, host-agnostic React component (the "install guide component") that renders the per-client setup instructions and nothing else. The component SHALL accept an `apiKey: string | null` prop and SHALL render install snippets for all seven supported client types - Claude Code, Codex, Kiro, dsh, OpenCode, OpenClaw, and Other Agents - using the existing `onboarding.install.*` translation namespace. The dsh tab SHALL have the visible label `DeepSeek Harness`, SHALL retain `dsh` as its internal value, and SHALL appear between Kiro and OpenCode.

The component SHALL NOT render any host-specific chrome: no page or step heading, no wizard navigation (Back/Next) buttons, and no enclosing animation wrapper. Such chrome is the responsibility of whichever host renders the component.

When `apiKey` is a non-empty string, the rendered snippets (environment-variable exports and client config blocks) SHALL embed that exact key. When `apiKey` is `null`, the component SHALL substitute a literal placeholder (`<YOUR_API_KEY>`) in place of the key.

#### Scenario: Guide renders all seven client tabs from a single component

- **WHEN** the install guide component is rendered with any `apiKey` value
- **THEN** it SHALL display selectable tabs in the order Claude Code, Codex, Kiro, DeepSeek Harness, OpenCode, OpenClaw, and Other Agents, and SHALL NOT render a step heading or Back/Next navigation

#### Scenario: Live key is embedded in snippets

- **WHEN** the install guide component is rendered with a non-empty `apiKey` (for example, a freshly created `cho_` key)
- **THEN** the environment-variable exports and client config snippets across the tabs SHALL contain that exact key rather than a placeholder

#### Scenario: Placeholder when no key is available

- **WHEN** the install guide component is rendered with `apiKey` set to `null`
- **THEN** the snippets SHALL show the literal placeholder `<YOUR_API_KEY>` in place of a key

## ADDED Requirements

### Requirement: dsh three-step onboarding flow

The dsh tab SHALL present a localized three-step setup flow. It SHALL show exports for `CHORUS_URL` and `CHORUS_API_KEY`, SHALL show the command `curl -fsSL <current-origin>/install-dsh.sh | bash`, and SHALL instruct the user to launch dsh and verify the Chorus connection with a check-in. The current origin and the component's live-or-placeholder API key SHALL be interpolated consistently with the Codex and Kiro tabs.

#### Scenario: User opens the dsh tab with a live key

- **WHEN** a user selects the dsh tab while the component has a live API key
- **THEN** the guide SHALL show the current Chorus origin, that key, the dsh installer command for that origin, and the launch/check-in verification instruction

#### Scenario: dsh guide is localized in every supported UI locale

- **WHEN** the application locale is English, Chinese, Japanese, or Korean
- **THEN** the dsh tab label and all three setup-step strings SHALL resolve from that locale without missing-key fallback

### Requirement: Responsive install-guide tab navigation

The install-guide tab selector SHALL remain a single row and SHALL permit horizontal scrolling when its seven readable tab labels exceed the available width. Tab triggers SHALL not collapse to widths that clip or overlap their labels. The selector SHALL remain usable in both light and dark themes.

#### Scenario: Narrow viewport exposes all harness tabs

- **WHEN** the install guide is rendered in a viewport too narrow to display all seven tabs at once
- **THEN** the tab selector SHALL remain one row, SHALL not overlap or clip tab labels, and SHALL allow the user to scroll horizontally to select every tab

#### Scenario: Wide viewport shows a stable row

- **WHEN** the install guide has enough horizontal space for all seven tabs
- **THEN** the tabs SHALL remain in one stable row without wrapping or causing content layout shift
