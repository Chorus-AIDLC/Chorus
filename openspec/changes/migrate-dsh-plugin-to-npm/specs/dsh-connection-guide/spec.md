## MODIFIED Requirements

### Requirement: Complete dsh connection guides

The repository SHALL provide `docs/CONNECT_DSH.md` and `docs/CONNECT_DSH.zh.md` as English and Chinese references for connecting DeepSeek Harness (`dsh`) to Chorus. Both guides SHALL identify dsh and pnpm as interactive installation prerequisites and SHALL cover `CHORUS_URL` and `CHORUS_API_KEY`, `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh`, launch and check-in verification, daemon managed-package behavior, troubleshooting, and links to related connection documentation.

The documented commands and package behavior MUST match the published npm bundle and daemon preparation implementation. The guides MUST NOT direct users to a Chorus-hosted installer, copied `$DSH_HOME` files, or persisted `$DSH_HOME/.env` credentials.

#### Scenario: Reader follows interactive npm setup

- **WHEN** a reader with dsh installed and a valid Chorus API key follows either guide
- **THEN** the guide SHALL require pnpm on `PATH` and provide environment exports, the profile package-add command, and verification steps needed to connect dsh to Chorus

#### Scenario: Reader configures daemon use or troubleshooting

- **WHEN** a reader uses the Chorus daemon or encounters package, authentication, or composition failure
- **THEN** the guide SHALL explain managed package/config preparation, explicit config overrides, and actionable diagnostics consistent with the implementation

#### Scenario: Reader checks filesystem ownership

- **WHEN** a reader reviews the installation behavior
- **THEN** the guide SHALL state that Chorus does not copy plugin files or credentials into `$DSH_HOME`
- **AND** it SHALL distinguish dsh-owned profile package state from Chorus-owned daemon package/config state
