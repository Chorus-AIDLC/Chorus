# Tasks

## 1. CLI flag + unit generator

- [ ] 1.1 Parse `--yes` / `-y` into `flags.yes` in `cli/client-args.mjs`; document it in `daemonHelpText` SERVICE section and `chorus.mjs` help.
- [ ] 1.2 Drop `--cwd` emission from `buildServiceArgs` (keep `--agent` / `--chorus-only`); update `renderSystemdUnit` / `renderLaunchdPlist` and their tests/scenarios accordingly.

## 2. Install config phase

- [ ] 2.1 Add `resolveInstallCredentials` (pure, injected env/readJson/prompt/validate/writeConfig): resolve → (TTY prompt when unresolved & not skip) → always validate → persist to daemon.json → abort non-zero on failure/none.
- [ ] 2.2 Add `resolveInstallCwds` (pure, injected): configured-detection, TTY wizard (pre-seed cwd, blank-terminated loop, normalize+de-dup), persist to daemon.json `cwds`, skip/non-TTY fallback to default.
- [ ] 2.3 Call both at the top of `handleLifecycleAction`'s `install` branch before `installService`; thread `isTTY` + `flags.yes`.

## 3. Tests + verification

- [ ] 3.1 Unit tests: credential resolve/persist/validate/abort branches; cwd wizard loop/blank/pre-seed/skip-when-configured; `--yes` + non-TTY behavior; unit carries no `--cwd`.
- [ ] 3.2 Integration checkpoint: end-to-end `install` in an isolated env (temporary `SERVICE_NAME` or container) — verify a clean-env boot service authenticates from persisted daemon.json and serves the configured cwds; verify abort paths write no unit.
