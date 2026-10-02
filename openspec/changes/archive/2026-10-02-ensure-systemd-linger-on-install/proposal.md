# Ensure systemd user lingering when installing the daemon on Linux

## Why

On Linux, `chorus daemon install` and the daemon-setup step of `chorus agents add`
install a `systemd --user` unit (`~/.config/systemd/user/chorus-daemon.service`,
`WantedBy=default.target`) that is owned by the per-user manager `user@<uid>.service`.
When the user's lingering is off (`loginctl show-user "$USER" -p Linger` → `no`, the
default on most distros), logind stops the whole user manager ~10 s after the last
session ends, which stops the daemon with it; the daemon also does not start at boot
until somebody logs in. On an EC2 host the journal shows every SSH logout followed by
`Stopping user@1000.service` → `Stopping chorus-daemon.service`, and the daemon only
comes back at the next SSH login. `Restart=on-failure` cannot help — the stop is a clean
SIGTERM of the entire user manager.

Today the CLI only prints one easily-missed line
(`to keep it running after you log out: loginctl enable-linger "$USER"`) after a
successful `daemon install`, prints nothing at all from `chorus agents add`, and
`chorus daemon status` never warns. Almost every new server/cloud-host user hits this.

## What Changes

- **New shared helper in `cli/daemon-service.mjs`**: `lingerStatus()` reads
  `loginctl show-user <user> -p Linger --value`, and `ensureLinger()` runs
  `loginctl enable-linger <user>` when lingering is off. Both use injected IO, never
  throw, and never use `shell:true`.
- **`installService()` (Linux) ensures lingering** after a successful
  write → `daemon-reload` → `enable --now`, unless the caller opts out. The result is
  returned as `linger` on the install result. A linger failure **never** fails the
  install (`installed` stays `true`, exit 0).
- **`chorus daemon install`** prints a one-line success note when it turned lingering
  on, or a prominent warning plus the exact `sudo loginctl enable-linger <user>`
  command when it could not. It replaces the old unconditional hint line. A new
  `--no-linger` flag skips the step.
- **`chorus agents add`** (daemon-setup step) gets the same behavior on a fresh install
  through the shared `installService()`. It also runs the same idempotent linger check
  on its "already configured for auto-start (systemd)" SKIPPED path, so re-running
  `chorus agents add` fixes existing installs without rewriting the unit. It accepts
  `--no-linger` too.
- **`chorus daemon status`** (systemd-managed) shows the linger state and prints a
  warning plus the fix command when it is `no`.
- **`chorus daemon uninstall` does NOT disable lingering.** Lingering is a user-wide
  setting that other user services may rely on.
- Docs (`docs/DAEMON.md`) and the `daemon-background-lifecycle` spec record linger as
  part of the Linux install contract.

Out of scope: macOS launchd (LaunchAgents are unaffected), Windows, and daemon
start-up log warnings.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `daemon-background-lifecycle`: adds the requirement "Linux install ensures systemd
  user lingering".

## Impact

- Code: `cli/daemon-service.mjs`, `cli/daemon.mjs` (install / status output),
  `cli/client-args.mjs` (`--no-linger` + help), `cli/init-args.mjs` (`--no-linger` +
  help), `cli/init/steps/daemon-setup.mjs`.
- Tests: `cli/__tests__/daemon-service.test.mjs`, `cli/__tests__/init-daemon-setup.test.mjs`,
  arg-parser tests — all `loginctl` calls mocked through injected IO.
- Docs: `docs/DAEMON.md`.
- No server, schema, or UI change. No new dependency.
