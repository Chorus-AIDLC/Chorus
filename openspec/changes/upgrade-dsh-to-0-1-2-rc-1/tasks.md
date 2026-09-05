# Tasks

## 1. Update dsh baseline and version pins
- [ ] Upgrade the installed dsh runtime to `0.1.2-rc.1` and pin the local `deepseek-harness` checkout to tag `dsh-v0.1.2-rc.1` (record versions in evidence).
- [ ] Bump `DSH_RC_VERSION` (`cli/dsh-managed-config.mjs`) to `0.1.2-rc.1` and `packages/chorus-dsh` peer/dev pins from `^0.1.0-rc.7` to `^0.1.2-rc.1`.
- [ ] Verify `packages/chorus-dsh` builds + typechecks against the new peers; confirm the 7 lifecycle events + `agent.steer` still resolve (no source rewrite expected).

## 2. Rewrite daemon dsh launch to the `dsh --profile sdk` model
- [ ] Rewrite `cli/dsh-spawner.mjs` bin resolution + spawn argv to the `dsh --profile sdk [--patch]` model; keep all JSON-RPC / usage / interrupt handling unchanged.
- [ ] Rewrite `cli/dsh-managed-config.mjs` to compose the `sdk` profile (install `@deepseek-ai/dsh` + `@chorus-aidlc/chorus-dsh`, patch overlay); remove dead demo packages + `DSH_CORDIS_CONFIG`; update `validateManagedDshComposition`.
- [ ] Windows bin names + non-default provider adapter row; update/extend focused unit suites; `npx tsc --noEmit` clean for touched files.

## 3. Prove dsh daemon wake via local E2E
- [ ] On `pnpm dev:local` with an owner-started `chorus daemon --agent dsh` + real DeepSeek key: prove registration + one full turn (transcript + one `source=dsh` usage).
- [ ] Prove interrupt (process-group exit, no post-interrupt pollution) and restart continuity (fresh backend id settles terminal, no 409; native resume not claimed).
- [ ] Commit a redacted acceptance report under `docs/acceptance/`; secret-scan clean.
