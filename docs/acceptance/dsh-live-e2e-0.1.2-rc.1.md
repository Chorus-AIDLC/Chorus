# dsh daemon wake — live E2E acceptance (dsh 0.1.2-rc.1)

Task: `33668f51` (idea `ce76b6be`, Chorus 0.17.3). Proves the `dsh --profile sdk` launch rewrite (T2) works end-to-end against a real local server + real DeepSeek provider.

> **Status: PENDING LIVE RUN — human-in-the-loop required.** All four ACs need an owner-started daemon + a real DeepSeek key + a live prompt→LLM turn; none are completable in a headless session. Evidence sections below are filled during the live run. No secrets in logs/argv/report.

## Preconditions (headless-verified ✅)
- Installed runtime `dsh --version` = **0.1.2-rc.1**; upstream mirror `/home/ubuntu/dev/deepseek-harness` pinned at tag **dsh-v0.1.2-rc.1** (T1).
- Launch rewrite landed (T2): `cli/dsh-spawner.mjs` resolves the `dsh` bin + spawns `dsh --profile sdk [--patch]` with `DSH_HOME`; `cli/dsh-managed-config.mjs` composes the `sdk` profile via `dsh plugin --profile sdk add @chorus-aidlc/chorus-dsh -w`. 9 affected unit suites 172/172, tsc clean.
- Committed on branch `feat/upgrade-dsh-to-0-1-2-rc-1` (PR #541 → develop); not merged (human gate).

## Owner run steps
1. **Start the local server** (own shell): `pnpm dev:local` (local Postgres :5433).
2. **Start the daemon** (own shell, real creds in env — never echoed): a shell with a valid DeepSeek key + `dsh` 0.1.2-rc.1 on PATH, Chorus creds for the local server, then `chorus daemon --agent dsh` pointed at the local server.
   - The managed composition needs npm reachable to fetch `@deepseek-ai/dsh-base`/`-sdk-app`/`@chorus-aidlc/chorus-dsh`/peers into the managed `DSH_HOME` on first wake.
3. Ping @Admin Claude on this idea when the daemon is up + registered; the woken turn drives and records the evidence below.

## Live findings (2026-09-05, headless bounded probe)
- **No server deploy needed.** dsh entered `DAEMON_CLIENT_TYPES` in `861f814d` (#499, merged) — server-side dsh registration is already committed + live. T1/T2 changes are all client/daemon-side (`cli/*.mjs`, `packages/chorus-dsh`), effective by running the updated local daemon, not ECS.
- **AC1 registration PROVEN on live ✅.** `node chorus.mjs daemon --agent dsh` (local updated code, isolated HOME, creds from `~/.dsh/.env`) against `https://chorus.yfeichen.people.amazon.dev`: authenticated as **DSH `63b9aadd-b67d-4562-b6b1-6943b89013be`**, dsh CLI 0.1.2-rc.1 found, **SSE established → registered as connection `ce04fbc4`**, clean shutdown. The live server accepts dsh registration with the configured creds.
- **Bundle-version gate resolved via `CHORUS_DSH_BUNDLE_SPEC` (owner chose Option B).** The daemon defaults to `@chorus-aidlc/chorus-dsh@<appVersion>`=`@0.17.2`, whose **published** peers are still `^0.1.0-rc.7`. Rather than publish first, a new env hook `CHORUS_DSH_BUNDLE_SPEC` overrides `prepareManagedDshConfig`'s `bundleSpec` with any pnpm-installable spec (local dir / packed tarball / pinned version), so the local 0.1.2-rc.1 build composes + tests without publishing. Unset in production.

## Live run 2 (2026-09-05, local bundle via CHORUS_DSH_BUNDLE_SPEC = packed local chorus-dsh tarball)
Local updated daemon (`node chorus.mjs daemon --agent dsh --cwd <isolated home>`), creds from `~/.dsh/.env`, against live. Fixture idea `a755f20d` (throwaway project `860cc7a6`) assigned to DSH → wake.
- ✅ **Compose + spawn + turn + transcript**: the wake composed the `sdk` profile from the **local** tarball (no compose error → `dsh plugin --profile sdk add <tarball> -w` succeeded), spawned `dsh --profile sdk`, ran a real turn (`✓ wake done exit=0`, 17–22 s), and **uploaded a transcript to the idea anchor `a755f20d`** ("transcript uploaded (1 msg)"). The T2 launch/compose/spawn/transcript path works end-to-end live.
- ⚠️ **OPEN — not yet closed:**
  1. **No `source=dsh` usage frame** observed in the daemon log for the turn (AC1 requires exactly one terminal `turn-advance` with `source=dsh` camelCase usage). Needs verification of the turn-advance payload.
  2. ✅ **RESOLVED (2026-09-05) — agent→Chorus MCP write round-trip PROVEN.** Re-ran with an explicit MCP-write fixture (idea `8ce2277d`): the woken DSH agent (`63b9aadd`) called `chorus_add_comment` and posted comment `6daa4455` "DSH-MCP-OK …" (13:10:52Z), whose @mention woke the Admin side back. So the composed local bundle's `chorus-mcp` row authenticates and the agent can act on Chorus end-to-end (daemon wake → dsh session → MCP write → comment landed). The earlier run's 0 comments was agent behavior/prompt, not a broken MCP path.
  3. **Transcript 404 + dropped msg** for the dsh-internal session id (`chorus-172aaf9d…` / `chorus-e0bf14e0…`): the upload path attempts an upload keyed by the raw dsh session id (→ 404, 1 msg dropped/wake) while the idea-anchored upload succeeds. Attribution wart; **not a T2 regression** (`upload-hooks.mjs` untouched) — pre-existing dsh transcript keying, worth a follow-up.

## Acceptance evidence
- [x] **AC1 registration** — dsh `connection_registered` on live (connections `ce04fbc4` then `19da21cd`, agent DSH `63b9aadd`), 2026-09-05.
- [~] **AC1 turn (core + MCP round-trip proven, usage edge open)** — compose+spawn+turn+idea-anchored transcript (run 2) + agent→Chorus MCP write round-trip (run 3, comment `6daa4455`) proven live. Remaining open: `source=dsh` usage frame on the terminal turn-advance (not surfaced in the daemon log — needs server-side turn-usage inspection) + dsh-internal-session-id transcript 404 (known, non-regression).
- [ ] **AC2 interrupt** — a long dsh turn interrupted from the UI terminates the dsh runtime process group + descendants; no post-interrupt transcript/usage pollution.
- [ ] **AC3 restart continuity** — after a daemon restart, a second wake on the same idea reports a **fresh** backend session id and settles its terminal turn with **no 409 `backend_session_conflict`** (per-turn backend-id fix already landed); native dsh resume is NOT claimed (per-wake model).
- [ ] **AC4 report + secret scan** — this report filled with redacted evidence; secret-scan of logs/argv/report clean.

## Notes carried from T2 review (verify live if exercised)
- Non-default `CHORUS_DSH_PROVIDER`: the generated `--patch` overlay currently sets `agent-default-model.config.provider` rather than mounting a dedicated `llm-<provider>` adapter row. Default `deepseek-official` needs no patch and is the exercised path; only test the non-default path if the owner sets a non-default provider.
