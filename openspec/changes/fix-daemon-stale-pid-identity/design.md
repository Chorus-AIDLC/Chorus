# Technical Design: identity-verified daemon pidfile liveness

## Overview

Replace the bare `kill(pid, 0)` liveness probe in `cli/daemon-lifecycle.mjs` with an **identity-verified probe**: the pidfile records who the daemon is (start time + cmdline hint), and the probe checks that the process currently occupying that pid still matches. A recycled pid (the reboot scenario, surfacing as EPERM for another user's process) fails the identity check and is treated as **stale** — which the existing stale path already knows how to self-heal (clean pidfile, allow start).

Everything stays in the CLI: pure Node, no native bindings, no `shell:true`, injectable IO for tests — the established conventions of `daemon-lifecycle.mjs`.

## Architecture

### Current state (broken)

```
readPid() → number | null
processAlive(pid) → kill(pid,0); EPERM ⇒ true   ← misjudges recycled pids
isRunning() → { running, pid, stale }
stopDaemon() → running ⇒ SIGTERM; error path keeps pidfile ← no self-heal
startBackground() → running ⇒ refuse             ← phantom daemon blocks start
```

### Target state

```
readPidRecord() → { pid, startedAt?, argsHint?, legacy } | null
queryProcessIdentity(pid, io) → { cmdline, startedAt } | null   (one subprocess query)
processAlive(record, io) →
   kill(pid,0) OK or EPERM   ⇒ pid exists → verify identity:
     record has identity     → compare startedAt + cmdline; mismatch ⇒ NOT alive (stale)
     legacy record (no id)   → cmdline contains daemon marker? alive : stale
     identity query failed   → identity record ⇒ conservative alive;
                               legacy + EPERM ⇒ stale (q3=a self-heal);
                               legacy + OK    ⇒ conservative alive
   ESRCH                     ⇒ not alive (stale)
isRunning() → unchanged shape { running, pid, stale }
stopDaemon({ force }) →
   force                     ⇒ best-effort SIGTERM + unconditional pidfile unlink
   stale (incl. identity mismatch) ⇒ existing "stale-cleared" self-heal path
   SIGTERM fails             ⇒ keep pidfile; error message explains pid recycling
                               and points to `chorus daemon stop --force`
```

`isRunning`'s callers (`startDetached`, `status`, `stop`, `restart`) are untouched in shape — the fix lands entirely inside the shared probe, so all four paths heal together (elaboration q5=a).

## Pidfile format (JSON, same path)

`startBackground` writes `~/.chorus/daemon.pid` as JSON (elaboration q2=a):

```json
{ "pid": 12345, "startedAt": "<ps-reported start time string>", "argsHint": "<daemon entry marker>" }
```

- `startedAt` — captured by querying the just-spawned child's start time via the same `queryProcessIdentity` used at probe time, so the comparison is string-equality of two outputs of the same command (no clock-format normalization). If the post-spawn query fails, write the record without `startedAt` (degrades to cmdline-only verification).
- `argsHint` — a distinguishing substring of the spawned command line (the daemon entry script path + `daemon` token, derived from `spec.args`). Probe-time match is `cmdline.includes(argsHint)`.
- **Legacy compatibility** (q3=a): `readPidRecord` first tries `JSON.parse`; a plain-number body parses via the existing trim/parseInt path into `{ pid, legacy: true }`. Writing always uses the new JSON form. Mode stays `0600`.

## Cross-platform identity query

One injectable `queryProcessIdentity(pid, io)` seam (like the existing `io.kill`), implemented with `spawnSync` and argument arrays (no shell):

- **POSIX (linux/darwin)**: `ps -p <pid> -o lstart=,args=` — one invocation returns start time (second resolution) and full command line. `lstart` is supported by both GNU ps and BSD/macOS ps. **busybox fallback**: minimal `ps` implementations (Alpine/busybox) reject `-o lstart`; on failure retry with `ps -o args= -p <pid>` (busybox-supported) and return `{ cmdline, startedAt: null }` — the probe then verifies by cmdline alone, so identity checking still functions where only start-time is unavailable.
- **Windows**: `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>' | Select-Object CommandLine,CreationDate | ConvertTo-Json"` — `wmic` is deprecated/removed on modern Windows; PowerShell is present on all supported Windows versions.
- Returns `null` on any failure (command missing, non-zero exit, unparsable output) — the probe then degrades conservatively (see below).

A same-second pid-recycle collision defeating `startedAt` equality is astronomically unlikely and is additionally covered by the cmdline check (elaboration q1=c: both checks, single query).

## Probe decision table

| kill(pid,0) | pidfile identity | live identity query | verdict |
|---|---|---|---|
| ESRCH | — | — | stale (existing behavior) |
| OK / EPERM | startedAt + argsHint present | both match | running |
| OK / EPERM | startedAt + argsHint present | either mismatch | **stale** (the bug fix) |
| OK / EPERM | legacy (none) | cmdline contains daemon marker | running |
| OK / EPERM | legacy (none) | query returns cmdline w/o marker | **stale** (q3=a self-heal) |
| EPERM | legacy (none) | query fails (`null`) | **stale** (q3=a: EPERM on a legacy record already proves the process is not ours — the CLI and daemon always run as the same user; self-heal must not depend on `ps` cooperating) |
| OK (not EPERM) | legacy (none) | query fails (`null`) | conservative: running |
| OK / EPERM | startedAt + argsHint present | query fails (`null`) | conservative: running — an identity-recorded pidfile is never auto-cleaned on unverifiable identity; stop's error message covers the escape hatch |
| other error | — | — | stale (unchanged: only EPERM was special-cased) |

The conservative rows preserve today's behavior when verification is impossible for a pid we can signal or a new-format record, so the change can never delete the pidfile of a genuinely live daemon it merely failed to inspect. The one deliberate exception is **legacy + EPERM + query failure ⇒ stale**: that is exactly the human-approved q3=a upgrade contract (old daemon's plain-number pidfile, pid recycled to a foreign process, minimal `ps` such as busybox unable to report identity) — without it the original stuck state would survive on Alpine-class systems.

