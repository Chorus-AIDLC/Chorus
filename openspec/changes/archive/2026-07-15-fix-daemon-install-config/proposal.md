# Fix `chorus daemon install`: persist credentials for the boot service + interactive multi-cwd setup

## Why

`chorus daemon install` sets up a boot-autostart service (a `systemd --user` unit on Linux; a launchd LaunchAgent template on macOS), but the installed service starts in a **clean environment** that does not inherit the operator's shell-exported `CHORUS_URL` / `CHORUS_API_KEY`. The generated unit only captures `HOME` + `PATH` (`renderSystemdUnit` in `cli/daemon-service.mjs`). The install path also short-circuits into `handleLifecycleAction`'s `install` branch **before** the interactive `preflight` credential-completion the normal `chorus daemon` run performs (`cli/daemon.mjs`: `if (action !== "run") return handleLifecycleAction(...)` returns before `preflight`). So install never ensures credentials live in a source the clean boot env can read.

Result: for an operator who only `export`s the two env vars and never ran `chorus login`, the installed service boots, resolves no credentials, and — being non-TTY — hard-errors and restart-loops (`Restart=on-failure`), even though the vars are set in their interactive shell.

**Live-verified on the daemon host** (systemd `--user` `chorus-daemon.service`): `systemctl --user cat` shows the unit carries only `Environment=HOME` + `Environment=PATH`; the running daemon's `/proc/<MainPID>/environ` contains no `CHORUS_*`. The host's own daemon is healthy only because `~/.chorus/daemon.json` already holds `url`+`apiKey` from a prior `chorus login` (credential tier 3). The bug is therefore **conditional**: it bites the "env-vars-only, never-logged-in" operator, exactly the person `install` should serve.

Separately, the operator asked for **interactive cwd configuration** at install time — declare one or more working directories the daemon serves, and be able to add multiple. The multi-cwd engine already exists (repeatable `--cwd`, `CHORUS_DAEMON_CWDS`, `cwds:[…]` in `daemon.json`, `resolveDaemonCwds` in `cli/daemon-config.mjs`); this change wires an interactive wizard into `install` and persists the configured set.

## What Changes

- **Credential preflight at install.** Before writing the service unit, `install` resolves credentials via the existing layered resolver (flags > env > `daemon.json` > plugin). If they resolve from **any** source, it persists them into `~/.chorus/daemon.json` (0600, via the existing field-merge writer) so the clean boot env can read them. If nothing resolves, it prompts login-style on a TTY (masked key); it always validates the key against the server and **aborts the install** on failure or when credentials cannot be obtained — never writing a unit that would crash-loop at boot.
- **Interactive multi-cwd wizard.** When no cwd is configured (no `--cwd` flag, no `cwds` in `daemon.json`), `install` runs a repeated "add a working directory (blank to finish)" prompt loop, pre-seeding the current directory as the suggested first entry, and persists the resulting set to `daemon.json` `cwds` — the single source of truth. The generated unit carries **no** `--cwd` (so a plain `chorus daemon` and the boot service read the same paths).
- **Non-interactive skip flag.** A new `--yes` / `-y` flag (and any non-TTY context) suppresses all prompts. In that mode install still resolves + persists credentials and still validates the key, but aborts if nothing resolves — so an unattended install never produces a broken boot service.
- **All platforms.** The credential-persist + cwd config runs on macOS/Windows too (the clean-env problem hits launchd), and the printed launchd template stops relying on inherited env.

## Capabilities

- **daemon-background-lifecycle** — MODIFIED: the `install` requirement now performs credential preflight/persist + interactive cwd config and stops baking `--cwd` into the unit. ADDED: install credential guarantee, interactive multi-cwd config, and the `--yes`/`-y` non-interactive skip mode.

## Impact

- `cli/daemon.mjs` — `handleLifecycleAction` `install` branch: add credential resolve/persist/validate + cwd wizard before `installService`.
- `cli/daemon-service.mjs` — `buildServiceArgs` / `renderSystemdUnit` / `renderLaunchdPlist`: stop emitting `--cwd` in the unit (cwds now come from `daemon.json`).
- `cli/client-args.mjs` — parse `--yes` / `-y`; document it in `daemonHelpText`.
- `cli/login.mjs` / `cli/credentials.mjs` — reuse `updateDaemonConfig`, `resolveCredentials`, `validateAndFetchIdentity`; no new persistence primitive.
- `cli/daemon-config.mjs` — reuse `resolveDaemonCwds`; persist the wizard result via the merge writer.
- Tests: unit coverage for the install preflight (resolve/persist/validate/abort branches), the cwd wizard (loop, blank-terminates, pre-seed, skip-when-configured), and skip-flag/non-TTY behavior.
- Docs: `chorus.mjs` help text + `cli/client-args.mjs` `daemonHelpText` SERVICE section.
- No schema, API, or DB changes. No new dependency.
