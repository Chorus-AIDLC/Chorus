# daemon-startup-output Specification

## Purpose
TBD - created by archiving change improve-daemon-cli-ux. Update Purpose after archive.
## Requirements
### Requirement: Boxed startup banner

On startup `chorus daemon` SHALL print a single boxed banner (in the visual style
of the `chorus` server startup banner) that summarizes, on one screen: the remote
server URL, the authenticated agent identity (name and uuid), the resolved
permission mode with `yolo` visually highlighted, the credential source, the
connection state, the `claude` install status (and resolved path when found), the
chorus CLI version, and the active agent type (`claude-code`). The banner SHALL
NOT display the raw API key (it shows the credential *source*, not the secret).
The banner SHALL render acceptably when the terminal is not a TTY (e.g. degrade
box-drawing to plain lines) without crashing.

#### Scenario: Banner summarizes the daemon state on start

- **WHEN** the daemon starts with resolved credentials and identity
- **THEN** it prints one boxed banner showing server URL, agent name+uuid,
  permission mode (yolo highlighted), credential source, connection state, claude
  install status/path, chorus version, and agent type — and never the raw API key

#### Scenario: Banner does not crash on a non-TTY stream

- **WHEN** the daemon's stdout is not a TTY (piped/redirected)
- **THEN** the banner still renders as plain text without throwing

### Requirement: Per-wake single-line lifecycle logs

During operation the daemon SHALL emit, by default, one compact single-line log
per wake lifecycle event: arrival of a task/instruction (naming the idea/task or
entity it targets), the Claude spawn distinguishing **new** vs **resume**, and the
run's completion (with duration and exit code). These default lines SHALL be
concise enough not to flood a long-running terminal. A `--verbose` flag SHALL
enable additional detail beyond the default single lines. At least once per
relevant wake, the output SHALL surface that the session can be taken over with
`claude --resume <idea-uuid>`.

#### Scenario: A wake logs arrival, spawn mode, and completion

- **WHEN** the daemon wakes Claude for a dispatched entity in the default
  verbosity
- **THEN** it logs one line for arrival (with the target idea/task/entity), one
  line indicating new-vs-resume at spawn, and one line at completion with duration
  and exit code

#### Scenario: Verbose adds detail without changing the default

- **WHEN** the daemon runs with `--verbose`
- **THEN** it prints additional per-wake detail, while the default (no `--verbose`)
  remains one line per lifecycle event

#### Scenario: Resume hint is surfaced

- **WHEN** the daemon spawns or resumes a session anchored on an idea uuid
- **THEN** the output makes the `claude --resume <idea-uuid>` takeover capability
  discoverable

### Requirement: `claude` installation detection at startup

On startup the daemon SHALL detect whether the `claude` executable is installed
(reusing the existing PATH resolution, including the Windows `claude.cmd` shim and
any configured override) and SHALL report the result in the startup banner —
showing the resolved path when found, or a clear "not found" indication with
guidance when absent. When `claude` is **not** found, the daemon SHALL, in
addition to the banner row, emit exactly one prominent `⚠` warning line to
**stderr** at startup — in the visual style of the YOLO autonomy warning line —
stating that wakes will fail until `claude` is installed (or `CHORUS_CLAUDE_PATH`
is set) and that `PATH` must include the directory holding `claude` (e.g.
`~/.local/bin`). This stderr line ensures the missing binary is visible in an
unattended/systemd journal at startup rather than only when a wake later fails.
A missing `claude` SHALL NOT prevent the daemon from subscribing; the daemon SHALL
still start, with wakes also surfacing the missing-binary error visibly when one
arrives (preserving current non-fatal behavior).

#### Scenario: Installed claude is reported with its path

- **WHEN** `claude` is resolvable on PATH (or via the configured override) at
  startup
- **THEN** the banner shows that claude is installed and the resolved path, and no
  `⚠` claude-not-found warning line is emitted

#### Scenario: Missing claude is reported but does not block startup

- **WHEN** `claude` cannot be resolved at startup
- **THEN** the banner clearly indicates claude was not found with guidance, the
  daemon emits exactly one prominent `⚠` stderr warning line naming how to fix it,
  and the daemon still starts and subscribes

### Requirement: Per-subcommand help for client commands

The CLI SHALL provide dedicated `--help` output for the client subcommands
`chorus daemon` and `chorus login`, describing their flags and usage. Passing
`--help` (or `-h`) to a client subcommand SHALL print that help and exit without
starting the daemon or the login flow. Help for the bare `chorus` server command
SHALL continue to work as before.

#### Scenario: `chorus daemon --help` prints daemon help and exits

- **WHEN** the user runs `chorus daemon --help`
- **THEN** the CLI prints daemon-specific help (flags such as `--yolo`,
  `--chorus-only`, `--agent`, `-d`/lifecycle, `--verbose`) and exits without
  starting the daemon

#### Scenario: `chorus login --help` prints login help and exits

- **WHEN** the user runs `chorus login --help`
- **THEN** the CLI prints login-specific help and exits without running the login
  flow

#### Scenario: Bare server help still works

- **WHEN** the user runs `chorus --help`
- **THEN** the existing server help is printed as before

