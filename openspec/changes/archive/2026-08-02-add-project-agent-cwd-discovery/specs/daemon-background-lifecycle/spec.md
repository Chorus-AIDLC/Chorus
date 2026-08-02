## ADDED Requirements

### Requirement: Install SHALL persist browse roots separately from served cwds
`chorus daemon install` SHALL accept repeatable `--browse-root` values, normalize and de-duplicate them, and persist them as `browseRoots` in `~/.chorus/daemon.json` through the existing owner-only field-merge writer. It MUST preserve credentials, `cwds`, Agent selection, and other daemon fields. The generated service unit MUST NOT embed browse-root arguments.

#### Scenario: Install receives browse roots
- **WHEN** an operator runs `chorus daemon install --browse-root ~/work --browse-root /srv/repos`
- **THEN** the normalized roots MUST be stored in `daemon.json` independently from `cwds`
- **AND** the installed service MUST read them from that file at startup

#### Scenario: Install runs without browse-root flags
- **WHEN** `daemon.json` already contains `browseRoots`
- **THEN** reinstall MUST preserve and reuse them without prompting or replacing them
