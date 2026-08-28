# Tasks — add-codex-profile-env-injection

## 1. Implement + wire the `config.toml` credential writer into `chorus agents add`
- [ ] Add `writeCodexShellEnvCreds({ configPath, url, apiKey, agentProfile }, deps?)` to `cli/init/steps/credential-seed.mjs` (targeted textual TOML upsert; DI seams mirror `writeDshCredentialsEnv`).
- [ ] Upsert CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE under `[shell_environment_policy].set`; preserve every other section/key/comment (esp. `[mcp_servers.chorus]` Bearer); 0600 atomic; idempotent; throw on ambiguous structure; never echo the key.
- [ ] Wire into `seedCredentials` for the `codex` selection, UNGATED (every Codex agent, single + multi).
- [ ] Stamp `codexEnvWritten: true` on success; on failure emit an actionable non-secret WARNING naming the 3 keys + how to set them.
- [ ] Extend `profileExportHint` in `cli/init.mjs` to skip `codexEnvWritten` outcomes.
- [ ] Add the one-line `~/.codex/config.toml` "clear manually" note to `chorus agents remove` (`cli/agents.mjs`).
- [ ] Unit + integration tests. No plugin-hook change (resolution order already in chorus-mcp-call.sh).

## 2. Spike hook-env coverage + confirm the residual fallback
- [ ] Verify against the installed `codex` whether `[shell_environment_policy].set` reaches SessionStart / PostToolUse hook subprocesses; record the finding in design.md.
- [ ] Hooks covered → interactive Codex fully export-free (url+key satisfies on-session-start.sh preflight; profile preferred for resolution). Hooks NOT covered → confirm the export-hint fallback names all three keys; record accepted residual (no wrapper).
- [ ] Smoke: with creds written into config.toml, confirm a shell-tool `chorus mcp call` resolves the correct identity (document any headless limitation on driving interactive codex).

## 3. Docs & skill sweep
- [ ] `docs/CONNECT_CODEX.md` (+ `.zh`): interactive Codex needs no manual export after `chorus agents add` (creds written into config.toml [shell_environment_policy].set); reflect the task-2 hook finding.
- [ ] In-app Install Guide + i18n en/zh/ja/ko (locale key-parity).
- [ ] `chorus-cli` skill env section; `docs/MCP_TOOLS.md` if it references a Codex manual export.
