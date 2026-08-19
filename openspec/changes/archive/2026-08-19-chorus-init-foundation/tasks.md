# Tasks

## 1. Command scaffold, contracts, arg parsing & non-interactive surface
- [ ] Add `init` to the `SUBCOMMANDS` router in `chorus.mjs` (lazy-import `cli/init.mjs`)
- [ ] `cli/init-args.mjs`: pure arg parse + help (`--agents`, `--all`, `--yes`, `--url`, `--api-key`, `--help`); non-TTY guard requiring `--agents`/`--all`; unknown-agent hard error
- [ ] `cli/init/contracts.mjs`: `AgentAdapter` + `InitStep` interfaces + shared types (JSDoc)
- [ ] `cli/init.mjs`: dependency-injected `runInit` skeleton (detect → select → ordered steps → summary)
- [ ] `cli/init/select.mjs`: interactive checklist (TTY) + flag-driven selection (non-TTY)
- [ ] Unit tests for arg parsing, non-TTY abort, selection resolution, help

## 2. Agent detection + per-agent adapter registry
- [ ] `cli/init/detect.mjs`: dual-signal probe (PATH binary + config dir), cross-platform
- [ ] `cli/init/registry.mjs`: adapters for Claude Code, Codex, Kiro, opencode, OpenClaw, Pi, dsh (detect + readInstallState + displayName)
- [ ] Verify each agent's real binary name + config dir against its actual layout (not LLM memory)
- [ ] Unit tests: detection with/without binary and dir; registry completeness; undetected-still-selectable

## 3. Plugin-install step (native remote marketplace) + idempotency & backup
- [ ] `cli/init/steps/plugin-install.mjs`: per-agent `installPlugin` via native remote marketplace
- [ ] Claude Code: official `claude plugin marketplace add` + `install chorus@chorus-plugins -y [--config]`; read `installed_plugins.json`/`known_marketplaces.json` for state (read-only)
- [ ] Codex/Kiro/opencode/OpenClaw/Pi/dsh: port each mechanism from `install-*.sh`; verify flags against each real CLI; unsupported-to-verify agents ship a guided message, not a guess
- [ ] Idempotent diff (skip already-installed) + `.chorus-bak` before overwrite + isolate per-agent failures
- [ ] Unit tests: install/repair/skip/failed outcomes; backup on overwrite; failure isolation

## 4. Credential-seed step (collect once → daemon.json)
- [ ] `cli/init/steps/credential-seed.mjs`: collect URL+API key once (flags or prompt), validate key against server (reuse `cli/login.mjs`)
- [ ] Persist to `~/.chorus/daemon.json` via `cli/daemon-config.mjs`/`cli/credentials.mjs`, merge-safe (preserve `yoloAckAt`, `agents[]`, cwd pins); no per-agent secret write
- [ ] Unit tests: once-scope, merge preservation, invalid key rejection, flag vs prompt paths

## 5. Integration: end-to-end wiring, step-registry seam, summary & docs
- [ ] Wire `runInit` to run credential-seed + plugin-install steps against the real registry; ordered step seam siblings can extend
- [ ] Per-agent summary table (installed / repaired / skipped / failed) + "next step" hint (MCP wiring lands in sibling cc115e6b)
- [ ] Docs/help: add `chorus init` to `chorus --help` and a short mention in connect docs (retiring old scripts is sibling ad24116e — not here)
- [ ] Integration test: end-to-end `chorus init --agents <two> --url --api-key --yes` in non-TTY with fakes exercising detect → select → both steps → summary
