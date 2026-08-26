# Tasks

## 1. Implement + wire the Claude Code `settings.json` env writer
- [ ] Add `writeClaudeSettingsEnv({ settingsPath, url, apiKey, agentProfile }, deps?)` to `cli/init/steps/credential-seed.mjs` (JSON-aware upsert of the 3 managed keys, preserve all else, missing-file → create `{}`, malformed-existing-JSON → throw, atomic 0600 temp+rename, idempotent, key never echoed).
- [ ] Wire into `seedCredentials` for the `claude` selection with REPOINT detection: read existing `env.CHORUS_AGENT_PROFILE`; absent → write; equal → idempotent no-op; different → prompt on TTY (decline = skip) / overwrite+WARN on non-TTY. Stamp `settingsEnvWritten: true` on success; on failure/decline emit the actionable WARNING (names the 3 keys + how to set them; API key value never printed).
- [ ] Extend `profileExportHint` (`cli/init.mjs`) to skip outcomes with `settingsEnvWritten === true`.
- [ ] Emit a one-line non-secret heads-up when the ambient shell already exports a DIFFERENT CHORUS_* identity (compare `env.CHORUS_AGENT_PROFILE` UUID / key-presence; never echo the key) — settings.json env overrides shell (R2→a).
- [ ] Add a one-line `~/.claude/settings.json` "clear manually" note to `chorus agents remove` (`cli/agents.mjs`), mirroring the dsh `$DSH_HOME/.env` note.
- [ ] Unit tests (writer) + integration tests (fresh write / idempotent / repoint TTY+non-TTY / write-failure warning / non-claude unaffected / remove note) in `cli/__tests__/`.

## 2. Docs & skill sweep
- [ ] Update `docs/CONNECT_CLAUDE_CODE.md` (+`.zh`) — interactive Claude Code needs no manual export after `chorus agents add`; note the repoint/decline case AND that settings.json `env` overrides shell exports (settings wins).
- [ ] Update in-app Install Guide + i18n (en/zh/ja/ko) Claude Code copy where it mentions the manual export.
- [ ] Update the `chorus-cli` skill env section across its surfaces; `docs/MCP_TOOLS.md` if it references the manual export.
