# Technical Design: Per-agent daemonWake opt-in

## Overview

Split the two facts #506 conflated into `agentType`:
- `agentType` (unchanged set: claude-code / codex / kiro / offline) = the backend identity. `offline` = backend cannot be daemon-woken.
- new per-agent boolean `daemonWake` = operator's opt-in to have the daemon wake this (capable) agent.

The daemon already skips `offline` agents in the runtime fan-out (proxy-only). This change routes wakeable-backend-but-not-opted-in agents down the SAME proxy-only path via `daemonWake === false`, and makes `chorus init` default that field off with an explicit opt-in.

## Runtime wake gate (single source of truth)

`cli/daemon.mjs` `buildMultiAgentDaemon`:
- **Skip condition** (was `cfg.agentType === "offline"`): now `cfg.agentType === "offline" || cfg.daemonWake === false`. A skipped agent builds no spawner, opens no SSE stream, registers no wakeable connection — its key stays in `daemon.json` for `chorus mcp`. (Same log/behavior as the existing offline skip; message distinguishes "offline backend" from "daemon-wake disabled".)
- **all-not-woken idle daemon** (was `anyWakeable = agentConfigs.some(cfg => cfg.agentType !== "offline")`): now `some(cfg => isWakeableAgentType(cfg.agentType) && cfg.daemonWake !== false)`. When nothing is woken, the idle no-op daemon path is taken (keys remain for `chorus mcp`).

`cli/daemon-config.mjs` cfg builder: carry `daemonWake: entry.daemonWake` onto each per-agent `cfg` (multi-agent map at ~line 380 and the back-compat single-agent object; single-agent has no field ⇒ `undefined` ⇒ woken). `daemonWake` is a pass-through boolean; only `=== false` disables (absent/true ⇒ woken), which preserves #506's already-written entries.

`isWakeableAgentType` (cli/init/agent-type-map.mjs) is the existing predicate (claude-code/codex/kiro true; offline false) — reused for the `anyWakeable` gate.

## init: default-off + opt-in

`cli/init/steps/credential-seed.mjs` — when appending each selected agent to `agents[]`:
- If the agent's mapped `agentType` is NOT wakeable (offline) → do not set `daemonWake` (irrelevant; it can never wake).
- If wakeable → set `daemonWake` from the opt-in decision, defaulting **false**:
  - TTY: per capable agent, ask `Enable daemon waking for <name> (<agentType>)? [y/N]` (default No).
  - Non-TTY: `false` unless the agent id is in `--daemon-wake <csv>` or `--daemon-wake-all` is set.
- Write `daemonWake` explicitly (true/false) on the appended entry so intent is recorded (vs. the absent=woken legacy default).

`cli/init-args.mjs` — parse `--daemon-wake <csv>` (repeatable, space+`=` forms, normalized like `--agents`) and `--daemon-wake-all` (boolean). Add to JSDoc + help.

`cli/init/steps/daemon-setup.mjs` — the auto-start capability gate currently keys off `wakeableTypes` (backends). Change it to key off "will-be-woken" = selected agents that are wakeable AND opted-in (daemonWake). If none will be woken, take the existing skip path (persist `agents[]`, no auto-start prompt / no service install), messaging "no agent enabled for daemon waking". daemon-setup still writes nothing top-level for a selection (per the #506 fix).

## Module Contracts

- `daemonWake` semantics everywhere: **only `=== false` means "do not wake"**; `undefined`/`true` mean woken (for a wakeable backend). This keeps pre-#506 entries (no field) woken.
- `offline` agentType is orthogonal and dominant: an offline agent is never woken regardless of `daemonWake`.
- init records `daemonWake` explicitly (true|false) only for wakeable agents; offline agents omit it.

## Risks & Mitigations

- **Regressing existing woken agents** → gate uses `!== false`, and the cfg builder passes the field through untouched; entries without the field stay woken. Test: an agents[] entry with no daemonWake is still built/woken.
- **Double prompt vs #506's "no re-prompt"** → the daemonWake opt-in is a NEW, distinct question (per capable agent), not the removed backend menu; it does not reintroduce a backend prompt.
- **Non-TTY must not block** → opt-in is flag-driven (`--daemon-wake*`), default off; never prompts without a TTY.
- **all-not-woken with --daemon-autostart** → the gate skips the install (nothing to wake) even with the flag, mirroring the all-offline behavior.

## Implementation Plan

1. Runtime + schema: `daemon-config.mjs` cfg.daemonWake; `daemon.mjs` skip + anyWakeable gate; `daemon-multi-agent` spec ADD. Tests: daemon-config + daemon-multi-agent-runtime.
2. init flow: `--daemon-wake`/`--daemon-wake-all` (init-args); credential-seed default-off + opt-in; daemon-setup auto-start gate on woken; `chorus-init` spec. Tests: init-args, init-credential-seed, init-daemon-setup, init-integration (claude opted-in vs kiro default-off → daemonWake true/false; all-not-woken skips auto-start).
