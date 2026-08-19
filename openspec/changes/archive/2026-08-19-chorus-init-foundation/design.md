# Technical Design: chorus init foundation (A1)

## Overview

`chorus init` is a new client-mode subcommand that turns "connect this machine's coding agents to Chorus" into one command. Its design centers on two extension points so sibling ideas extend it without editing its core:

1. A **per-agent adapter** contract — one adapter per harness (Claude Code, Codex, Kiro, opencode, OpenClaw, Pi, dsh). Adding an agent = adding an adapter.
2. A **step-orchestration seam** — an ordered registry of steps run against the selected agents. This change ships the *plugin-install* step and the *credential-seed* step; siblings (daemon a7c2a3e8, mcp-proxy cc115e6b, retire ad24116e) register their steps into the same registry.

The command lives beside `daemon` and `login` in the existing lazy-imported subcommand router in `chorus.mjs`.

## Architecture

### Module layout (new)

```
chorus.mjs                     # add "init" to SUBCOMMANDS; lazy-import cli/init.mjs
cli/init-args.mjs              # pure arg parse + help text (unit-testable, no side effects)
cli/init.mjs                   # runInit(flags): orchestrator (dependency-injected)
cli/init/contracts.mjs         # AgentAdapter + InitStep interfaces + shared types (JSDoc contracts)
cli/init/registry.mjs          # AGENT_REGISTRY: the list of adapters (single source of the supported set)
cli/init/detect.mjs            # detectAgents(): PATH-binary + config-dir dual-signal probe
cli/init/select.mjs            # resolveSelection(): interactive prompt (TTY) or flag-driven (non-TTY)
cli/init/steps/plugin-install.mjs   # the plugin-surface install step (this change)
cli/init/steps/credential-seed.mjs  # one-time URL+API-key capture → daemon.json (reuses login/credentials/daemon-config)
```

### `runInit` flow

```
runInit(flags):
  1. parse flags (cli/init-args.mjs)                    # already parsed by caller; validate combo
  2. detect = detectAgents(AGENT_REGISTRY)              # {id, detected, binaryOnPath, configDirPresent, currentStatus}
  3. selection = resolveSelection(flags, detect, isTTY) # interactive checklist OR --agents/--all; non-TTY must be explicit
  4. steps = orderedSteps()                             # [credential-seed, plugin-install, ...sibling-registered]
  5. for each step: step.run({ selection, flags, io, backup }) # steps decide per-agent vs once
  6. summarize()                                        # per-agent status table (installed / repaired / skipped / failed)
```

Steps are ordered and idempotent. The credential-seed step runs once (not per agent); the plugin-install step runs per selected agent. `runInit` takes its collaborators (registry, steps, prompt io, clock, spawn) via injection so it unit-tests with fakes — matching the existing pure-module pattern (`cli/client-args.mjs`, `cli/embedded-db.mjs`).

## Module Contracts

### AgentAdapter (`cli/init/contracts.mjs`)

```
AgentAdapter = {
  id: string,                 // stable: "claude" | "codex" | "kiro" | "opencode" | "openclaw" | "pi" | "dsh"
  displayName: string,        // "Claude Code"
  detect(env): {              // pure-ish; may stat fs + look up PATH, must NOT mutate
    binaryOnPath: boolean,    // e.g. `claude` resolvable on PATH
    configDirPresent: boolean // e.g. ~/.claude exists
  },
  // "detected" (for default pre-select) = binaryOnPath || configDirPresent
  readInstallState(env): {    // for idempotency: is the Chorus plugin already installed/enabled?
    marketplaceRegistered: boolean,
    pluginInstalled: boolean,
    version?: string
  },
  installPlugin(ctx): StepOutcome  // register native remote marketplace + install/enable Chorus plugin; idempotent
}
```

- `installPlugin(ctx)` MUST be idempotent: consult `readInstallState`, skip when already satisfied, otherwise apply the minimal delta and **back up any config file before overwrite** (`ctx.backup(path)`).
- Plugin source is each agent's **native remote marketplace** (the Chorus GitHub repo). No local-bundle sourcing in this change (owner decision).
- `StepOutcome = { agentId, action: "installed"|"repaired"|"skipped"|"failed", detail: string }`.

### InitStep (`cli/init/contracts.mjs`)

```
InitStep = {
  id: string,                 // "credential-seed" | "plugin-install" | (sibling steps)
  order: number,              // ascending run order
  scope: "once" | "per-agent",
  run(ctx): StepOutcome | StepOutcome[]
}
```

The registry (`orderedSteps()`) returns steps sorted by `order`. Sibling ideas append their steps here; the seam is the whole point of A1.

### Detection contract (`cli/init/detect.mjs`)

