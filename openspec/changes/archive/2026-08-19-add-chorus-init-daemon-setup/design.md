# Technical Design: `chorus init` daemon-setup + real cross-platform auto-start

## Overview

Two coupled pieces:

1. A new **`once`-scoped init step** (`cli/init/steps/daemon-setup.mjs`) that wires
   `chorus init` to the existing `daemon install` machinery, behind an opt-in
   auto-start prompt and a platform capability gate.
2. Upgrading `cli/daemon-service.mjs` so `installService` / `uninstallService`
   perform a **real** macOS launchd install (today macOS only prints a template),
   plus a platform capability classifier and launchd-aware supervisor detection,
   plus launchctl delegation for the lifecycle verbs in `cli/daemon.mjs`.

Everything reuses the already-tested, dependency-injected modules; nothing here
adds a dependency or uses `shell:true`.

## Existing seams this builds on (verified)

- **Init step contract** (`cli/init/contracts.mjs`): `InitStep = { id, order, scope, run(ctx) }`, `scope ∈ {once, per-agent}`. The orchestrator (`cli/init.mjs`) owns per-agent iteration and passes `ctx = { selection, flags, io, env, backup, agentId?, adapter? }`. Steps today: `credential-seed` (order 10, once), `plugin-install` (order 20, per-agent). The registry (`cli/init/registry.mjs`) reserves the daemon-setup slot for this change.
- **Install preflight** (`cli/daemon-install-config.mjs`): `resolveInstallCredentials`, `resolveInstallCwds`, `resolveInstallBrowseRoots`, `resolveInstallAgent` — each resolves via the layered resolver and persists into `~/.chorus/daemon.json` with the owner-only field-merge writer. `chorus daemon install` (dispatch in `cli/daemon.mjs`) calls them before `installService`.
- **Service install** (`cli/daemon-service.mjs`): `installService(spec, io)` branches on `io.platform`. Linux = real `systemd --user` (write unit, `daemon-reload`, `enable --now`, `restart`). macOS = `renderLaunchdPlist(spec)` returned as a printed template only (`launchdPlistPath` = `~/Library/LaunchAgents/com.chorus.daemon.plist`). Windows/other = printed foreground command. `detectSupervisor(io)` returns a systemd verdict on Linux, `{ kind: "none" }` everywhere else. All IO is injectable (`io.spawnSync`, `io.platform`, `io.home`, `io.writeFileSync`, `io.existsSync`, `io.rmSync`).

## Module contracts

### 1. Platform auto-start capability classifier (`cli/daemon-service.mjs`)

```
autostartCapability(io = defaultIO()) -> "systemd" | "launchd" | "unsupported"
```

- `linux` + `systemctl --user` resolvable → `"systemd"`.
- `darwin` → `"launchd"` (launchctl is always present on macOS).
- anything else (`win32`, unknown) → `"unsupported"`.

`detectSupervisor(io)` is extended: on `darwin`, if the LaunchAgent plist exists
and `launchctl list` reports the label loaded, return
`{ kind: "launchd", installed: true, active: <bool>, label }`; else `{ kind: "none" }`.
The Linux systemd branch is unchanged. The classifier is the single source of the
"is auto-start real here?" answer used by both the init step and install.

### 2. Real macOS launchd install / uninstall (`cli/daemon-service.mjs`)

`installService(spec, io)` on `darwin`:
1. Render the plist (`renderLaunchdPlist`, already exists — foreground, `RunAtLoad`
   + `KeepAlive`, no `-d`, no `--cwd`).
2. Ensure `~/Library/LaunchAgents/` exists; write the plist to
   `launchdPlistPath(io)` (back up an existing file first, mirroring the
   backup-before-overwrite convention).
3. `launchctl unload <plist>` (best-effort, ignore failure) then
   `launchctl load -w <plist>` to (re)load and enable at login.
4. On any `launchctl load -w` non-zero exit, return
   `{ platform: "darwin", installed: false, error }` — the caller reports and exits
   non-zero. No silent success.

`uninstallService(io)` on `darwin`: `launchctl unload -w <plist>`, remove the plist
file, report "nothing to remove" when absent. Windows/other unchanged (template).
Credentials are still never baked into the plist — `daemon.json` (0600) is the
persistence surface, identical to the systemd guarantee.

### 3. launchd lifecycle delegation (`cli/daemon.mjs`)

