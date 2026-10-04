# pi-init-integration Specification

## Purpose
TBD - created by archiving change optimize-pi-plugin-npm-parity. Update Purpose after archive.

## Requirements

### Requirement: chorus init installs the pi plugin automatically
The Pi adapter SHALL install `npm:@chorus-aidlc/chorus-pi` automatically when a supported Pi host is available and SHALL select its MCP backend from the installed Pi version. Within the maintained package range, stable Pi versions at or above 0.99.0 SHALL use native MCP without installing or updating `pi-mcp-adapter`. Supported older stable versions SHALL retain a validated compatible adapter installation before Chorus. The maintained host floor SHALL be 0.84.4, with 2.x and prereleases outside the declared compatibility range. The adapter SHALL retain existing binary/config-directory detection and graceful manual guidance when Pi is absent.

#### Scenario: init auto-installs when pi is present
- **WHEN** init runs with the Pi adapter selected and the Pi binary available
- **THEN** it installs Chorus automatically rather than only printing manual guidance, applying the version-specific adapter policy

#### Scenario: Native fresh installation and repeat
- **WHEN** init runs on stable Pi >=0.99.0 with no adapter
- **THEN** it installs Chorus only and considers a subsequent run complete without an adapter

#### Scenario: Legacy installation
- **WHEN** init runs on a supported stable Pi below 0.99.0
- **THEN** it ensures adapter then Chorus are installed and requires both for complete setup

#### Scenario: Unknown or prerelease version
- **WHEN** the version probe fails, times out, is ambiguous, or returns a prerelease
- **THEN** it does not install or update the adapter, may ensure Chorus is installed, and reports MCP setup as incomplete with diagnostic/manual guidance

#### Scenario: init degrades gracefully without pi
- **WHEN** the Pi binary is absent
- **THEN** init runs no package commands and surfaces conditional native/legacy manual instructions without a hard failure

#### Scenario: Unsupported host range
- **WHEN** a known host is below 0.84.4 or at/above 2.0.0
- **THEN** setup runs no package commands and explicitly reports the supported host range rather than claiming that current Chorus is compatible

### Requirement: CONNECT_PI docs reflect npm install and wakeability
`docs/CONNECT_PI.md` and `packages/chorus-pi/README.md` SHALL document `pi install npm:@chorus-aidlc/chorus-pi` as the native Pi installation, adapter installation only for legacy Pi, and Pi as a wakeable daemon backend. They SHALL NOT recommend sparse checkout or manual agents-file copying. They SHALL distinguish native `.pi/mcp.json` project discovery from legacy adapter discovery, describe warning-only migration, and preserve environment-referenced credential guidance.

#### Scenario: docs recommend npm install
- **WHEN** a user reads the Pi setup documentation
- **THEN** native setup needs Chorus only, legacy setup includes adapter, and neither requires manually copying reviewer agents

#### Scenario: existing adapter or disabled builtin
- **WHEN** a native Pi user follows migration instructions
- **THEN** the documentation explains scoped manual adapter removal and any required native-MCP re-enabling without claiming Chorus performs either automatically

### Requirement: Generated Pi configuration is consumable by extension bookkeeping
The extension SHALL discover its Chorus connection from the version-appropriate generated global config when `CHORUS_URL` is absent and the advertised API-key environment variable is exported. Legacy adapter5 primary selection SHALL outrank retained old global `mcp.json`, including under an agent-dir override. Native selection and explicit environment precedence SHALL remain intact. Malformed, unreadable or partial configuration SHALL NOT crash discovery, and unresolved environment references SHALL NOT be sent as credentials.

#### Scenario: Fresh legacy setup with advertised exports
- **WHEN** the CLI writes a legacy primary config and interactive Pi exports only the API key and optional profile, not the URL
- **THEN** the actual extension performs checkin, worker session lifecycle and successful direct workflow reminders using that configured endpoint
- **AND** both default and overridden global agent directories are supported

#### Scenario: Retained configuration and host separation
- **WHEN** legacy primary and stale old global config coexist
- **THEN** the legacy primary connection wins rather than the stale file
- **AND** native hosts retain their native config behavior instead of selecting the adapter primary

#### Scenario: Explicit overrides and incomplete credentials
- **WHEN** environment connection overrides or malformed, unreadable or partial config candidates are present
- **THEN** explicit environment values keep precedence and unsafe/incomplete candidates do not crash loading or become unresolved-template HTTP credentials

### Requirement: The shipped Chorus artifact supports each maintained host branch
The current Chorus package SHALL retain Pi 1.x functionality and provide tested pre-1.0 compatibility before installers advertise that support. Package metadata and CLI host/adapter policy SHALL describe the same validated compatibility contract. Actual packed extension and bundled subagent/reviewer loading SHALL be tested on Pi 0.84.4, 0.87.1, 0.99.0, and 1.0.2; the first two SHALL use a recorded compatible adapter and the latter two native MCP. Merely widening peer metadata, mocking installer success, or skipping legacy tests SHALL NOT satisfy this requirement.

