## MODIFIED Requirements

### Requirement: Correlated remote directory requests
The server SHALL authorize and persist each roots, list, or validate request,
dispatch it to the selected online Agent instance over the connection-specific
control channel, and expose pending and terminal request states. The daemon
SHALL report the correlated result through an authenticated endpoint before the
deadline. A roots request MUST return only that daemon's currently effective,
normalized `browseRoots` in configured order and MUST NOT accept a client path.

#### Scenario: Effective roots are requested
- **WHEN** an authorized user selects an online Agent host for directory browsing
- **THEN** the daemon MUST return its currently effective normalized browse roots
- **AND** the server MUST NOT infer, merge, or expand those roots

#### Scenario: Target instance is offline
- **WHEN** the selected Agent instance has no effective online connection
- **THEN** request creation MUST return `HOST_OFFLINE` without dispatching to another host

#### Scenario: Daemon does not answer before deadline
- **WHEN** a dispatched roots, list, or validate request remains incomplete at its deadline
- **THEN** the read API MUST return terminal `TIMEOUT` and MUST NOT return cached roots or candidates

### Requirement: Safe one-level prefix completion
The daemon SHALL accept an absolute path prefix for list requests, derive its
parent and basename prefix, and return only matching direct child directories
under an effective browse root. It MUST normalize paths, enforce
component-aware root containment, exclude symlinks and hidden entries, omit
inaccessible entries, sort deterministically, and enforce scan, time, page, and
result limits. Consumers MUST keep results bounded and MUST require at least one
basename character before automatically issuing a list request.

#### Scenario: Prefix resolves inside a browse root
- **WHEN** an authorized request supplies `/home/user/proj` and accessible direct child directories match that prefix
- **THEN** the response MUST contain only normalized matching direct-child `{name, path}` entries in stable order

#### Scenario: Prefix escapes a root
- **WHEN** normalization or traversal would place the parent or candidate outside every browse root
- **THEN** the request MUST fail with `OUTSIDE_ROOT` without revealing whether the target exists

#### Scenario: Entry is hidden, inaccessible, or a symlink
- **WHEN** a scanned child is hidden, cannot be safely traversed by the daemon identity, or is a symbolic link
- **THEN** that entry MUST be omitted from results

#### Scenario: Automatic completion is bounded
- **WHEN** a user types the first basename character under a selected browse root
- **THEN** the client MUST request only the bounded first result page
- **AND** further characters MUST refine the prefix instead of causing unbounded enumeration
