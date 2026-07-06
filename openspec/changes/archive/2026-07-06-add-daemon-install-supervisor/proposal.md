# Add `chorus daemon install` — correct supervisor unit generator

## Why

The daemon-background-lifecycle spec previously mandated that OS auto-start be
**documentation templates only** — the CLI shipped no install command and left
operators to hand-write a service unit. In practice that produced a
catastrophic failure on a real AWS host (idea e55ae33a follow-up):

An operator wrote a `systemd --user` unit as `Type=forking` +
`ExecStart=… chorus daemon … -d` + `Restart=on-failure`. But `chorus daemon -d`
**self-daemonizes**: it forks a detached, `unref`'d child and writes a JSON
pidfile that systemd cannot parse as a PID. So systemd never adopts the forked
child as `MainPID`, treats the service as failed, and `Restart=on-failure`
retries every few seconds. Each retry's `-d` preflight then finds the previous
orphan still alive via the pidfile and refuses to start
(`a daemon is already running`) — an infinite loop. On the affected host the
restart counter reached **1533** over ~4.5 hours in a single boot, and the
orphaned daemon simultaneously held the pidfile and the server-side
DaemonConnection rows for every declared path (`all declared paths are already
served`), so neither `systemctl stop` (wrong `MainPID`) nor `chorus daemon stop`
(defeated separately by an NTP false-stale) could kill it.

The root cause is the integration model: a self-daemonizing `-d` process must
never run under a `Type=forking` supervisor. The fix is to stop asking
operators to hand-write units and instead **generate a correct one**.

## What Changes

- Add `chorus daemon install [--cwd … --agent … --chorus-only]` and
  `chorus daemon uninstall`.
- On Linux, `install` generates a `systemd --user` unit that runs the daemon in
  the **foreground** (`Type=simple`, no `-d`) so systemd owns the process
  directly, writes it to `~/.config/systemd/user/chorus-daemon.service`, then
  `daemon-reload` + `enable --now` (immediate start + boot autostart). It
  captures the `--cwd`/`--agent`/`--chorus-only` flags the operator passed.
- On macOS/Windows, `install` prints a correct launchd plist / foreground
  command template with manual steps and exits 0 without writing (no
  auto-install off Linux — avoids native-service coupling; matches the
  cross-platform-no-native-deps constraint).
- `chorus daemon status`/`stop`/`restart`/`logs` detect an installed supervisor
  unit and transparently delegate to `systemctl`/`journalctl`; otherwise they
  fall back to the existing pidfile/logfile logic. A supervised daemon is thus
  never misreported as "not running".
- Supersede the "OS auto-start provided as documentation templates only"
  requirement.

## Capabilities

- `daemon-background-lifecycle` (MODIFIED + ADDED requirements)

## Impact

- CLI-only change: new `cli/daemon-service.mjs` module, wiring in `cli/daemon.mjs`
  and `cli/client-args.mjs`, docs in `docs/DAEMON.md`. No server, schema, or API
  changes. The `-d` detached path is unchanged and still available for ad-hoc
  background runs.
