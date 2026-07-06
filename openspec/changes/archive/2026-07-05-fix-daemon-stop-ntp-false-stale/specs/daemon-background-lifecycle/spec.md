# daemon-background-lifecycle delta

## MODIFIED Requirements

### Requirement: Identity-verified pidfile liveness

The CLI SHALL verify process identity, not merely pid existence, when deciding whether the pid recorded in `~/.chorus/daemon.pid` is the running daemon. On a `-d` start the CLI SHALL write the pidfile as JSON carrying the pid plus identity metadata (process start time and a command-line hint), preserving read compatibility with the legacy plain-number format. When the liveness probe finds the pid exists (including when signaling it yields `EPERM`), the CLI SHALL query the occupying process's command line and start time via a single cross-platform, pure-JS subprocess query (POSIX `ps`, Windows PowerShell; no native bindings, no `shell:true`) and compare them against the recorded identity. When the record carries a command-line hint, that comparison SHALL be decided by the hint alone: a live command line containing the hint classifies the process as the running daemon regardless of the recorded start time (process start-time strings are clock-derived — e.g. POSIX `lstart` is recomputed from boot time plus start ticks — so an NTP clock step after spawn legitimately shifts them for the same process), and a live command line not containing the hint classifies the pidfile as stale. Only when the record carries no command-line hint SHALL the recorded start time decide, with a mismatch classifying the pidfile as stale. For a legacy pidfile with no recorded identity, the CLI SHALL fall back to checking that the live command line contains the chorus daemon marker, classifying it stale otherwise; when the probe on a legacy pidfile yields `EPERM` and the identity query fails, the CLI SHALL classify it stale (EPERM already proves the process belongs to another user, and the CLI and daemon always run as the same user). When a POSIX `ps` rejects the start-time column (e.g. busybox), the CLI SHALL retry with a command-line-only query so cmdline verification still functions. In all other query-failure cases (an identity-carrying pidfile, or a pid the CLI can signal) the CLI SHALL retain the prior conservative behavior (the pid counts as running) so an unverifiable live daemon is never misclassified. The identity check SHALL live in the shared liveness probe so `start -d`, `status`, `stop`, and `restart` all use the same verdict.

#### Scenario: Clock step after spawn does not misclassify a live daemon as stale

- **WHEN** the pidfile records a command-line hint and a start time, the recorded pid is the still-running chorus daemon whose command line contains the hint, but the queried start-time string differs because the system clock was stepped (e.g. boot-time NTP correction) after the daemon spawned
- **THEN** the probe reports running — `stop` signals the daemon and removes the pidfile only after a successful signal, and never clears the pidfile of the live daemon as stale

#### Scenario: Command-line hint mismatch is stale regardless of start time

- **WHEN** the pidfile records a command-line hint and the occupying process's command line does not contain it, even if the queried start-time string equals the recorded one
- **THEN** the pidfile is classified stale

#### Scenario: Start time still decides when no command-line hint was recorded

- **WHEN** the pidfile records a start time but no command-line hint, and the occupying process's queried start-time string differs from the recorded one
- **THEN** the pidfile is classified stale

#### Scenario: Reboot-recycled pid is classified stale, not running

- **WHEN** `~/.chorus/daemon.pid` records identity metadata for a daemon that died at reboot, the pid has been recycled to another user's process (probe yields EPERM), and the user runs any lifecycle command
- **THEN** the identity comparison fails, the pidfile is treated as stale — `stop` clears it and reports the stale cleanup, `status` reports not running, and `-d` starts a fresh daemon instead of refusing

#### Scenario: Live daemon still matches its recorded identity

- **WHEN** the recorded pid is the still-running chorus daemon whose command line contains the recorded hint
- **THEN** the probe reports running and lifecycle commands behave as for a live daemon (stop signals it, `-d` refuses to double-start)

#### Scenario: Legacy plain-number pidfile self-heals via cmdline fallback

- **WHEN** the pidfile contains only a bare pid written by an older CLI and the occupying process's command line does not contain the chorus daemon marker
- **THEN** the pidfile is classified stale and cleaned up, without requiring identity metadata to have been recorded

#### Scenario: Unverifiable identity on an identity-carrying pidfile keeps conservative behavior

- **WHEN** the pidfile carries recorded identity metadata but the identity query fails (e.g. `ps` unavailable or unparsable output)
- **THEN** the CLI treats the daemon as running — it never auto-cleans an identity-carrying pidfile it could not verify

#### Scenario: Legacy pidfile with EPERM self-heals even when the query fails

- **WHEN** the pidfile is legacy (no identity metadata), signaling its pid yields EPERM, and the identity query fails (e.g. minimal busybox `ps`)
- **THEN** the CLI classifies the pidfile stale and self-heals — the original stuck state does not survive on systems with a minimal `ps`
