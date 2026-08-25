# dsh-connection-guide Specification (delta)

## MODIFIED Requirements

### Requirement: Complete dsh connection guides

The repository SHALL provide `docs/CONNECT_DSH.md` and `docs/CONNECT_DSH.zh.md` as English and Chinese references for connecting DeepSeek Harness (`dsh`) to Chorus. Both guides SHALL cover prerequisites, Chorus environment variables, configuring the Chorus plugin via `chorus init` (or `npx @chorus-aidlc/chorus init`), launch and check-in verification, non-interactive usage, troubleshooting, and links to related connection documentation. The guides SHALL NOT present a retired `curl | bash` installer (`install-dsh.sh` / `dsh-credentials.sh`) as the setup command; the retired `dsh-credentials.sh` bootstrap is a deprecation stub that redirects to `chorus init` (see `chorus-cli-bootstrap-migration`).

The documented setup commands and connection behavior MUST match `chorus init`.

#### Scenario: Reader follows the interactive setup guide

- **WHEN** a reader with dsh installed and a valid Chorus API key follows either dsh connection guide
- **THEN** the guide SHALL provide the environment exports, the `chorus init` command, and verification steps needed to connect dsh to Chorus

#### Scenario: Reader needs non-interactive installation or troubleshooting

- **WHEN** a reader is installing without a TTY or encounters a common setup or authentication failure
- **THEN** the guide SHALL provide a non-interactive `chorus init` invocation and troubleshooting guidance consistent with the CLI's actual validation and managed files