- Dual signal per adapter: binary on `PATH` (via `import.meta`/`which`-style lookup, cross-platform) **AND/OR** config directory present. `detected = binaryOnPath || configDirPresent`.
- Detection never blocks selection: undetected agents remain selectable (they render as "not detected — configure anyway?").
- Exact binary names and config dirs live in each adapter and MUST be verified against the agent's real layout at implementation time (Risks).

### Credential seeding contract (`cli/init/steps/credential-seed.mjs`)

- Collect Chorus URL + API key **once** (from `--url`/`--api-key`, else interactive prompt), validate the key against the server (reuse `cli/login.mjs` validation), persist to `~/.chorus/daemon.json` via `cli/daemon-config.mjs` / `cli/credentials.mjs`.
- Merge-safe write (preserve existing `daemon.json` fields; do not clobber `yoloAckAt` etc. — see the known merge tension in the daemon-config module).
- Does **not** write any per-agent MCP/credential config; that is sibling cc115e6b's job via a later step.

## Non-interactive / CI surface (`cli/init-args.mjs`)

- Flags: `--agents <csv>` (e.g. `claude,codex`), `--all`, `--yes` (skip confirmations; also implied when non-TTY), `--url`, `--api-key`, `--help`.
- **Non-TTY guard:** when stdin/stdout is not a TTY, the command MUST NOT guess — it aborts unless `--agents` or `--all` is given. `--yes` alone is not enough to pick agents.
- `--agents` values are validated against the registry; an unknown id is a hard error listing valid ids.

## Idempotency & backup

- Before any step overwrites an agent config file, it copies to `<file>.chorus-bak` (once) — mirrors the existing `install-*.sh` backup convention.
- Re-run reads each agent's install state and reports `installed` / `repaired` / `skipped (already configured)` per agent; only the missing/broken delta is applied.
- For Claude Code, install state is read from `~/.claude/plugins/installed_plugins.json` (v2: per-plugin `scope`/`version`/`gitCommitSha`) + `known_marketplaces.json` — **read-only**; installation itself goes through the official `claude plugin` CLI, never hand-written files.

## Per-agent mechanism table (verified where noted; others verify at implement time)

| Agent | Detect (binary / dir) | Plugin install (native remote marketplace) |
|---|---|---|
| Claude Code | `claude` / `~/.claude` | `claude plugin marketplace add <chorus-repo>` then `claude plugin install chorus@chorus-plugins -y [--config k=v]` (**verified: CC 2.1.235 has this non-interactive CLI; `-y` required when non-TTY**) |
| Codex | `codex` / `~/.codex` | `codex plugin marketplace add <chorus-repo>` + `~/.codex/config.toml` `[plugins."chorus@chorus-plugins"] enabled=true` (INSTALLED_BY_DEFAULT; Codex has no `plugin install`) — port from `install-codex.sh` |
| Kiro | `kiro` / `~/.kiro` | native mechanism — port from `install-kiro.sh`; **verify** |
| opencode | `opencode` / config dir | native mechanism — port from `install-opencode.sh`; **verify** |
| OpenClaw | binary / dir | native plugin mechanism (linked TS vs compiled dist); **verify** |
| Pi | binary / dir | native mechanism; **verify** |
| dsh | `dsh` / `$DSH_HOME` | dsh plugin is a published npm bundle; **verify** current install path |

## Implementation Plan

1. Command scaffold + arg parsing + non-interactive surface + contracts + injected `runInit` skeleton.
2. Detection + per-agent adapter registry (all supported harnesses).
3. Plugin-install step (native remote marketplace per agent) + idempotency/backup.
4. Credential-seed step (collect once → `daemon.json`, reuse login/credentials/daemon-config).
5. Integration wiring + step-registry seam + per-agent summary + docs/help.

## Risks & Mitigations

- **Per-agent CLI drift / hallucinated flags.** Only Claude Code's plugin CLI is verified here. Each adapter task MUST verify the exact marketplace/install commands and config keys against the agent's *actual* CLI (`--help`) and the existing `install-*.sh` scripts — do not rely on LLM memory. Adapters that cannot be verified ship as "detected but install unsupported (guided message)" rather than guessing.
- **Network dependency.** Native remote marketplaces require network at install time and are not version-pinned to the CLI (owner-accepted). Failures are reported per agent, non-fatal to other agents.
- **Partial success.** A step failing for one agent must not abort the others; collect per-agent outcomes and surface a summary with clear failures.
- **daemon.json merge.** Credential seeding must merge, not clobber, existing `daemon.json` (preserve `yoloAckAt`, multi-agent `agents[]`, cwd pins). Reuse the existing merge-aware writer.
- **Overlap with siblings.** A1 deliberately stops at plugin surface + credential seed. Not delivering MCP wiring means a freshly-`init`ed agent has the plugin but no live MCP tools until sibling cc115e6b lands — this is expected and documented; init's summary states the next step.
- **No UI surface.** `chorus init` is CLI-only; `docs/design.pen` is not applicable (no screen/component change).
