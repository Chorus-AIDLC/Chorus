# Technical Design: ensure systemd user lingering on Linux daemon install

## Context

- `cli/daemon-service.mjs` is the single install/detect seam that both
  `chorus daemon install` (`cli/daemon.mjs`) and the `chorus agents add` daemon-setup
  step (`cli/init/steps/daemon-setup.mjs`) call. Every external command goes through
  an injected `io.spawnSync`, so it can be unit-tested with fakes.
- `installService()` on Linux runs: write unit → `systemctl --user daemon-reload` →
  `enable --now` → best-effort `restart`. It has no linger handling.
- `daemon-setup.mjs` short-circuits with `SKIPPED` ("already configured for
  auto-start") when `detectSupervisor()` reports an installed unit, so it never calls
  `installService()` for existing installs.

## Decisions (from elaboration rounds 1–2)

| # | Decision |
|---|----------|
| D1 | Auto-run `loginctl enable-linger` without prompting; `--no-linger` opts out. |
| D2 | A linger failure never fails the install: warn and print the `sudo` command. |
| D3 | `uninstall` leaves lingering alone. |
| D4 | `daemon status` shows the linger state and warns when it is off; `chorus agents add` reuses the install logic. No start-up log warning. |
| D5 | One shared helper in `daemon-service.mjs`, called from `installService()`. |
| D6 | The `agents add` SKIPPED (already installed, systemd) path also runs the idempotent linger check. |

## Helper API (`cli/daemon-service.mjs`)

```js
/** Resolve the login name for loginctl. Prefer os.userInfo().username, then $USER / $LOGNAME. */
export function currentUserName(io = defaultIO()): string | null

/**
 * `loginctl show-user <user> -p Linger --value` → "yes" | "no" | "unknown".
 * "unknown" covers: loginctl missing (spawn error / ENOENT), non-zero exit
 * (no logind, e.g. containers), unparseable output, or no resolvable user.
 */
export function lingerStatus(io = defaultIO()): { state: "yes"|"no"|"unknown", user: string|null, error?: string }

/**
 * Idempotently ensure lingering. Never throws.
 *   - state "yes"                       → { result: "already", user }
 *   - state "no"  + enable-linger rc 0  → { result: "enabled", user }
 *   - state "no"  + enable-linger fails → { result: "failed", user, error, fix }
 *   - state "unknown"                   → { result: "unavailable", user, error, fix }
 * `fix` is the copy-pasteable `sudo loginctl enable-linger <user>` command.
 */
export function ensureLinger(io = defaultIO()): LingerOutcome

/** Pure: map a LingerOutcome (or "skipped") to log lines [{ level: "info"|"warn", text }]. */
export function lingerMessages(outcome): Array<{ level, text }>
```

- The user is passed as an explicit argument (no `$USER` shell expansion — there is no
  shell). `io.userInfo` is added to `defaultIO()` so tests can stub it.
- `spawnSync("loginctl", [...], { encoding: "utf8" })` follows the existing
  `systemctlUser` / `launchctl` wrapper shape, including surfacing `r.error`.
- On `enable-linger` success there is no follow-up `show-user` call: a 0 exit means
  logind accepted the request. This keeps the step to at most two process spawns.

## `installService(spec, io)` change

After `enable --now` succeeds (and after the best-effort restart), on Linux:

```js
const linger = spec.noLinger ? { result: "skipped" } : ensureLinger(io);
if (linger.result === "enabled") steps.push(`loginctl enable-linger ${linger.user}`);
return { platform: "linux", installed: true, unitPath, unitText, steps, linger };
```

`linger` is only set on the Linux success path. Failure paths stay as they are, because
lingering is not attempted when the unit failed to install.

## CLI surfaces

- **`chorus daemon install`** (`cli/daemon.mjs`): remove the unconditional
  `loginctl enable-linger "$USER"` hint and print `lingerMessages(r.linger)`; warnings
  go to `errLog`, info to `log`. Keep the separate "stop a prior `chorus daemon -d`"
  hint. Exit code is unchanged (0 on install success).
- **`--no-linger`**: parsed in `parseClientFlags` (`out.noLinger = true`) and
  `parseInitFlags`; documented in both help texts. It is passed through as
  `spec.noLinger`.
- **`chorus daemon status`** (systemd branch): after the header line, call
  `lingerStatus()`. Print `linger: yes` when on; when `no`, print a warning that the
  daemon will stop at logout and won't start at boot, plus the fix commands
  (`chorus daemon install` re-run, or `sudo loginctl enable-linger <user>`). When
  `unknown`, print nothing extra. The status exit code is unchanged.
- **`chorus agents add`** (`daemon-setup.mjs`): pass `noLinger: flags.noLinger === true`
  in the install spec and log `lingerMessages(r.linger)` with the
  `[chorus agents add]` prefix. In the step-4 idempotency branch, when
  `sup.kind === "systemd"` and `!flags.noLinger`, call an injectable
  `ctx.ensureLinger ?? defaultEnsureLinger` with `serviceIo`, log its messages, and
  append a short linger note to the SKIPPED detail. The unit is still not rewritten and
  the outcome stays `SKIPPED`.

## Risks / trade-offs

- **polkit denies self-enable** on some hardened distros: handled by D2 (warn + `sudo`
  fix). The install still succeeds.
- **Containers / WSL without logind**: `show-user` fails → `unavailable` → a single
  warning. Those hosts usually also lack `systemctl --user`, so `autostartCapability`
  already returns `unsupported` before we get here.
- **Global side effect**: lingering keeps *all* of the user's services running. That is
  the documented, expected way to run user services headless, and `--no-linger` lets
  users opt out.

## Testing

- `daemon-service.test.mjs`: `lingerStatus` for yes / no / non-zero exit / ENOENT;
  `ensureLinger` for already / enabled / failed / unavailable, asserting the exact argv
  (`["show-user", user, "-p", "Linger", "--value"]`, `["enable-linger", user]`) and no
  shell; `installService` attaches `linger`, honors `noLinger`, and stays
  `installed: true` when lingering fails; `lingerMessages` shape.
- `init-daemon-setup.test.mjs`: the fresh-install path forwards `noLinger` and logs the
  messages; the already-installed systemd path calls `ensureLinger` (and doesn't with
  `--no-linger`) and stays `SKIPPED`; the launchd path doesn't call it.
- Arg parsers: `--no-linger` parsed by both.
