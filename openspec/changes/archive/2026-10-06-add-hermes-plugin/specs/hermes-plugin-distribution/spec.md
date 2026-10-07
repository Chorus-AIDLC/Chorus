## ADDED Requirements

### Requirement: The Hermes integration SHALL ship as two installable directories under one package folder

`packages/chorus-hermes/` MUST contain a native plugin directory `chorus/` (with `plugin.yaml` and an `__init__.py` exposing `register(ctx)`) and a portable Agent Plugin directory `chorus-mcp/` (with `plugin.json` and `mcp.json`, and no Python code). Each directory MUST be independently installable by `hermes plugins install` and MUST load: after install and enable, `hermes plugins list` MUST show it enabled with no load error. `hermes plugins validate` MUST report no errors other than catalog-admission-only rules, and any such rule MUST be listed in the README compatibility notes.

#### Scenario: Both directories load

- **WHEN** both directories are installed and enabled on the pinned Hermes version
- **THEN** `hermes plugins list` MUST show both enabled with no load error
- **AND** `hermes plugins validate` MUST report no non-catalog errors

#### Scenario: Native plugin carries no MCP declaration it cannot load

- **WHEN** `packages/chorus-hermes/chorus/` is inspected
- **THEN** it MUST NOT contain a `mcp.json` file
- **AND** the Chorus MCP server MUST be declared only in `packages/chorus-hermes/chorus-mcp/mcp.json`

### Requirement: The portable package SHALL declare the Chorus MCP server with environment-only credentials

`chorus-mcp/mcp.json` MUST declare one server named `chorus` of type `streamable-http` with header `Authorization: Bearer ${CHORUS_API_KEY}`. Because Hermes does not expand `${VAR}` in a portable `url` (Task 1 spike 5), the URL MUST be the literal loopback `http://localhost:8637/api/mcp`; for any other deployment the documented (and `chorus agents add`-written) native `mcp_servers.chorus` entry with `url: ${CHORUS_URL}/api/mcp` and the same header placeholder MUST be used, which overrides the portable server of the same name. No file in `packages/chorus-hermes/` MAY contain a literal API key, a `cho_` token, or a deployment URL other than placeholders and documentation examples.

#### Scenario: MCP tools appear with the expected prefix

- **GIVEN** `CHORUS_URL` and `CHORUS_API_KEY` are exported and both directories are installed and enabled
- **WHEN** a Hermes session starts
- **THEN** Chorus MCP tools MUST be available to the model (for example `mcp__chorus__chorus_checkin`)

#### Scenario: No secrets in the package

- **WHEN** `packages/chorus-hermes/` is grepped for `cho_[A-Za-z0-9_-]{16,}`
- **THEN** there MUST be zero matches

### Requirement: The plugin SHALL be distributed by git-subdirectory install pinned to a release tag's commit

Hermes `--ref` accepts only a full 40-character commit SHA. The supported install path MUST therefore resolve the release tag `v<version>` to its peeled commit SHA (`git ls-remote https://github.com/Chorus-AIDLC/Chorus.git 'refs/tags/v<version>^{}'`, falling back to the unpeeled `refs/tags/v<version>` for lightweight tags), then run `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/<dir> --ref <sha> --enable` for each of the two directories. If the tag cannot be resolved, the install MUST fail with a clear message and MUST NOT fall back to an unpinned install. No npm or PyPI artifact MAY be required, and no commit SHA MAY be committed to the repository. `plugin.yaml` and `plugin.json` versions MUST equal the root Chorus `package.json` version, and the release workflow MUST keep them in sync.

#### Scenario: Version is synchronised

- **WHEN** the Chorus version is bumped
- **THEN** `packages/chorus-hermes/chorus/plugin.yaml` `version` and `packages/chorus-hermes/chorus-mcp/plugin.json` `version` MUST equal the new root version
- **AND** a unit test MUST fail if they diverge

#### Scenario: Pinned install from the monorepo

- **WHEN** a user runs the documented tag-to-SHA resolution and install commands for `v<version>`
- **THEN** Hermes MUST install only the named subdirectory at the tag's commit
- **AND** `hermes plugins list` MUST show both plugins enabled and pinned to that SHA

#### Scenario: Unknown tag

- **WHEN** the tag `v<version>` does not exist on the remote
- **THEN** the install MUST stop with an error naming the tag
- **AND** nothing MUST be installed