The lifecycle verbs already delegate to `systemctl --user` when
`detectSupervisor` reports a Linux supervisor. Generalize the branch: when
`detectSupervisor` reports `kind: "launchd"`, delegate to `launchctl`:

- `status` → `launchctl list <label>` (exit non-zero when installed-but-not-loaded).
- `stop` → `launchctl unload <plist>` (note it re-loads at next login unless
  uninstalled) — consistent with the "stop leaves it enabled" systemd wording.
- `restart` → `launchctl unload <plist>` then `launchctl load <plist>`.
- `logs` → tail `~/.chorus/daemon.log` (the plist already routes stdout/stderr
  there via `renderLaunchdPlist`).

The pidfile path is unchanged when no supervisor is detected.

### 4. `chorus init` daemon-setup step (`cli/init/steps/daemon-setup.mjs`)

```
daemonSetupStep = { id: "daemon-setup", order: 30, scope: "once", run: setupDaemon }
```

"Non-interactive" below means **non-TTY OR `--yes`** — a `--yes` run in a TTY is
treated as non-interactive for the auto-start decision (consistent with how
`daemon install --yes` suppresses prompts), so it never blocks on a prompt.

`setupDaemon(ctx)` flow:
1. **Full preflight (decision: full_preflight).** Reuse the `resolveInstall*`
   persisters: this resolves/persists the **served cwd set** and the **default
   backend agent** into `daemon.json` (interactive wizard in a TTY,
   flags/existing/default otherwise — exactly as `daemon install` does today).
   Credential model stays connection-only: no provider secrets collected.
2. **Capability gate.** `cap = autostartCapability(io)`.
   - `unsupported` → do NOT offer auto-start. Report the daemon config is written
     and print the manual start command (`chorus daemon`), then return a
     `skipped (autostart unsupported on <platform>)` outcome.
3. **Decide whether to install.**
   - **Interactive (TTY, not `--yes`):** prompt `Install & enable the Chorus daemon
     to auto-start on boot? [y/N]`, **default No** (decision: default_off). Install
     only on an affirmative answer.
   - **Non-interactive (non-TTY or `--yes`) (decision: explicit_flag):** install
     only when `flags.daemonAutostart` is set; otherwise return
     `skipped (daemon.json written; pass --daemon-autostart to install boot service)`.
4. **Idempotency short-circuit (decision: report_skip_repair).** Consult
   `detectSupervisor(io)` **before** the credential gate. If a service is already
   installed for this platform **and no drift is detected**, report
   `skipped (already configured — autostart)` and return immediately — do NOT run
   the credential validate-or-abort gate or rewrite anything. This ordering matters:
   an already-installed, healthy re-run must not fail merely because the server is
   momentarily unreachable at re-run time. Only when the service is absent, or a
   drift is detected (missing unit but recorded, or credential/path mismatch), does
   the step proceed to install/repair (steps 5–6).
5. **Credential validate-or-abort gate (never install a service that fails at
   boot).** Reached only when the step is actually going to install or repair. It
   MUST guarantee the boot service can authenticate from the clean-env source
   before writing any unit/plist — reusing the same `resolveInstallCredentials`
   guarantee that standalone `daemon install` runs (layered resolve →
   **server-validate the key** → persist url+key+identity into `daemon.json`; abort
   non-zero if creds cannot be resolved or the key fails validation). This does NOT
   rely on the earlier `credential-seed` step, whose SKIPPED path only checks that
   creds *resolve* locally (no server validation) and whose FAILED outcome does not
   stop `runInit`. If the guarantee cannot be met the step returns `failed` and
   installs nothing — matching "Install guarantees resolvable credentials for the
   clean-env boot service" in daemon-background-lifecycle.
6. **Install (decision: boot_and_now).** Delegate to the existing `installService`
   (Linux systemd `enable --now` + linger hint; macOS `launchctl load -w`). Return
   `installed` / `repaired` / `failed` with the underlying detail; a failed install
   is a visible non-zero outcome, never a silent skip.

> **Reuse, don't reimplement:** steps 1 and 5 delegate to the existing
> `daemon-install-config.mjs` resolvers (`resolveInstallCredentials`,
> `resolveInstallCwds`, `resolveInstallAgent`) so the init path and standalone
> `daemon install` share one credential/cwd/agent guarantee and cannot diverge.

