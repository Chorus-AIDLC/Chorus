# Design — `chorus daemon install`

## Context

`chorus daemon -d` self-daemonizes (detached process-group leader, `unref`,
JSON pidfile). That is correct for an ad-hoc background run driven by the
lifecycle subcommands, but wrong under an OS supervisor: a supervisor must own
the daemon process directly so it can track liveness and deliver a stop signal.
Running `-d` under `Type=forking` breaks both — systemd cannot find the
`MainPID`, and the pidfile double-start guard turns `Restart` into a loop.

## Goals

- One command installs a *correct* boot-autostart service; operators never
  hand-write the unit.
- The lifecycle verbs keep working after install, delegating to the supervisor
  instead of the (now-absent) pidfile.
- Linux-first, fully automated; macOS/Windows get a correct printed template
  (no native-service coupling, no new dependencies).

## Decisions

### D1 — Foreground `Type=simple`, never `-d`

The generated unit runs `node chorus.mjs daemon <--cwd …>` with **no** `-d`.
systemd owns the node process as `MainPID`; `systemctl --user stop` sends
SIGTERM to the cgroup, which the daemon's existing graceful-shutdown handler
already drains (SSE close + in-flight wake drain) within `TimeoutStopSec`. No
pidfile is involved, so there is nothing to double-start and no orphan.

### D2 — No `ExecStop`

For a `Type=simple` unit the default stop is SIGTERM to the unit's cgroup —
exactly what the daemon handles. A pidfile-based `ExecStop=chorus daemon stop`
would be a no-op here (a foreground daemon writes no pidfile) and is omitted.

### D3 — `Restart=on-failure`, not `always`

`on-failure` restarts on a crash (non-zero exit) but leaves a clean
`systemctl stop` stopped, so an operator can actually stop the service. This is
also what prevents the storm: a clean stop does not re-trigger a start.

### D4 — Pure rendering, injected IO

`renderSystemdUnit(spec)` / `renderLaunchdPlist(spec)` are pure string
functions (all the correctness risk lives in the unit text, so it is unit
tested exhaustively). `detectSupervisor` / `installService` / `uninstallService`
and the `systemctlUser` / `journalctlUser` delegators take an injectable `io`
bundle (`spawnSync`, fs, `platform`, `home`) — the same seam as
`daemon-lifecycle.mjs`, so every branch is testable on one host with no real
systemctl or disk.

### D5 — Detection gates delegation

`detectSupervisor(io)` returns `{ kind: "systemd", installed, active }` only on
Linux when the unit file exists or `systemctl --user is-active` reports active;
`{ kind: "none" }` otherwise. `handleLifecycleAction` treats
`kind === "systemd" && installed` as *supervised* and routes
status/stop/restart/logs to systemctl/journalctl; every other case falls
through to the pre-existing pidfile path unchanged. The probe never throws
(spawn failure → `{ kind: "none" }`), so a host without systemd degrades to the
old behavior.

### D6 — Capture the invoking flags

`install` reads the parsed `--cwd` (array), `--agent`, `--chorus-only` from the
client flags and bakes them into the unit's `ExecStart`, plus absolute
node/script paths (`process.execPath`, resolved `chorus.mjs`) and the current
`PATH` so `node`/`claude`/`codex` resolve at boot as they did in the operator's
shell.

## Alternatives considered

- **Keep `-d` but add `PIDFile=` to a `Type=forking` unit.** Rejected: the
  pidfile is JSON (`{"pid":…}`), which systemd cannot parse as a PID, and the
  self-fork/`unref` still detaches the child out of the service cgroup.
- **`Restart=always`.** Rejected: makes `systemctl stop` immediately restart,
  reintroducing an "unkillable" feel.
- **Auto-install launchd on macOS.** Deferred (YAGNI): the affected + primary
  deployment target is Linux; a printed, correct plist template covers macOS
  without coupling the CLI to `launchctl` semantics.

## Risks

- **PATH capture leaks a dev shell's PATH into the unit.** Acceptable: it is a
  superset that still resolves the needed binaries; documented.
- **`enable --now` on an already-active identical unit does not restart it.**
  Correct and intended — install is idempotent and non-disruptive.