#### Scenario: Required artifact and host matrix
- **WHEN** the compatibility task is verified
- **THEN** the actual packed current package loads under each isolated SDK, successfully calls a local MCP fixture, preserves session lifecycle and reviewer query/comment permissions, and denies reviewer business mutations
- **AND** legacy direct adapter workflow reminders and native codemode/direct reminders retain their respective outer-name contract without reading input

#### Scenario: Required compatibility test unavailable or failing
- **WHEN** any mandatory host/adapter fixture cannot run or fails
- **THEN** the compatibility task remains unverified and dependent installer acceptance cannot claim pre-1.0 support, regardless of mocked installer test outcomes

#### Scenario: Adapter update cannot exceed validated compatibility
- **WHEN** a legacy adapter is installed or refreshed
- **THEN** the selected source remains within the verified policy, user constraints are preserved or diagnosed, and an untested latest adapter is not assumed compatible

### Requirement: Upgrade uses the same Pi backend decision
Plugin upgrade SHALL share the install version policy, refresh only eligible components, preserve configured pins and unrelated packages, and never invoke an all-extension update.

#### Scenario: Native upgrade with an existing adapter
- **WHEN** native Pi has an adapter and Chorus configured
- **THEN** upgrade refreshes only eligible Chorus packages, leaves the adapter untouched, and includes a migration warning even if package setup succeeds

#### Scenario: Legacy upgrade and constrained versions
- **WHEN** legacy Pi has pinned or ranged adapter/Chorus entries
- **THEN** upgrade preserves constraints and reports incomplete updates where required components cannot be refreshed

#### Scenario: Unsupported update or failed command
- **WHEN** targeted update/install support is missing or an eligible operation fails
- **THEN** the result reports incomplete setup without falling back to updating all extensions

### Requirement: Migration preserves user settings and secrets
Native installation and upgrade SHALL warn about detected adapters and explicit native-MCP disabling in known global/current-project settings, including object/pinned entries, without uninstalling packages or editing filters. Existing MCP configuration safety, agent-dir overrides, unrelated servers, and environment-based credentials SHALL be preserved. Unreadable relevant configuration SHALL produce diagnostic uncertainty rather than false conflict-free assurance.

#### Scenario: Adapter and disabled builtin remain user-controlled
- **WHEN** native settings contain an adapter or `-builtin:mcp`
- **THEN** Chorus gives actionable scoped guidance without deleting the adapter or changing the extension filter, including on an otherwise skipped installation

#### Scenario: Credential seeding retains server data
- **WHEN** Chorus seeds native or legacy MCP configuration
- **THEN** other server entries are preserved, the authorization header references the environment, and no literal API key is written to MCP config or diagnostics

#### Scenario: Adapter 5 primary configuration on a legacy host
- **WHEN** credential seeding configures a supported legacy host with adapter 5.0.0
- **THEN** it writes the agent-dir `mcp-adapter.json`, using the old `mcp.json` as a migration source only when the primary file does not exist, preserving existing primary data and explicit exposure choices
- **AND** a fresh Chorus entry enables direct tools, file permissions are 0600, old files are not deleted, and an unreadable or malformed primary is not silently replaced

#### Scenario: Native configuration remains native
- **WHEN** credential seeding configures a supported native host
- **THEN** it writes `mcp.json` without forcing adapter direct-tool settings or changing native default codemode exposure

### Requirement: Pi generic tool guidance supports native and legacy MCP
Generic tool resolution SHALL support native `mcp__chorus__chorus_*`, legacy `chorus_chorus_*`, and bare `chorus_*` names. Any non-workflow gateway compatibility SHALL remain separate from workflow event resolution. The workflow resolver SHALL inspect only the outer `toolName` and SHALL NOT read `input`, including getters. Invalid names SHALL not throw. Pi guidance SHALL prioritize the native tool surface while explaining legacy alternatives, and SHALL preserve the separate workflow-suffix matcher.

#### Scenario: Equivalent non-workflow tool identities
- **WHEN** generic normalization receives `chorus_get_idea`, `chorus_chorus_get_idea`, or `mcp__chorus__chorus_get_idea`
- **THEN** each resolves to `chorus_get_idea`

#### Scenario: Workflow events do not read gateway arguments
- **WHEN** a workflow event has outer name `mcp`, `mcp__chorus`, or an unrelated tool and an `input.tool` naming a workflow operation
- **THEN** it does not resolve that inner operation, reads no input getter, and produces no workflow reminder

#### Scenario: Malformed values and coexistence
- **WHEN** normalization receives null, non-string names, or malformed gateway arguments
- **THEN** it returns no resolved tool without crashing and does not remove separately implemented workflow matching behavior

#### Scenario: Optional production-provider verification unavailable
- **WHEN** optional production-provider smoke prerequisites are unavailable
- **THEN** verification records the actual missing prerequisite without conflating it with the mandatory isolated SDK/artifact compatibility matrix, which cannot be waived