The step takes its collaborators (`autostartCapability`, `detectSupervisor`,
`installService`, the `resolveInstall*` persisters, prompt `io.ask`) via the same
injection pattern as the other steps, so it unit-tests with fakes and an injected
`io.platform`.

### 5. `--daemon-autostart` flag (`cli/init-args.mjs`)

Add `--daemon-autostart` (boolean) to the parser and help text: "In a
non-interactive run, install & enable the daemon boot service (Linux systemd /
macOS launchd); ignored where auto-start is unsupported." In an interactive TTY run
the prompt governs; the flag is the opt-in for non-interactive runs (non-TTY or
`--yes`) — decision: explicit_flag.

## Credential boundary & the clean-env limitation (owner decision: connection_only)

`daemon.json` holds only the Chorus URL + API key. A boot-launched daemon
(systemd `--user` or launchd LaunchAgent) starts in a **clean environment** that
does not inherit the operator's shell-exported provider secrets, and — per this
decision — the service unit injects only `HOME`/`PATH`, not `AWS_*` / `ANTHROPIC_*`
/ Bedrock. Consequence: agents the boot daemon spawns will only reach a model
provider if those provider credentials are present in the service's environment by
some other means.

This is an accepted limitation, not a bug. The daemon-setup step and the docs
SHALL make it explicit and give concrete operator guidance, e.g.:

- **systemd (Linux):** add a drop-in
  `~/.config/systemd/user/chorus-daemon.service.d/env.conf` with
  `[Service]\nEnvironment=ANTHROPIC_API_KEY=...`, or
  `systemctl --user set-environment`, or a `~/.config/environment.d/*.conf` file.
- **launchd (macOS):** `launchctl setenv` / a `EnvironmentVariables` dict in the
  plist maintained by the operator.

A future sibling (the `env`-block credential model we deferred) can automate this;
this change only documents the manual path.

## Testing strategy

All paths are exercised by unit tests with an injected `io` (`io.platform`,
`io.spawnSync`, `io.home`, fs shims), matching `cli/__tests__/daemon-service.test.mjs`
and the init step tests. Because CI/this host is Linux, the macOS launchd paths are
validated by setting `io.platform = "darwin"` and asserting the exact `launchctl`
argv and plist write — not by running a real macOS service. Coverage:

- `autostartCapability` → systemd / launchd / unsupported per platform.
- `detectSupervisor` recognizes a loaded launchd LaunchAgent on darwin.
- `installService` darwin: writes plist + `launchctl load -w`; failure → non-zero;
  `uninstallService` darwin: unload + remove; Windows unchanged.
- launchd lifecycle delegation: status/stop/restart/logs argv on darwin.
- daemon-setup step: TTY prompt defaults No; `--daemon-autostart` drives
  non-interactive (non-TTY or `--yes`) install; unsupported platform →
  daemon.json written + manual steps, no service; already-installed → skip;
  delegates to `installService`; never collects provider secrets; full preflight
  persists cwds + agent; **credential validate-or-abort** — a run that decides to
  install but whose key fails server validation installs nothing and returns
  `failed`.
- **Integration checkpoint (not fakes):** one end-to-end test drives the real
  `runInit` → `daemon-setup` → real `installService` with `io.platform="linux"` and
  a fake `spawnSync`, asserting a coherent `systemd` unit is rendered, `daemon.json`
  carries the resolved creds + cwds + agent, and `enable --now` is invoked — so the
  modules compose, not just pass in isolation.

## Risks

- **Whole-block MODIFIED of "Supervisor service install / uninstall":** the spec
  delta overwrites the entire requirement — every scenario (including the
  unchanged systemd ones) is re-stated with the macOS behavior flipped from
  "template" to "real install". Reviewed for completeness.
- **launchctl API drift across macOS versions** (`load -w` vs the newer
  `bootstrap`/`enable`). We use the legacy `launchctl load -w`/`unload -w` verbs
  the existing template already documents, for consistency; a future change can
  modernize to `launchctl bootstrap gui/$UID`.
- **No macOS in CI:** launchd behavior is only unit-verified with fakes; a live
  macOS smoke test is a manual follow-up flagged for a human on a Mac.

## design.pen

Not applicable — `chorus init` is a CLI flow with no web/mobile screen. No `.pen`
document change.
