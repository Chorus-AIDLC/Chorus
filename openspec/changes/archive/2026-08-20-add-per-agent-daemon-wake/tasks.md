# Tasks

## 1. Runtime + schema: daemonWake field + wake gate
- [ ] 1.1 cli/daemon-config.mjs — carry `daemonWake: entry.daemonWake` onto each per-agent cfg (multi-agent map + back-compat single-agent)
- [ ] 1.2 cli/daemon.mjs — buildMultiAgentDaemon skip = `agentType==="offline" || daemonWake===false`; anyWakeable = `isWakeableAgentType(agentType) && daemonWake!==false`; log distinguishes offline vs wake-disabled
- [ ] 1.3 Tests: daemon-config (cfg.daemonWake passthrough incl absent) + daemon-multi-agent-runtime (wakeable+false → proxy-only; absent → woken; all-not-woken → idle)

## 2. init flow: default-off + opt-in
- [ ] 2.1 cli/init-args.mjs — `--daemon-wake <csv>` + `--daemon-wake-all` (JSDoc + help)
- [ ] 2.2 cli/init/steps/credential-seed.mjs — set daemonWake per wakeable agent (default false; TTY per-agent prompt; flags for non-TTY); offline agents omit the field
- [ ] 2.3 cli/init/steps/daemon-setup.mjs — auto-start capability gate keys off "will be woken" (wakeable && daemonWake), not merely wakeable
- [ ] 2.4 Tests: init-args, init-credential-seed (default-off, opt-in prompt, flags, offline omits), init-daemon-setup (all-not-woken skip), init-integration (claude opted-in true vs kiro default false)
