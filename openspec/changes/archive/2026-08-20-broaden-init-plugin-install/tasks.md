# Tasks

## 1. dsh interactive npm-plugin installer
- [ ] 1.1 Add `installDsh` + `readDshInstallState` to `cli/init/install-methods.mjs` (`dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`)
- [ ] 1.2 pnpm-on-PATH precheck; mandatory `-w`; interactive profile detect+pick via `ctx.io.ask` with non-TTY fallback
- [ ] 1.3 Remove stale `GUIDED_MESSAGES.dsh`; wire descriptor in `adapters.mjs`
- [ ] 1.4 Unit tests (faked `ctx.run` / `ctx.io.ask`), VERIFIED note vs real dsh CLI

## 2. openclaw npm-plugin installer
- [ ] 2.1 Add `installOpenclaw` + `readOpenclawInstallState` (install `npm:…` then `enable`, minHostVersion guard)
- [ ] 2.2 Remove `GUIDED_MESSAGES.openclaw`; wire descriptor
- [ ] 2.3 Unit tests incl. host-too-old and installed-but-disabled→repaired

## 3. kiro native file-template install method
- [ ] 3.1 `cli/init/file-template.mjs` — copy `.kiro/` assets, `__CHORUS_BIN__` substitution, merge `settings/mcp.json` (backup, preserve, env-ref key)
- [ ] 3.2 Shared artifact manifest consumed by both this installer and `public/install-kiro.sh`
- [ ] 3.3 Resolve asset source for the published `chorus` npm CLI (bundle vs download) and prove assets resolve at runtime
- [ ] 3.4 `installKiro` + `readKiroInstallState`; remove `GUIDED_MESSAGES.kiro`; wire descriptor; unit tests (temp dirs, cross-platform)

## 4. Daemon classification: offline agentType + per-agent keys + reuse selection
- [ ] 4.1 Add `"offline"` to `daemon-agent.mjs` KNOWN_AGENTS + `agent-backend-prompt.mjs` accepted values; spawner-select never wakes `offline`
- [ ] 4.2 `credential-seed.mjs`: per-selected-agent key capture → `agents[]` with agentType (offline if not wakeable); 0600, never echoed, merge-safe
- [ ] 4.3 `daemon-setup.mjs`: reuse init selection (suppress `resolveInstallAgent` backend menu); capability-gate the auto-start prompt (all-offline skips)
- [ ] 4.4 Tests: init-credential-seed + init-daemon-setup for per-agent keys, offline classification, no-reprompt, all-offline skip

## 5. Integration checkpoint + pi guided correction
- [ ] 5.1 Correct pi guided copy (accurate, non-misleading); scan for stale "not a plugin surface" text
- [ ] 5.2 End-to-end `init-integration.test.mjs`: selection → install + daemon.json across dsh/openclaw/kiro/pi; assert `supported` flips (false for pi), per-agent failure isolation, agentType/offline written, daemon step does not re-prompt
- [ ] 5.3 Cross-check docs (CONNECT_DSH / CONNECT_KIRO / openclaw README) for command parity
