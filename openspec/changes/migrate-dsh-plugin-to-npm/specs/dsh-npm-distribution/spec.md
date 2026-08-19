## ADDED Requirements

### Requirement: Chorus dsh integration SHALL be distributed as a public npm bundle

The repository SHALL publish `@chorus-aidlc/chorus-dsh` as a public package whose `package.json` declares `dsh.bundle.patch` as `./cordis.patch.yml`. The package MUST contain the self-contained JavaScript lifecycle runtime, bundle patch, complete Chorus skill tree, and package documentation. It MUST contain no native dependency and MUST use the Chorus application release version.

`@deepseek-ai/schemastery` MUST be the only `dependencies` entry required by Chorus-owned runtime code. The package MUST declare `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-tool-skill`, and `@deepseek-ai/dsh-persona` as non-optional peer dependencies compatible with the pinned dsh baseline; those peers MUST NOT be vendored into the Chorus runtime bundle.

#### Scenario: Published tarball is inspected

- **WHEN** the package is packed for publication
- **THEN** its tarball MUST contain the runtime, `cordis.patch.yml`, and every required Chorus skill
- **AND** its public metadata and dsh bundle declaration MUST be valid
- **AND** its metadata MUST contain exactly the four required dsh peer declarations
- **AND** it MUST NOT contain credentials, `$DSH_HOME` copies, a named Chorus preset, or server installer artifacts

#### Scenario: Interactive user installs the package

- **WHEN** a user runs `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh`
- **THEN** dsh MUST add the package dependency and append it to that profile's bundle list
- **AND** the existing profile/base installation MUST satisfy the bundle's four dsh peers
- **AND** the effective profile composition MUST expose Chorus MCP, lifecycle, skills, and prompt behavior without manual patch editing

### Requirement: Bundle configuration SHALL prefer explicit values and default to environment credentials

The package SHALL expose optional `url` and `apiKey` configuration. An explicit non-empty configured value MUST take precedence; otherwise the runtime MUST read `CHORUS_URL` and `CHORUS_API_KEY` from the process environment. Package files and generated configurations MUST NOT embed resolved credential values.

#### Scenario: Environment-only interactive setup

- **WHEN** the bundle starts without explicit `url` or `apiKey` configuration and both environment variables are set
- **THEN** the MCP client MUST use those environment values
- **AND** the API key MUST NOT appear in the profile manifest, bundle patch, argv, or logs

#### Scenario: Explicit plugin configuration is supplied

- **WHEN** a non-empty plugin configuration value and the corresponding environment variable both exist
- **THEN** the explicit value MUST be used for that field
- **AND** omitted fields MUST continue to fall back independently to the environment

### Requirement: Daemon SHALL prepare a resolvable managed npm composition

For daemon-owned dsh sessions without an explicit operator config override, Chorus SHALL maintain an npm installation and generated Cordis configuration in Chorus-owned state outside `$DSH_HOME`. The managed project MUST explicitly install `@chorus-aidlc/chorus-dsh` plus `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-tool-skill`, and `@deepseek-ai/dsh-persona` into the config directory's resolution scope.

The configuration MUST reference `@chorus-aidlc/chorus-dsh` by package name when resolvable from its config directory and MUST fall back to the resolved absolute package entry when package-name resolution is unavailable. The four peer rows MUST remain resolvable by package name. Preparation MUST validate all five imports and the complete composition before service activation or wake execution.

#### Scenario: Package name resolves from managed config

- **WHEN** daemon preparation installs the package beneath the generated config's resolution anchor
- **THEN** the generated composition MUST reference `@chorus-aidlc/chorus-dsh` by package name
- **AND** Loader MUST resolve the bundle and all four peer plugins from that managed installation
- **AND** `dsh-jsonrpc-agent` MUST load the complete composition

#### Scenario: Installed topology requires an absolute entry

- **WHEN** package-name resolution from the generated config directory fails but the installed package entry can be resolved
- **THEN** preparation MUST generate an absolute entry reference
- **AND** validation MUST prove the absolute bundle entry and all four peer names load before the composition is selected

#### Scenario: Operator supplies an explicit config

- **WHEN** `CHORUS_DSH_CONFIG` or `DSH_CORDIS_CONFIG` selects a non-empty config path
- **THEN** Chorus MUST use that path without rewriting it or replacing it with managed configuration

### Requirement: Legacy server and home-copy distribution SHALL be absent

The supported integration MUST NOT download Chorus dsh runtime files from the Chorus server, serve `/install-dsh.sh` or `/chorus-dsh.mjs`, copy Chorus-owned files into `$DSH_HOME`, or persist Chorus credentials in `$DSH_HOME/.env`.

#### Scenario: Distribution surfaces are audited

- **WHEN** repository routes, public artifacts, onboarding commands, and package builds are inspected
- **THEN** `install-dsh.sh`, `chorus-dsh.mjs`, and the copied `dsh-plugin` delivery tree MUST be absent
- **AND** npm package installation MUST be the only documented Chorus plugin distribution path

#### Scenario: Installation runs with a sentinel dsh home

- **WHEN** interactive and daemon setup execute with an isolated `$DSH_HOME`
- **THEN** Chorus-owned code MUST make no filesystem change beneath that directory

### Requirement: Real dsh acceptance SHALL cover both npm consumers

Verification SHALL use DeepSeek Harness tag `dsh-v0.1.0-rc.7` at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` and a packed local package. It MUST exercise both interactive profile installation and daemon managed configuration.

#### Scenario: Interactive acceptance completes

- **WHEN** the packed package is installed into an isolated real dsh profile and launched with environment credentials
- **THEN** Chorus check-in, packaged skill discovery/loading, inline persona/instructions, and lifecycle behavior MUST work
- **AND** the discovered catalog MUST contain `chorus`, `idea-chorus`, `proposal-chorus`, `develop-chorus`, `yolo-chorus`, `review-chorus`, `quick-dev-chorus`, `brainstorm-chorus`, `openspec-aware-chorus`, `orchestrate-chorus`, `docs-chorus`, `proposal-reviewer-chorus`, `task-reviewer-chorus`, and `code-reviewer-chorus`
- **AND** no Chorus file MUST be written to `$DSH_HOME`

#### Scenario: Daemon acceptance completes

- **WHEN** the Chorus daemon wakes a real managed `dsh-jsonrpc-agent`
- **THEN** the managed config MUST first load the Chorus bundle and all four declared peer plugins
- **AND** committed transcript messages, per-Idea normalized token usage, and interruption through the process-group boundary MUST work
- **AND** credentials MUST come from environment injection without appearing in package files, generated config, argv, or logs
