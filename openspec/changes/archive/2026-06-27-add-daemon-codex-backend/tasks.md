# Tasks

## 1. Spawner interface + agent selection + injection seam
- [ ] Add `codex` to `KNOWN_AGENTS` in `cli/daemon-agent.mjs`
- [ ] Extract the backend-agnostic `Spawner.wake(...)` interface typedef
- [ ] Add `selectSpawner(agentType, { logger, permissionMode, creds })` and wire it at the `daemon.mjs` spawner-injection seam; claude-code path byte-equivalent
- [ ] Tests: agent resolution accepts codex / rejects unknown; default + codex select the right spawner; Claude argv unchanged

## 2. Codex session-id map (persistence)
- [ ] `cli/codex-session-map.mjs`: get/set `anchor → thread_id`, atomic write, never throws
- [ ] Tests: round-trip, missing-file, corrupt-file, write-failure degradation

## 3. CodexSpawner
- [ ] Executable resolution (PATH walk, Windows `.cmd` via cmd.exe, `CHORUS_CODEX_PATH` override)
- [ ] buildArgs: new (`exec --json` + sandbox flag) and resume (`exec resume <id> --json` + sandbox flag); prompt over stdin
- [ ] Permission mode → sandbox flag (`yolo → --dangerously-bypass-approvals-and-sandbox`, `chorus → --sandbox read-only`)
- [ ] Spawn detached, JSONL parse via shared `parseNdjsonChunk`, `onMessage`/`onChild`, thread-id capture + map write on new-run success
- [ ] Daemon key exported via `bearer_token_env_var` (default `CHORUS_API_KEY`) in child env, never argv; `CHORUS_DAEMON_HEADLESS=1`
- [ ] Tests: argv (new/resume, sandbox per mode, prompt-not-in-argv), thread-id capture, env key export, exec resolution incl. Windows + override, no-throw on spawn failure

## 4. Interrupt parity + integration check
- [ ] Confirm detached process-group spawn so existing `killProcessTree` reaches Codex child shells (reused unchanged)
- [ ] Integration: default daemon spawns Claude with identical argv; `--agent codex` produces expected `codex exec --json` argv for new and resume with prompt on stdin
- [ ] Re-verify all `codex exec` flags / event field names / config keys against installed `codex --help` and `../codex` source

## 5. Docs
- [ ] Update `docs/blogs/v2ex-daemon-remote-wake.zh.md` wording ("only Claude Code; --agent reserved for codex" → codex implemented)
