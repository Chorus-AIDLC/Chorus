# Fix daemon stop false-stale under NTP clock step

## Why

`chorus daemon stop` against a **live** daemon reports
`no live daemon (cleared stale pidfile for pid 1188)`, unlinks the pidfile
without killing anything, and a second `stop` reports
`no daemon is running (no pidfile)` — while the daemon keeps running and
holding its declared paths (`chorus daemon` then refuses with
"all N declared paths are already served by a live daemon").

Root cause (confirmed on a live AWS host, idea e55ae33a): the
identity-verified liveness probe (`processAlive` in
`cli/daemon-lifecycle.mjs`) compares the pidfile's recorded `startedAt`
against `ps -o lstart=` output by **string equality**. On Linux, `lstart` is
computed dynamically as `btime + starttime_ticks/HZ` — it is not a stored
timestamp. When the system clock is stepped after the daemon starts (chrony
stepped this host's clock by +2.148 s ten seconds after boot, right after
systemd autostarted `chorus daemon -d`), every process's `lstart` shifts.
The recorded `startedAt` (`Sat Jul 4 21:23:02 2026`) no longer string-equals
the live daemon's post-step lstart (`Sat Jul 4 21:23:04 2026`), so the probe
returns false-stale **even though the argsHint cmdline check already
matched**. Boot-time NTP correction is near-universal on cloud hosts, so
"a boot-autostarted daemon can never be stopped" reproduces reliably.

This is exactly the direction the probe's own design flags as dangerous:
false-stale destroys the only record the CLI has of the daemon.

## What Changes

- `processAlive` decision order changes (owner-picked option A, elaboration
  round 2): when the pidfile records an `argsHint` and the live process's
  command line matches it, the process is **classified as our daemon** —
  `startedAt` no longer vetoes an argsHint match. `startedAt` remains a
  factor only when no `argsHint` was recorded (older identity records),
  where it still compares by string equality as before.
- No pidfile format change, no new fields, no platform-specific code paths.
- All other probe behavior is preserved: ESRCH → stale, argsHint mismatch →
  stale, unverifiable identity query on an identity-carrying record →
  conservative running, legacy-record fallbacks unchanged.
- Regression unit tests covering the clock-step scenario (argsHint matches,
  startedAt differs → running), plus the inverse guard (argsHint mismatch →
  stale regardless of startedAt).

## Capabilities

### Modified

- `daemon-background-lifecycle`: the "Identity-verified pidfile liveness"
  requirement's comparison rule changes from "any mismatch → stale" to
  "argsHint match wins; startedAt only decides when no argsHint is recorded".

## Impact

- Code: `cli/daemon-lifecycle.mjs` (`processAlive`), tests in
  `cli/__tests__/daemon-lifecycle.test.mjs`.
- No API, DB, UI, or i18n impact. CLI-only.
- Out of scope (owner decision, round 1 q4=b): orphan-daemon recovery when
  the pidfile is already gone — not needed once the mis-clear stops
  happening; `--force` remains the manual escape hatch.
