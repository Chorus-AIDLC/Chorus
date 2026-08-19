## Why

Connecting a coding agent to Chorus today means running the right `curl | bash` installer for that agent (`public/install-{codex,kiro,opencode}.sh`) — and Claude Code has no shell installer at all, only manual in-TUI `/plugin` commands. Each script hard-codes one agent, bundles unrelated concerns (marketplace + MCP credentials + hooks), and there is no single entry point that detects what is installed and configures several agents at once.

This change lays the **foundation** of a unified `chorus init` command — the interactive one-command experience (modeled on `openspec init`) that detects the coding agents on the machine, lets the user pick which to configure, and installs the Chorus plugin surface for each. It is child idea **A1** of the "chorus CLI as unified control plane" container (edc097bb); the daemon-setup step (a7c2a3e8), the native `chorus mcp` proxy (cc115e6b), and retiring the legacy install scripts (ad24116e) are **sibling** ideas that plug into the seam this change establishes.

## What Changes

- Add a `chorus init` subcommand (client-mode, alongside `daemon` / `login`) with an interactive flow and a scriptable non-interactive surface (`--agents a,b`, `--all`, `--yes`, `--url`, `--api-key`).
- **Detect** installed coding agents via a dual signal (CLI binary on `PATH` + the agent's config directory); pre-select detected agents but always allow selecting an undetected one.
- Define a **pluggable per-agent adapter** contract and registry covering the currently supported harnesses (Claude Code, Codex, Kiro, opencode, OpenClaw, Pi, dsh) — a new agent is added by writing one adapter, no core changes.
- Define a **pluggable step-orchestration seam** (ordered step registry). This change ships the **plugin-install step** as the first concrete step; sibling ideas register the MCP-proxy, daemon, and script-retirement steps into the same seam later.
- **Install the plugin surface** for each selected agent using that agent's own mechanism, sourced from its **native remote marketplace** (Claude Code: `claude plugin marketplace add <repo>` + `claude plugin install chorus@chorus-plugins -y`; Codex: `codex plugin marketplace add` + config enable; others per adapter). This change does **not** write per-agent MCP-server config or per-agent credentials.
- **Collect the Chorus URL + API key once** and seed the centralized daemon config (`~/.chorus/daemon.json`), reusing the existing login/credential modules — no per-agent secret injection.
- Make re-runs **idempotent**: read each agent's current install state, show per-agent status, apply only the missing/repair delta, and back up any config file before overwriting it.

## Capabilities

### New Capabilities

- `chorus-init`: The `chorus init` command — agent detection, selection, the pluggable adapter + step-orchestration seam, one-time credential seeding, idempotent re-run, and the non-interactive surface.
- `agent-plugin-install`: The per-agent adapter contract and the plugin-surface install step that registers each agent's native remote marketplace and installs/enables the Chorus plugin idempotently.

### Modified Capabilities

None. The legacy `install-*.sh` scripts and per-agent MCP/credential wiring are untouched here — they run in parallel and are retired by sibling idea ad24116e.

## Impact

- Adds a `chorus init` entry to the `chorus.mjs` subcommand router and a new `cli/init*` module tree; no server, database, or MCP-API changes.
- Reuses existing `cli/login.mjs` / `cli/credentials.mjs` / `cli/daemon-config.mjs` for credential capture and `~/.chorus/daemon.json` persistence.
- Shells out to each agent's own CLI (`claude plugin …`, `codex plugin …`, etc.) and reads/writes each agent's own config (e.g. `~/.claude/plugins/*.json`, `~/.codex/config.toml`); backs up before overwrite.
- Requires network access at install time because plugin sources are each agent's native **remote** marketplace (owner decision — versions are not pinned to the CLI; accepted trade-off vs. the offline goal).
- Cross-platform constraint holds: pure JS/Node, no native bindings; per-agent CLI flags must be verified against each agent's actual CLI at implementation time (see design Risks).
