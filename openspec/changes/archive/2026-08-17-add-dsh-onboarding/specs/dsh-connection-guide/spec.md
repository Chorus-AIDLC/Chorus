## ADDED Requirements

### Requirement: Complete dsh connection guides

The repository SHALL provide `docs/CONNECT_DSH.md` and `docs/CONNECT_DSH.zh.md` as English and Chinese references for connecting DeepSeek Harness (`dsh`) to Chorus. Both guides SHALL cover prerequisites, Chorus environment variables, the `install-dsh.sh` command and its managed configuration behavior, launch and check-in verification, non-interactive usage, troubleshooting, and links to related connection documentation.

The documented commands and file behavior MUST match `public/install-dsh.sh`.

#### Scenario: Reader follows the interactive setup guide

- **WHEN** a reader with dsh installed and a valid Chorus API key follows either dsh connection guide
- **THEN** the guide SHALL provide the environment exports, installer command, and verification steps needed to connect dsh to Chorus

#### Scenario: Reader needs non-interactive installation or troubleshooting

- **WHEN** a reader is installing without a TTY or encounters a common installer or authentication failure
- **THEN** the guide SHALL provide a non-interactive command and troubleshooting guidance consistent with the installer's actual validation and managed files

### Requirement: dsh appears in supported-harness documentation

The English, Chinese, Japanese, and Korean READMEs and the daemon and MCP tools references SHALL include dsh wherever they enumerate supported setup-guide clients, daemon backends, MCP plugin surfaces, or connection guides. English documentation SHALL link to `CONNECT_DSH.md`; Chinese documentation SHALL link to `CONNECT_DSH.zh.md` where a localized link list is present. Human-visible setup-guide labels SHALL use `DeepSeek Harness`, while technical client identifiers may use `dsh`.

#### Scenario: Reader scans a supported-harness list

- **WHEN** a reader views a README setup overview, daemon backend list, or MCP tools harness list
- **THEN** dsh SHALL appear alongside the other first-class supported harnesses with setup-guide terminology consistent with the `DeepSeek Harness` presence label

### Requirement: Onboarding design source includes dsh

The encrypted `docs/design.pen` source SHALL include the `DeepSeek Harness` onboarding tab and its setup content, aligned with the implemented tab order and responsive behavior. The file MUST be modified and validated only through Pencil MCP tooling.

#### Scenario: Designer inspects the onboarding source

- **WHEN** the onboarding install-guide design is opened through Pencil
- **THEN** it SHALL show `DeepSeek Harness` between Kiro and OpenCode and represent the dsh setup flow without regressions in the light or dark design states
