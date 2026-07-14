# Tasks

## 1. Register kiro as a backend (agent selection + client type + dispatch)
- [ ] Add `kiro` to `KNOWN_AGENTS` in `cli/daemon-agent.mjs`; add `backendCli` (`{name:"kiro", envVar:"CHORUS_KIRO_PATH"}`) and `backendClientType` (`"kiro"`) branches
- [ ] `cli/spawner-select.mjs`: add `if (agentType === "kiro") return new KiroSpawner({logger, permissionMode, creds})`
- [ ] Server: add `"kiro"` to `DAEMON_CLIENT_TYPES` (`src/services/daemon-connection.service.ts`); add `case "kiro"` to `useClientTypeLabel` (`src/components/agent-presence/hooks.ts`)
- [ ] Reconcile the stale `KNOWN_AGENTS` in `cli/client-args.mjs` (currently only `claude-code`)
- [ ] Tests: agent resolution accepts kiro / rejects unknown; default+codex+kiro select the right spawner; claude/codex argv unchanged; `isValidClientType("kiro")` true

## 2. Kiro session-id map (persistence)
- [ ] `cli/kiro-session-map.mjs`: get/set `anchor → sessionId`, atomic write, never throws (share a generic helper with `codex-session-map.mjs` if byte-identical apart from filename/path `~/.chorus/kiro-sessions.json`)
- [ ] Tests: round-trip, missing-file, corrupt-file, write-failure degradation

## 3. KiroSpawner
- [ ] Executable resolution (PATH walk, Windows `.cmd` via cmd.exe, `CHORUS_KIRO_PATH` override)
- [ ] buildArgs: new (`chat --no-interactive --agent chorus` + trust flags) and resume (`+ --resume-id <id>`); prompt over stdin; v2 engine (no `--v3`)
- [ ] Permission mode → trust flags (`yolo → --trust-all-tools`; `chorus → --trust-tools=fs_read,<chorus-mcp-tool-names>`) — verify exact Chorus MCP trust names against installed kiro-cli
- [ ] Spawn detached, `onChild`, daemon key exported as `CHORUS_API_KEY` in child env (never argv) + `CHORUS_DAEMON_HEADLESS=1`
- [ ] sessionId capture post-run (resume: known; new: session whose store `updated_at` advanced during the run) + map write on new-run success
- [ ] Tests: argv (new/resume, `--agent chorus`, trust per mode, prompt-not-in-argv), env key export, exec resolution incl. Windows + override, no-throw on spawn failure, sessionId capture

## 4. Transcript reconstruction (store-first, plain-text fallback)
- [ ] `cli/kiro-transcript.mjs`: read `~/.kiro/sessions/cli/<sessionId>.jsonl` + `<id>.json`, map `{kind, data.content[]}` → structured transcript entries; walk child sessions (`session_created_reason:"subagent"` + `parent_session_id`)
- [ ] Fallback branch: unparseable store → single plain-text stdout blob per turn (logged degrade, never fails wake)
- [ ] Wire into the transcript-upload hook (`cli/upload-hooks.mjs`); extend the dialect extractor only if reconstructed entries don't fit the existing user/assistant envelope
- [ ] Tests: reconstruction from a fixture store incl. a child subagent session; fallback path on a corrupt/missing store

## 5. Live integration + validation (integration checkpoint)
- [ ] Validate headless MCP loads live under `kiro-cli chat --no-interactive --agent chorus` on this host (node ≥ 22); document node-22 prereq. Build the `chorus-api.sh` REST fallback ONLY if this fails
- [ ] Integration: default daemon spawns Claude with identical argv; `--agent codex` unchanged; `--agent kiro` produces expected `kiro-cli chat --no-interactive` argv for new and resume with prompt on stdin
- [ ] End-to-end on this host: real wake → turn runs → interrupt via process-group kill stops the tree → re-wake resumes `--resume-id` → transcript reconstructed and uploaded
- [ ] Re-verify all `kiro-cli chat` flags / session-store path+schema / plugin agent name (`chorus`) against installed kiro-cli 2.12.1 and the live store