## `stop --force` (q4=a)

- `parseClientFlags` gains boolean `--force`; `daemonHelpText` documents it under `chorus daemon stop`.
- `handleLifecycleAction("stop")` passes `force` into `lifecycle.stopDaemon({ force })`.
- Semantics: attempt SIGTERM best-effort (ignore failure), then unlink the pidfile unconditionally, report `reason: "forced"`.
- The non-force SIGTERM-failure message becomes: `failed to signal pid <pid>: <err> — the pid may have been recycled by the OS; if you are sure no daemon is running: chorus daemon stop --force`.
- `restart` keeps non-force stop semantics (it should not silently discard a pidfile it couldn't verify).

### Exit codes for stop

`handleLifecycleAction("stop")` currently maps `r.stopped ? 0 : 1`, which makes the `stale-cleared` self-heal exit 1. New contract: **exit 0 for `stopped`, `stale-cleared`, and `forced`** — each leaves the system in the desired state ("no daemon running, no pidfile"), and scripts chaining `chorus daemon stop && …` must not break on a successful self-heal. `not-running` and `error` keep exit 1.

## Module Contracts

- `daemon-lifecycle.mjs` exports keep their names/shapes where consumed: `isRunning() → { running, pid, stale }`, `stopDaemon(opts?) → { stopped, pid, reason, message }` (new `reason: "forced"`), `startBackground(spec)` unchanged signature. `readPid` remains as a thin `readPidRecord().pid` wrapper if anything still imports it.
- All new IO goes through the injectable `io` bundle (`io.spawnSync`, reuse of `io.kill`, `io.platform`) so both platform branches unit-test from one host — same pattern the file already uses.

## Implementation Plan

1. `daemon-lifecycle.mjs`: pidfile JSON read/write + `queryProcessIdentity` + identity-aware `processAlive`/`isRunning` + `stopDaemon` force/message changes + `startBackground` identity capture.
2. `client-args.mjs`: `--force` parsing + help text. `daemon.mjs`: thread `force` through `handleLifecycleAction`.
3. Tests (`cli/__tests__/daemon-lifecycle.test.mjs` + dispatch test): decision-table rows incl. EPERM+mismatch⇒stale, EPERM+match⇒running, legacy fallback both ways, query-failure conservative row, JSON/legacy round-trip, `stop --force`, SIGTERM-failure message content.
4. Skill/README touchpoints that document `chorus daemon stop` gain the `--force` mention (plugin + standalone skill docs are English-only).

## Risks & Mitigations

- **`ps` output format drift across distros** — only `lstart=` and `args=` column output is consumed, both POSIX-standardized enough across GNU/BSD; parser tolerates leading whitespace and treats unparsable output as query failure (conservative rows). busybox/Alpine `ps` lacks `lstart` — covered by the args-only retry fallback (cmdline-only verification) plus the legacy+EPERM⇒stale row, so minimal-`ps` systems still self-heal instead of re-entering the stuck state.
- **PowerShell startup latency (~100-300ms) on Windows lifecycle commands** — acceptable: lifecycle commands are human-invoked one-shots, not a hot path.
- **External tooling parsing `daemon.pid` as a bare number** — the file is Chorus-private (`~/.chorus/`); no in-repo consumer reads it besides `daemon-lifecycle.mjs` (verified by grep). Documented in proposal Impact.
- **Race: daemon exits between probe and SIGTERM** — unchanged from today; ESRCH on the actual kill produces the existing error path, now with the improved message and `--force` guidance.
