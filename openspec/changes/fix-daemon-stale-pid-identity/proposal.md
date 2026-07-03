# Fix: daemon lifecycle misjudges reboot-recycled PIDs (EPERM treated as "alive")

## Why

`chorus daemon stop` fails with `[Chorus] failed to signal pid 1174: kill EPERM` even though no daemon is running, and the user cannot recover without manually deleting `~/.chorus/daemon.pid`. Reproduced on a real machine:

1. `~/.chorus/daemon.pid` records the last daemon's pid (e.g. 1174).
2. The machine reboots; the old daemon is gone and the OS recycles pid 1174 — in the reproduced case to root's `dockerd`.
3. `processAlive()` (`cli/daemon-lifecycle.mjs:74`) probes with `kill(pid, 0)` and **deliberately maps EPERM to "alive (just not ours)"** (`daemon-lifecycle.mjs:80`). Signaling a root process yields EPERM → `running: true` instead of `stale: true`.
4. `stopDaemon()` proceeds to the real `kill(pid, "SIGTERM")` (`daemon-lifecycle.mjs:170`); an unprivileged user cannot signal a root process → `kill EPERM`, returned as `reason: "error"`.
5. The error path does not clean the pidfile, so every subsequent `stop` hits the same error and `chorus daemon -d` refuses to start (`alreadyRunning: true`). **Permanently stuck with no self-heal path.**

The "EPERM = alive" assumption is correct in exactly one scenario (a live process we don't own) but cannot distinguish "our daemon still alive after a privilege change" from "pid recycled to someone else's process". After a reboot, the latter is the norm.

All four lifecycle paths share the broken probe: `stop` errors out, `start -d` refuses to start, `status` reports a phantom running daemon, and `restart` inherits stop's failure.

## What Changes

- **Identity verification replaces bare pid probing** in the shared `processAlive`/`isRunning` (per elaboration q1=c, q5=a): when the pid exists (including the EPERM case), a single `ps` (POSIX) / `tasklist`-equivalent (Windows) query fetches the process's command line and start time; a mismatch against the recorded identity ⇒ `stale`, not `running`. All four paths (start/status/stop/restart) benefit through the shared helper.
- **`daemon.pid` upgrades to JSON** (q2=a): `{pid, startedAt, argsHint}` written at the same path by `startBackground`; the reader stays backward-compatible with the legacy plain-number format.
- **Legacy pidfile upgrade path self-heals** (q3=a): with no recorded identity (plain-number pidfile from an older CLI), fall back to a live cmdline check — a `chorus daemon` cmdline ⇒ running; a non-daemon cmdline ⇒ stale, auto-cleaned. In the EPERM case specifically (the reboot scenario q3 addressed), an unreadable/failed cmdline query also ⇒ stale — EPERM on a legacy record already signals the process is not ours, so self-heal proceeds even when `ps` can't tell us more. Outside EPERM (pid signalable as ours but query failed), stay conservative: running.
- **Kill-stage failure keeps the pidfile and gains `stop --force`** (q4=a): if the actual SIGTERM still fails (probe raced, unforeseen mismatch), do NOT auto-delete the pidfile; the error message explains the pid may have been recycled and points to the new `chorus daemon stop --force`, which clears the pidfile unconditionally.
- **Unit tests** cover: EPERM + identity mismatch ⇒ stale (auto-clean), EPERM + identity match ⇒ running, legacy plain-number pidfile fallback, JSON round-trip, and `stop --force`.

## Capabilities

- `daemon-background-lifecycle` (MODIFIED): the liveness/staleness contract becomes identity-aware; `stop` gains `--force`; the pidfile format becomes JSON with legacy compatibility.

## Impact

- **Code**: `cli/daemon-lifecycle.mjs` (probe, pidfile read/write, stopDaemon), `cli/client-args.mjs` (`--force` flag + help text), `cli/daemon.mjs` (pass force through `handleLifecycleAction`), tests in `cli/__tests__/`.
- **No server/DB/API changes.** Pure CLI-side fix; cross-platform (linux/macOS/Windows), pure JS, no native bindings, no `shell:true`.
- **Compatibility**: old daemon (plain-number pidfile) + new CLI self-heals via the cmdline fallback; new pidfile JSON is only read by the new CLI (external tools reading `daemon.pid` as a number would need the `pid` field instead — acceptable, the file is private to Chorus).
