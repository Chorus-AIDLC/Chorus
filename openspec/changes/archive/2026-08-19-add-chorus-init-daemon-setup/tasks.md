# Tasks: chorus init daemon-setup + real cross-platform auto-start

## 1. Platform auto-start capability classifier
- [ ] Add `autostartCapability(io)` → `systemd` | `launchd` | `unsupported` in `cli/daemon-service.mjs`
- [ ] Extend `detectSupervisor(io)` to recognize a loaded `com.chorus.daemon` LaunchAgent on darwin
- [ ] Unit tests for both across linux (with/without systemctl), darwin, win32

## 2. Real macOS launchd install / uninstall
- [ ] `installService` darwin: write plist to `~/Library/LaunchAgents/` (backup-first) + `launchctl load -w`; failure → non-zero
- [ ] `uninstallService` darwin: `launchctl unload -w` + remove plist; report nothing-to-remove
- [ ] Keep Windows/other as printed template; credentials never in the plist
- [ ] Unit tests with injected darwin io (exact launchctl argv + plist write)

## 3. launchd lifecycle delegation
- [ ] `cli/daemon.mjs`: status/stop/restart/logs delegate to `launchctl` when `detectSupervisor` reports launchd
- [ ] Pidfile path unchanged when no agent installed
- [ ] Unit tests for darwin delegation argv

## 4. `chorus init` daemon-setup step
- [ ] New `cli/init/steps/daemon-setup.mjs` (id `daemon-setup`, order 30, scope once)
- [ ] Full preflight reuse (cwds + backend), capability gate, opt-in TTY prompt (default No)
- [ ] Non-TTY: install only with `--daemon-autostart`, else daemon.json-only
- [ ] boot_and_now delegate to installService; idempotent report/skip/repair; connection-only (no provider secrets)
- [ ] Register in `cli/init/registry.mjs`; add `--daemon-autostart` to `cli/init-args.mjs` + help
- [ ] Unit tests (injected io, fake installService/capability/preflight)

## 5. Docs
- [ ] `chorus init --help` text lists `--daemon-autostart`
- [ ] chorus skill docs (public/skill + public/chorus-plugin) describe the daemon-setup step, auto-start, credential boundary, provider-cred operator note
- [ ] Note the clean-env provider-credential limitation + concrete systemd/launchd guidance
