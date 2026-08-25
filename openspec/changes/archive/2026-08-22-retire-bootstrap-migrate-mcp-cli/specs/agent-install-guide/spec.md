# agent-install-guide Specification (delta)

## MODIFIED Requirements

### Requirement: dsh three-step onboarding flow

The dsh tab SHALL present a localized setup flow. It SHALL show exports for `CHORUS_URL` and `CHORUS_API_KEY`, SHALL show the command `chorus init` (or `npx @chorus-aidlc/chorus init`) as the way to install and configure the Chorus plugin for DeepSeek Harness, and SHALL instruct the user to launch dsh and verify the Chorus connection with a check-in. The current origin and the component's live-or-placeholder API key SHALL be interpolated consistently with the Codex and Kiro tabs. It SHALL NOT present the retired `curl | bash` installer command.

#### Scenario: User opens the dsh tab with a live key

- **WHEN** a user selects the dsh tab while the component has a live API key
- **THEN** the guide SHALL show the current Chorus origin, that key, the `chorus init` command, and the launch/check-in verification instruction

#### Scenario: dsh guide is localized in every supported UI locale

- **WHEN** the application locale is English, Chinese, Japanese, or Korean
- **THEN** the dsh tab label and all setup-step strings SHALL resolve from that locale without missing-key fallback
