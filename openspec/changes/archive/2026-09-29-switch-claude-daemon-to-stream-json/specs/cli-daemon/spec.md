## MODIFIED Requirements

### Requirement: Task-dispatch wake of local headless Claude Code

On receiving a relevant notification (at minimum `task_assigned`), the daemon SHALL spawn a local headless Claude Code subprocess (`claude -p` with `--input-format stream-json`, `--output-format stream-json` and the Chorus MCP server configured via `--mcp-config`) to act on the dispatched work. The daemon SHALL feed the prompt to the subprocess over stdin as a stream-json user frame rather than as a command-line argument, and SHALL keep stdin open until the turn's terminal result. Each wake SHALL be non-blocking with respect to the notification subscription, and a failure of one wake SHALL be logged visibly without terminating the daemon.

#### Scenario: Task assignment wakes Claude Code

- **WHEN** the subscribed agent receives a `task_assigned` notification
- **THEN** the daemon spawns a headless `claude -p` subprocess wired to the Chorus MCP server, passing the task context prompt over stdin as a stream-json user frame, and the subprocess can act via `chorus_*` MCP tools

#### Scenario: One failed wake does not kill the daemon

- **WHEN** a spawned subprocess fails to start or exits with an error
- **THEN** the daemon logs the failure visibly and continues processing subsequent notifications

### Requirement: Cross-platform headless spawn

The daemon's subprocess spawning SHALL work on Linux, macOS, and Windows without relying on a shell. It SHALL resolve the real `claude` executable path (including the Windows `claude.cmd` shim) and spawn it directly without `shell:true`. It SHALL write the MCP configuration file to the OS temporary directory (`os.tmpdir()`), not a hardcoded path. It SHALL parse the subprocess's newline-delimited JSON output line by line, tolerating Windows `\r\n` line endings, and SHALL write its newline-delimited JSON input frames over the same stdin pipe on every platform.

#### Scenario: Windows spawn resolves the .cmd shim without a shell

- **WHEN** the daemon runs on Windows where `claude` is installed as `claude.cmd`
- **THEN** it resolves and spawns the real `claude.cmd` path directly without `shell:true`, and the prompt is delivered over stdin as a stream-json user frame

#### Scenario: Stream-json output parses across platforms

- **WHEN** the subprocess emits newline-delimited JSON with `\r\n` line endings on Windows
- **THEN** the daemon strips the trailing carriage return and parses each line as JSON without error
