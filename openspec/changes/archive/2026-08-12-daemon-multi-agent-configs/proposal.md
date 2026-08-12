## Why

Today one `chorus daemon` process serves exactly **one** agent: `~/.chorus/daemon.json` holds a single `{ url, apiKey }`, which resolves to a single `agentUuid` threaded as one shared `creds` object through every subsystem. Multi-cwd already exists, but every connection belongs to that one agent. To run two independent agents on one machine (different personas / permissions / accounts, or even different backends) you must install and run a second daemon. We want one daemon process to serve **N fully-independent agents online at once**, each with its own credentials and working directories.

## What Changes

- **Add `agents: [ … ]` to `daemon.json`.** Each entry is a complete, independent agent config: `{ url, apiKey, agentType, cwds[], permissionMode, maxConcurrency, sigintTimeoutMs, browseRoots? }`. Every top-level field remains a **default**; a per-agent field overrides it.
- **One daemon serves N agents concurrently** — each agent gets its own identity (its `apiKey` → its own `agentUuid` via checkin), its own SSE connections over its own `cwds`, and its own wake dispatch. One agent's failure does not affect the others.
- **Per-agent backend** — each agent's `agentType` selects its own spawner, so a single daemon can run Claude + Codex + Kiro agents simultaneously.
- **Per-agent wake concurrency** — each agent has its own wake-queue cap, now **configurable** per agent (default `4`; today it is a process-wide hardcoded `4` with no config knob).
- **Per-agent credential delivery to each backend** — Claude via the existing per-wake `--mcp-config` file (carries that agent's url + key); Kiro via its runtime `${env:CHORUS_API_KEY}` / `${CHORUS_URL}` interpolation from the per-spawn env; Codex declarable and spawned per-agent, but its Chorus MCP key stays **user-managed in Codex's own `~/.codex/config.toml`** (the daemon still exports `CHORUS_*` env, used by the plugin's shell scripts, not for Codex MCP auth).
- **Overlapping cwds allowed** — different agents may share/overlap cwds and run concurrently; the daemon does not serialize. git-worktree contention is the operator's responsibility (use separate branches / worktrees).
- **Registration UX** — `chorus login --add` appends an agent; the install wizard supports adding multiple; hand-editing `daemon.json` is always supported.
- **Backward compatible (non-breaking)** — when `agents[]` is absent, the flat top-level `url`/`apiKey`/`cwds`/… are treated as exactly one agent, so existing installs run unchanged with zero edits.

## Capabilities

### New Capabilities

- `daemon-multi-agent`: configuring and running multiple independent agents (own apiKey, cwds, backend, permission mode, concurrency) in one daemon process — config model, back-compat, concurrent serving, per-agent backend, per-agent concurrency, per-backend credential delivery, cwd-overlap policy, and registration UX.

### Modified Capabilities

- _(none)_ — the multi-agent behavior is layered additively on top of the existing single-agent capabilities (`cli-auth`, `cli-daemon`, `daemon-agent-selection`, `daemon-permission-mode`, `daemon-connection-registry`). A back-compat requirement in the new capability preserves their current behavior for the no-`agents[]` case, so none of their requirements change.

## Impact

- **CLI (`cli/`)**: `daemon-config.mjs` + `credentials.mjs` + `daemon-install-config.mjs` (resolve to a list of per-agent configs); `daemon.mjs` `buildDaemon` (fan-out from `1 creds × cwds` → `N agents × their own cwds`: per-agent `ChorusClient`, `LineageResolver`, `selectSpawner`, `WakeQueue`, connections); `login.mjs` (`--add`); `mcp-config.mjs` / `*-spawner.mjs` (per-agent creds + env). Fix the stale `codex-spawner.mjs:18` comment (claims `bearer_token_env_var` but the installer bakes a literal).
- **Install (`public/`)**: `install-kiro.sh` keeps the `${CHORUS_URL}` template form (so URL is per-agent, not baked literal).
- **Server**: no schema change — `DaemonConnection` / `AgentInstance` are already keyed on `(agentUuid, host, cwd)`, so N agents naturally register as distinct rows.
- **Docs**: daemon config documentation (`agents[]` schema, per-backend key behavior, `login --add`).

## Out of Scope / Follow-ups

- **yolo-ack dead-code removal.** `yoloAckAt` is already vestigial (permission default flipped to yolo-no-confirm; `readYoloAck`/`recordYoloAck` have no callers). Removing it cleanly ripples into two *archived* capabilities (`daemon-permission-mode` ack requirement + `cli-auth` login-preservation clause) and is orthogonal to multi-agent, so it is deferred to a separate cleanup change to keep this one focused.
- **Automated per-agent key injection for Codex.** Codex reads a single static `~/.codex/config.toml`, so running two Codex agents with *different* keys requires the operator to set up separate `CODEX_HOME` dirs themselves; the daemon does not automate `-c` / `CODEX_HOME` injection in v1. (Mechanism is proven; deferred.)
