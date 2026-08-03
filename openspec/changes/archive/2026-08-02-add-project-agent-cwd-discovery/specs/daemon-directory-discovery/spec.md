## ADDED Requirements

### Requirement: Daemon browse-root configuration
The daemon SHALL resolve a host-local directory-discovery allowlist independently from startup `cwds`, using `--browse-root` over `CHORUS_DAEMON_BROWSE_ROOTS` over `~/.chorus/daemon.json` `browseRoots` over the daemon OS user's home directory. `chorus daemon install --browse-root` SHALL persist normalized roots through the existing owner-only field-merge configuration writer, and changes SHALL take effect after daemon restart.

#### Scenario: No browse roots are configured
- **WHEN** a daemon starts without a browse-root flag, environment value, or stored value
- **THEN** its effective browse root MUST be the daemon OS user's home directory

#### Scenario: Browse roots do not become startup connections
- **WHEN** a path is configured only as a browse root
- **THEN** the daemon MUST NOT register that path as a startup cwd or create an online Agent instance for it

### Requirement: Correlated remote directory requests
The server SHALL authorize and persist each list or validate request, dispatch it to the selected online Agent instance over the connection-specific control channel, and expose pending and terminal request states. The daemon SHALL report the correlated result through an authenticated endpoint before the deadline.

#### Scenario: Target instance is offline
- **WHEN** the selected Agent instance has no effective online connection
- **THEN** request creation MUST return `HOST_OFFLINE` without dispatching to another host

#### Scenario: Daemon does not answer before deadline
- **WHEN** a dispatched request remains incomplete at its deadline
- **THEN** the read API MUST return terminal `TIMEOUT` and MUST NOT return cached candidates

### Requirement: Safe one-level prefix completion
The daemon SHALL accept an absolute path prefix, derive its parent and basename prefix, and return only matching direct child directories under an effective browse root. It MUST normalize paths, enforce component-aware root containment, exclude symlinks and hidden entries, omit inaccessible entries, sort deterministically, and enforce scan, time, page, and result limits.

#### Scenario: Prefix resolves inside a browse root
- **WHEN** an authorized request supplies `/home/user/proj` and accessible direct child directories match that prefix
- **THEN** the response MUST contain only normalized matching direct-child `{name, path}` entries in stable order

#### Scenario: Prefix escapes a root
- **WHEN** normalization or traversal would place the parent or candidate outside every browse root
- **THEN** the request MUST fail with `OUTSIDE_ROOT` without revealing whether the target exists

#### Scenario: Entry is hidden, inaccessible, or a symlink
- **WHEN** a scanned child is hidden, cannot be safely traversed by the daemon identity, or is a symbolic link
- **THEN** that entry MUST be omitted from results

### Requirement: Stable discovery failures
Directory discovery SHALL expose stable error codes for offline host, timeout, invalid path, outside root, non-directory, access denied, stale target, limit exceeded, and internal failure. An error MUST NOT be represented as an empty successful result.

#### Scenario: Empty directory versus failed request
- **WHEN** an accessible directory has no matching children
- **THEN** the request MUST succeed with an empty items array
- **AND** when the scan fails it MUST instead return the corresponding typed error
