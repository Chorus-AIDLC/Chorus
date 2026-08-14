# Tasks

## 1. Per-agent config model + resolver + flat back-compat
- [ ] 1.1 Define `AgentConfig` and `resolveAgentConfigs(flags, deps)` in `cli/daemon-config.mjs` / `cli/credentials.mjs`
- [ ] 1.2 Merge each `agents[]` entry over top-level defaults; synthesize one agent from flat resolution when `agents[]` absent
- [ ] 1.3 Validate apiKey/url/agentType per agent; exit non-zero naming the offending agent
- [ ] 1.4 Unit tests: flat→single agent, agents[] parsing, default inheritance, per-agent override, invalid-entry failure

## 2. Multi-agent daemon runtime (buildDaemon fan-out)
- [ ] 2.1 Iterate `resolveAgentConfigs`; per agent: checkin identity, `ChorusClient`, `LineageResolver`, `selectSpawner(agentType)`, `WakeQueue({maxConcurrency})`
- [ ] 2.2 Build connections per agent over that agent's own cwds; per-agent SSE/reporters/hooks/EventRouter/Waker
- [ ] 2.3 Per-agent failure isolation + per-agent identity lines in startup banner
- [ ] 2.4 Tests: N-agent fan-out, per-agent concurrency independence, isolation on one agent's failure

## 3. Per-backend per-agent credential delivery
- [ ] 3.1 Thread each agent's creds into its spawner + `mcp-config.mjs` (Claude per-wake file) + child env export
- [ ] 3.2 Kiro: per-agent env export; keep `install-kiro.sh` mcp.json in `${CHORUS_URL}` template form
- [ ] 3.3 Codex: per-agent env export for plugin scripts; key user-managed; fix stale `codex-spawner.mjs:18` comment
- [ ] 3.4 Tests per backend: correct per-agent key/url reaches the subprocess

## 4. Registration / management UX
- [ ] 4.1 `chorus login --add`: validate key (masked), append to `agents[]` via field-merge writer, never overwrite existing agent
- [ ] 4.2 Install wizard: add multiple agents in one run
- [ ] 4.3 Tests: append flow, invalid-key no-write, flat→agents[] migration on first add

## 5. Integration checkpoint — two independent agents online, end-to-end
- [ ] 5.1 2-agent config (distinct keys + cwds, e.g. Claude + Kiro): boot daemon, assert each registers its own DaemonConnection/AgentInstance and wakes independently
- [ ] 5.2 Back-compat: flat config still yields exactly one agent with today's behavior

## 6. Docs — daemon multi-agent configuration
- [ ] 6.1 Document `agents[]` schema + default/override semantics + `login --add`
- [ ] 6.2 Document per-backend key behavior: Claude (auto), Kiro (env), Codex (user-managed + CODEX_HOME caveat)
