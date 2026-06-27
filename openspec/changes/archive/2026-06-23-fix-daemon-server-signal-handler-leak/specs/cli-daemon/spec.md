## ADDED Requirements

### Requirement: Server signal handlers confined to the server launch path

The CLI entry SHALL install the server's process-signal handlers — the `SIGINT` and
`SIGTERM` graceful-shutdown handler and the `exit` handler that force-kills an embedded
PGlite process — ONLY when invoked with no client subcommand (i.e. when launching the
Chorus server). When invoked as a client subcommand (`chorus daemon` or `chorus login`),
the entry SHALL NOT install any of these server signal handlers. Consequently a
`chorus daemon` process SHALL terminate on `SIGINT`/`SIGTERM` exclusively through the
daemon's own graceful shutdown path (which disconnects the SSE subscription and the MCP
client and logs `[Chorus] shutting down daemon...`), and SHALL NOT emit the server's bare
`Shutting down...` line. The registration of these handlers SHALL be encapsulated such that
the guard is verifiable in isolation, without spawning a process or delivering a real
fatal signal.

#### Scenario: Daemon subcommand does not install server signal handlers

- **WHEN** the CLI entry is evaluated for a client subcommand (`chorus daemon` or
  `chorus login`)
- **THEN** no server `SIGINT`, `SIGTERM`, or `exit` handler is registered, so only the
  daemon's own graceful shutdown handler is active

#### Scenario: Bare CLI still installs the server signal handlers

- **WHEN** the CLI entry is evaluated with no subcommand (launching the server)
- **THEN** the server's `SIGINT`, `SIGTERM`, and `exit` handlers are registered exactly as
  before, and the server shuts down via its existing path

#### Scenario: Daemon shuts down gracefully on SIGTERM

- **WHEN** a running `chorus daemon` process receives `SIGTERM`
- **THEN** the process shuts down through the daemon's graceful path — disconnecting the
  SSE subscription and the MCP client and logging `[Chorus] shutting down daemon...` — and
  does NOT print the server's bare `Shutting down...` line
