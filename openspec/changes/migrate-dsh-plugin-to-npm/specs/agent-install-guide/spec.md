## MODIFIED Requirements

### Requirement: dsh three-step onboarding flow

The dsh tab SHALL present a localized three-step setup flow. It SHALL identify dsh and pnpm as prerequisites, SHALL show exports for `CHORUS_URL` and `CHORUS_API_KEY`, SHALL show `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh`, and SHALL instruct the user to launch that profile and verify the Chorus connection with a check-in. The current origin and the component's live-or-placeholder API key SHALL be interpolated consistently with the Codex and Kiro tabs. The flow MUST NOT reference `install-dsh.sh`, `/chorus-dsh.mjs`, or writes to `$DSH_HOME`.

#### Scenario: User opens the dsh tab with a live key

- **WHEN** a user selects the dsh tab while the component has a live API key
- **THEN** the guide SHALL show the dsh and pnpm prerequisites, current Chorus origin, that key, the npm bundle add command, and the launch/check-in verification instruction

#### Scenario: dsh guide is localized in every supported UI locale

- **WHEN** the application locale is English, Chinese, Japanese, or Korean
- **THEN** the dsh tab label and all three npm-based setup-step strings SHALL resolve from that locale without missing-key fallback

#### Scenario: Legacy installer is absent from onboarding

- **WHEN** the rendered dsh setup content is inspected
- **THEN** it MUST contain no curl command or Chorus-hosted dsh artifact URL
