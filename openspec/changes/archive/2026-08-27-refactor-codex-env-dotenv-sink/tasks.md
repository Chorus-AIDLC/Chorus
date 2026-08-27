# Tasks — Codex credential sink → `~/.codex/.env`

## 1. Dotenv writer + helpers (TDD)
- [ ] Replace `writeCodexShellEnvCreds` with `writeCodexEnvFile({ envPath, url, apiKey, agentProfile })` — dotenv upsert mirroring `writeDshCredentialsEnv` (0600, atomic temp+rename, idempotent, merge-preserving, tolerates `export ` prefix, key never echoed). Prefer extracting a shared `upsertDotenv` helper shared with dsh; else mirror dsh's proven code.
- [ ] `resolveCodexEnvPath(env)` = `(CODEX_HOME || ~/.codex)/.env`; keep `isCodexSelection`.
- [ ] `readCodexEnvProfile(envPath)` — return existing `CHORUS_AGENT_PROFILE` (via `node:util` parseEnv), undefined on missing/unreadable; never throws.
- [ ] Unit tests: create fresh, preserve unrelated lines, upsert-in-place (no dup), idempotent + 0600, parseEnv round-trip, readCodexEnvProfile happy/missing.

## 2. Wire into seedCredentials + init.mjs + agents.mjs (TDD)
- [ ] Rewire the codex-only block in `seedCredentials`: write `~/.codex/.env`; CC-parity repoint (TTY prompt / non-TTY WARNING via `readCodexEnvProfile`); export-free success note (wires hooks + shell tool, no residual, no wrapper, key never echoed); failure WARNING naming the 3 keys. Keep `codexEnvWritten`.
- [ ] `cli/init.mjs`: `profileExportHint` keeps keying on `codexEnvWritten` (comment → `.env`).
- [ ] `cli/agents.mjs`: remove-note points at `~/.codex/.env` (+ untouched config.toml Bearer).
- [ ] Integration tests: writes `.env`, single-agent still written, repoint TTY-declined/non-TTY-warn, success note export-free + no wrapper + no key, failure WARNING, non-codex untouched; adjust `init.test.mjs` / `agents.test.mjs` codex assertions. Full `cli/` suite: no NEW failures vs base.

## 3. Docs + i18n
- [ ] `docs/CONNECT_CODEX.md` + `.zh.md`: step + caveat sections → `~/.codex/.env`, export-free (hooks included); delete the "start codex from an exporting shell" residual.
- [ ] `messages/{en,zh,ja,ko}.json` `step2Tip`: config.toml `[shell_environment_policy].set` → `~/.codex/.env`; key-parity across all four locales.
- [ ] Grep for any remaining `shell_environment_policy` / config.toml-env references in skill/docs surfaces; fix or confirm none.

## 4. Verify + archive
- [ ] `npx tsc --noEmit`, `pnpm lint`, targeted vitest green.
- [ ] `openspec validate refactor-codex-env-dotenv-sink --strict`.
- [ ] `openspec archive` runs after the last task is verified (skill §3.9) — mirror the merged `chorus-init` spec back.
