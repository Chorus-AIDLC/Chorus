# Tasks

## 1. Shared merge helper + route all writers through it
- [ ] 1.1 Add `updateDaemonConfig(partial, deps?)` — read→shallow-merge→atomic write(0600), defensive parse of a missing/corrupt file as `{}`
- [ ] 1.2 Make `writeLoginFile(data)` a thin wrapper over `updateDaemonConfig(data)`; keep its `deps` seams
- [ ] 1.3 Rewrite `recordYoloAck(ts)` to call `updateDaemonConfig({ yoloAckAt: ts })`
- [ ] 1.4 Rewrite the misleading `login.mjs` JSDoc to state the merge-preserve contract (no more "omits yoloAckAt")
- [ ] 1.5 Unit tests: preserve unrelated keys, partial overwrites, missing file, malformed file, mode 0600, atomic temp+rename

## 2. login + daemon completion preserve all fields (the regression fix)
- [ ] 2.1 Verify `chorus login` now preserves pre-existing `cwds` AND `yoloAckAt` (q1 preserve-always)
- [ ] 2.2 Verify daemon `preflight()` TTY credential-completion path preserves `cwds`/`yoloAckAt` (q2 = both sites)
- [ ] 2.3 Regression tests in `login.test.mjs` + `daemon-credential-completion.test.mjs`

## 3. Loud `claude` NOT FOUND startup warning (q6 loud-stderr)
- [ ] 3.1 Emit one `⚠` stderr line at startup when `resolveClaudePath()` is null; keep banner row; stay non-fatal
- [ ] 3.2 Tests: warning emitted iff claude absent; daemon still subscribes

## 4. Onboarding documentation (q5 fold-in)
- [ ] 4.1 `docs/DAEMON.md`: "Running on boot (systemd)" — creds must be persisted via `chorus login`; field-merge guarantee; PATH must include claude dir

## 5. Spec sync + plugin audit record (q4)
- [ ] 5.1 daemon-permission-mode spec: REMOVE "Credential change clears the YOLO acknowledgement" (done in this change's delta)
- [ ] 5.2 Record plugin state.json audit (flock+jq-merge safe; Codex stateless) in design — no code change

## 6. Verify
- [ ] 6.1 `pnpm test` (cli suite) + `npx tsc --noEmit` + `openspec validate fix-daemon-config-field-merge --strict`
