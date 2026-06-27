# daemon-permission-mode Specification

## Purpose
TBD - created by archiving change improve-daemon-cli-ux. Update Purpose after archive.
## Requirements
### Requirement: Default permission mode is YOLO

The `chorus daemon` default permission mode for the woken Claude SHALL be `yolo`
(full autonomy — `--dangerously-skip-permissions`: Bash, file writes, any command
under the daemon's API key), reversing the prior `chorus-only` default. The
explicit `--yolo` flag and `CHORUS_YOLO=1` env SHALL remain accepted and SHALL
continue to select `yolo`. Whenever the daemon runs in `yolo`, startup output
SHALL prominently warn that the woken Claude has full autonomy and SHALL state how
to reclaim the restricted posture.

#### Scenario: Default run is yolo

- **WHEN** the user runs `chorus daemon` with no permission flags and no prior
  state forcing otherwise
- **THEN** the resolved permission mode is `yolo` and startup output prominently
  warns that the woken Claude has full autonomy

### Requirement: TTY first-run YOLO confirmation with persisted acknowledgement

The daemon SHALL require an interactive `y/N` confirmation before starting when
the resolved mode is `yolo`, standard input is a TTY, and no valid acknowledgement
is recorded. On an affirmative answer it SHALL persist a
`yoloAckAt` timestamp (ISO-8601) into `~/.chorus/daemon.json` and proceed; on any
other answer it SHALL NOT start in `yolo` (it SHALL exit or fall back to the
restricted posture without persisting an ack). On a subsequent TTY start where a
valid `yoloAckAt` is present, the daemon SHALL NOT prompt again. The `yoloAckAt`
field SHALL be stored in the same `~/.chorus/daemon.json` file as the credentials.

#### Scenario: First TTY yolo run prompts and remembers

- **WHEN** the daemon would start in yolo on a TTY with no recorded ack
- **THEN** it prompts `y/N`, and on `y` it writes `yoloAckAt` to
  `~/.chorus/daemon.json` and starts

#### Scenario: Declining the confirmation does not start yolo

- **WHEN** the user answers anything other than yes to the yolo confirmation
- **THEN** the daemon does not start in yolo and does not persist an ack

#### Scenario: Subsequent TTY run with a recorded ack does not re-prompt

- **WHEN** the daemon starts in yolo on a TTY and `~/.chorus/daemon.json` already
  carries a valid `yoloAckAt`
- **THEN** it starts without prompting again

### Requirement: Non-TTY YOLO runs directly with a warning

The daemon SHALL, when the resolved mode is `yolo` and standard input is **not** a
TTY (unattended: systemd / nohup / CI / background child), start in `yolo`
directly without requiring any confirmation or additional switch, emitting exactly
one prominent `⚠` warning line recording that it is running with full autonomy
unattended.

#### Scenario: Unattended yolo start warns and runs

- **WHEN** the daemon resolves yolo and stdin is not a TTY
- **THEN** it starts in yolo immediately, emitting one prominent warning line, and
  does not block on or require any confirmation

### Requirement: Reverse restricted switch `--chorus-only`

The daemon SHALL accept a `--chorus-only` flag and a `CHORUS_CHORUS_ONLY=1` env
that force the restricted posture, where the woken Claude may use only Chorus MCP
tools (`mcp__chorus__*`) and not Bash or file edits. When the restricted posture
is selected this way, no yolo confirmation SHALL be required and no `yoloAckAt`
SHALL be needed. The yolo startup warning SHALL name `--chorus-only` as the way to
reclaim the restricted posture.

#### Scenario: `--chorus-only` forces the restricted posture

- **WHEN** the user runs `chorus daemon --chorus-only` (or sets
  `CHORUS_CHORUS_ONLY=1`)
- **THEN** the resolved permission mode is restricted (`mcp__chorus__*` only), no
  yolo confirmation is requested, and the woken Claude cannot run Bash or edit
  files

