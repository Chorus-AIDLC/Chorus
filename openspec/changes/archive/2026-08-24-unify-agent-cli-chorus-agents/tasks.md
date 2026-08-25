# Tasks — Unify agent management under `chorus agents`

## 1. CLI: retire `chorus init`, route `chorus agents add|remove|list`
- [ ] 1.1 `chorus.mjs`: drop `init` from SUBCOMMANDS + its dispatch branch; keep `agents`.
- [ ] 1.2 `cli/agents.mjs`: parse the sub-verb — `add` delegates to `runInit` (import `cli/init.mjs`); `remove <name|uuid>` → new `removeAgent`; absent/`list` → existing listing; unknown sub-verb → usage + non-zero. `--help` at each level, never boots the server.
- [ ] 1.3 `removeAgent`: match agentUuid/agentName, merge-safe rewrite of `~/.chorus/daemon.json` (reuse the login.mjs writer), ambiguous/no-match errors, key never printed, dsh `.env` left with a note. Pure/injectable.
- [ ] 1.4 Update `runInit` / `init-args` user-facing strings (help, summary, the CHORUS_AGENT_PROFILE hint) to say `chorus agents add`.
- [ ] 1.5 Tests: agents.test.mjs (add/remove/list dispatch, remove match/ambiguous/no-match, no-key-leak, no-boot), init tests updated for the new entry word.

## 2. Product docs + in-app guide + i18n
- [ ] 2.1 `AgentInstallGuide.tsx` + `messages/{en,zh,ja,ko}.json`: `chorus init` → `chorus agents add` (+ its test).
- [ ] 2.2 `CONNECT_*.md(.zh)`, READMEs (en/zh/ja/ko), `MCP_TOOLS.md`, `CHANGELOG.md`.

## 3. Skills: chorus-cli (6 surfaces) + sweep + openspec-aware pointer
- [ ] 3.1 New `chorus-cli` SKILL.md on all 6 surfaces (install / configure via `chorus agents` / env / MCP ops), registered per surface (Pi/OpenClaw/dsh/Kiro enumeration + openclaw commands.test + kiro manifest).
- [ ] 3.2 `openspec-aware` §2 (6 surfaces) references `chorus-cli`.
- [ ] 3.3 Per-surface `chorus/SKILL.md`, on-session-start banners, plugin-maintenance: `chorus init` → `chorus agents add`.

## 4. Stubs + kiro manifest
- [ ] 4.1 `install-{codex,opencode,kiro}.sh` + `dsh-credentials.sh` stubs print `chorus agents add`.
- [ ] 4.2 Kiro `.kiro` file-template manifest + parity test reflect the `chorus-cli` skill.

## 5. OpenSpec + integration
- [ ] 5.1 `openspec validate unify-agent-cli-chorus-agents --strict` passes; mirror proposal/design docs to Chorus drafts.
- [ ] 5.2 Full `pnpm test` green + `tsc` clean + eslint clean; re-pack local CLI for smoke.
- [ ] 5.3 Archive after verify; mirror cumulative `chorus-init` + `chorus-cli-bootstrap-migration` specs back to Chorus docs byte-exact.
