## Why

`chorus agents run` launches a coding agent (Claude Code, Codex, Kiro, Pi, Trae, …) interactively in the foreground, but the conversation is invisible to Chorus. A user who starts work in the terminal cannot later pick up that same conversation from the Chorus UI — the daemon only knows sessions it spawned itself. The reverse direction (Chorus → terminal via `claude --resume`) already exists; this change closes the loop CLI → Chorus.

Source idea: "CLI 启动的 agent 会话同步到 Chorus，支持在 Chorus 中继续对话" (b0ef9704-ee99-4c16-bef8-7d9528ae67c2).

## What Changes

- `chorus agents run` SHALL, by default, register the launched conversation as a `DaemonSession` (ad-hoc by default, or anchored to an Idea with `--idea <uuid>`), pinned to the local host + cwd. `--no-sync` disables all sync and keeps today's behavior exactly.
- The CLI SHALL make the foreground conversation resumable under exactly the identity the daemon uses: inject the daemon-derived key (`backendSessionKey(sessionId, agentUuid)`) for caller-id backends (Claude Code, Pi), or discover the backend-generated id (Codex, Trae, Kiro) and record it in the daemon's session map with ownership the daemon accepts (adds the missing Kiro ownership verification).
- Transcript sync: backends whose interactive mode writes a tail-able on-disk transcript are synced **live** while the CLI runs; backends that cannot be tailed reliably **degrade to a one-shot upload at CLI exit**, reconstructed from the backend's on-disk session store.
- While the CLI holds the session (a server-side lease kept alive by heartbeat; its running CLI turn is excluded from daemon orphan/interrupt machinery), instructions sent from Chorus are **queued** as pending turns and not delivered to the daemon. When the CLI exits (lease released, or expired after a crash — detected on the origin daemon's heartbeat), the server **immediately** delivers the queued turns to the session's origin daemon connection, which resumes the conversation.
- If no daemon connection exists for this agent + host + cwd at launch, the CLI SHALL print a warning and still launch and register the session; the session binds to the matching daemon connection when it comes online and becomes continuable then.
- The Chorus conversation UI SHALL show that a session is currently held by a terminal ("Running in CLI") and that sends will queue.

## Capabilities

### New Capabilities
- `cli-agent-session-sync`: registration, backend-id capture, transcript sync, CLI lease, queued-instruction handoff and offline-daemon binding for sessions started with `chorus agents run`.

### Modified Capabilities
- None (the existing `cli-agent-launch` contract — verbatim arg passthrough, inherited TTY, exit-code forwarding, secret hygiene — is preserved; sync is additive and best-effort).

## Impact

- CLI: `cli/agent-launcher.mjs`, new `cli/cli-session-sync.mjs` + per-backend transcript sources, reuse of `cli/claude-spawner.mjs` transcript parsing, `cli/kiro-transcript.mjs`, `cli/session-map.mjs`, `cli/kiro-spawner.mjs` + `cli/spawner-select.mjs` (Kiro ownership verification).
- Server: `prisma/schema.prisma` (`DaemonSession` CLI-lease fields, nullable origin binding), `src/services/daemon-session.service.ts`, `daemon-instruction.service.ts`, new `src/app/api/daemon-sessions/cli/*` routes, delivery gating in the pending-turns / wake path.
- UI: daemon conversation surface ("Running in CLI" state, queued hint), i18n en/zh, both themes; `docs/design.pen`.
- Docs: `docs/MCP_TOOLS.md` unaffected (no MCP tool); CLI help + `chorus-cli` skill docs in `public/skill/` and `public/chorus-plugin/skills/`.
