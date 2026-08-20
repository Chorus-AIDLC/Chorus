# Technical Design: Broaden chorus init plugin-install adapters

## Overview

`chorus init`'s plugin-install step (`cli/init/steps/plugin-install.mjs`, order 20) invokes `adapter.installPlugin(ctx)` once per selected agent. Each agent's mechanics live in `cli/init/install-methods.mjs` as a per-agent `installX(ctx)` returning a `StepOutcome`, wired into a descriptor in `cli/init/adapters.mjs` (`AGENT_DESCRIPTORS`).

**Pre-existing `supported` bug (must fix — see "Making `supported` honest" below):** `buildAdapter()` currently derives `readInstallState().supported = typeof d.install === "function"`. But `guided()` *also* returns a function, so today **all** fallback agents (dsh/openclaw/kiro/pi) already report `supported: true` even though they only emit a guided `unsupported` message. This change corrects `supported` to mean "has a **real** automated install", so the three new installers report `supported: true` and pi (still guided) correctly reports `supported: false`.

This change adds three per-agent installers (dsh, openclaw, kiro) and their state readers, and revises `GUIDED_MESSAGES`. It introduces **no new shared abstraction** for npm — dsh/openclaw are the same shape as the existing three (shell the agent's own CLI via `ctx.run`); their "npm-ness" is just the source argument. kiro is the one genuinely new *method* (file-template), isolated in a small helper.

## Architecture

### Making `supported` honest (one tiny core correction)

The only edit outside the per-agent installers: tag guided results so `buildAdapter` can tell a real installer from a guided placeholder.

- `guided(agentId, detail)` returns its function with a `.guided = true` marker.
- `buildAdapter` computes `supported: typeof d.install === "function" && d.install.guided !== true`.

Result: real installers (claude/codex/opencode + the new dsh/openclaw/kiro) → `supported: true`; guided placeholders (pi) → `supported: false`. No other orchestrator/contract change. This is the mechanism Task 4 verifies; it also fixes the pre-existing latent bug where every guided agent falsely reported `supported: true`.

### Contract reuse (otherwise no core changes)

Aside from the `supported` correction above, all three installers use the existing `StepContext` seams — no changes to `contracts.mjs` or the orchestrator:

- `ctx.run(cmd, args, { env })` — inject-able synchronous runner (`run-command.mjs`), so installers unit-test without shelling.
- `ctx.io.{ log, ask, isTTY }` — for the dsh profile picker (interactive prompt with non-TTY fallback).
- `ctx.backup(path)` — backup-before-overwrite (kiro's `settings/mcp.json`).
- `ctx.env` — HOME / `$DSH_HOME` / config-dir resolution.
- Return `out(agentId, action, detail)` with `action ∈ {installed, repaired, skipped, failed, unsupported}`.

Per-agent failures return a `failed` outcome (never throw) — the step already isolates one agent's failure from the others.

### dsh — `installDsh` + `readDshInstallState`

VERIFIED command (docs/CONNECT_DSH.md): `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`.

1. **Prereq:** `pnpm` on PATH (dsh delegates package management to pnpm). Missing → `failed` with a clear "install pnpm" detail. `-w` is mandatory (a dsh profile is a pnpm workspace root; pnpm refuses to add a dependency to a workspace root without it).
2. **Profile resolution (owner decision: detect + pick):** enumerate the user's existing dsh profiles, present them via `ctx.io.ask` on a TTY, and install into the chosen profile. Non-TTY → require `--dsh-profile <name>` (or documented flag) and `failed` if absent (never guess a profile). *Open verification:* where dsh stores its profile list must be confirmed against the real dsh CLI before hardcoding the enumeration; if unavailable, degrade to a prompt-for-name with no pre-populated list rather than a wrong guess.
3. **Idempotency:** `readDshInstallState` inspects the target profile's package state (the profile's resolved dependency set / cordis config) for `@chorus-aidlc/chorus-dsh`; present → `skipped`.
4. **Boundary:** touches only the interactive profile. The daemon-managed composition (Chorus-owned state outside `$DSH_HOME`, prepared by `cli/dsh-spawner.mjs`) is untouched.
5. Credentials are handled by the credential-seed step (order 10) / `$DSH_HOME/.env` — this installer writes no secret.

### openclaw — `installOpenclaw` + `readOpenclawInstallState`

VERIFIED (packages/openclaw-plugin/README.md + package.json `openclaw.install`): two steps.

1. `openclaw plugins install npm:@chorus-aidlc/chorus-openclaw-plugin`
2. `openclaw plugins enable chorus-openclaw-plugin`

- **Version guard:** the package declares `openclaw.install.minHostVersion = ">=2026.4.27"`. Read the installed openclaw version (`openclaw --version`) and, if below the floor, return `failed`/`unsupported` with the required version rather than attempting an install the host can't load (openclaw's compiled `runtimeExtensions` demand a compatible host).
- **Idempotency:** `readOpenclawInstallState` checks whether `chorus-openclaw-plugin` is already installed+enabled (openclaw's plugin list / config); installed-and-enabled → `skipped`; installed-but-disabled → run only `enable` and report `repaired`.

### kiro — `installKiro` + `readKiroInstallState` (new file-template method)

Kiro has **no plugin CLI**; its "plugin" is a set of loose files under `.kiro/` (what `public/install-kiro.sh` drops). Re-implement that drop natively in JS (cross-platform, no bash, no curl dependency), in a small `cli/init/file-template.mjs` helper:

1. **Assets:** the chorus-* skills (`.kiro/skills/<s>/SKILL.md`), main agent (`agents/chorus.json` + `chorus.md`), 3 reviewer agents, steering doc (`steering/chorus.md`), hook scripts → `.kiro/chorus-bin/` (chmod +x on POSIX).
2. **`__CHORUS_BIN__` substitution:** rewrite the placeholder in `agents/chorus.json` hook `command` strings to the resolved absolute `chorus-bin` path; fail loudly if the placeholder survives.
3. **MCP merge:** merge the `chorus` server (`type:"http"`, `url:"${CHORUS_URL}/api/mcp"`, `Authorization: "Bearer ${env:CHORUS_API_KEY}"`) into `<KIRO_DIR>/settings/mcp.json`, preserving pre-existing servers, via `ctx.backup()` first. Key stays a `${env:...}` reference — never a literal.
4. **Idempotency:** `readKiroInstallState` treats kiro as installed when the chorus skills + `agents/chorus.json` + the `chorus` mcp server are all present; re-run repairs the missing delta.
5. **Anti-drift:** bash can't `import` a JS module, so the manifest cannot be one shared importable module. Instead the artifact manifest (skills / reviewer agents / hook scripts lists) lives in a single **shared data file** both consumers read at runtime — the JS installer via `JSON.parse` (or a line-delimited read), `install-kiro.sh` via a plain file read (it currently inlines `SKILLS=` / `REVIEWER_AGENTS=` / `HOOK_SCRIPTS=` bash strings, refactored to read the shared file). A **parity test** additionally asserts the JS side and the bash side resolve the identical asset set, so a future skill addition can't land in one and miss the other.

**Asset source for the published `chorus` npm CLI (DECIDED — download from the instance):** the `.kiro/` template assets are **fetched from the connected Chorus instance** at `$CHORUS_URL/kiro-plugin/…`, mirroring `install-kiro.sh`'s remote mode. `chorus init` already has the Chorus connection URL in hand, so this avoids bundling a second copy of the assets into the npm package and keeps them in lockstep with the server the user is connecting to. Fetch via Node's built-in `fetch` (no `curl` dependency — cross-platform). The kiro installer must still verify each asset downloaded successfully before reporting `installed`, and `failed` cleanly (naming the unreachable URL) if the instance can't serve them.

## Module Contracts

- **Outcome shape:** every installer returns `{ stepId:"plugin-install", agentId, action, detail }` via the shared `out()` helper; `errText(r)` for the first stderr/stdout line on failure.
- **State-reader shape:** `readXInstallState({ env })` returns `{ marketplaceRegistered?, pluginInstalled, version? }`; `buildAdapter` adds `supported`. Never throws (wrapped by `safeState`).
- **No secret writes:** plugin installers never write MCP-server config or credentials — except kiro, where the plugin surface *is* the file drop and the MCP server is a `${env:...}`-referenced (non-literal) entry in `settings/mcp.json`, consistent with install-kiro.sh.
- **VERIFIED comments:** each new installer carries a header note citing the exact CLI + version it was verified against; anything unverifiable degrades to guided rather than a guessed command.

## Daemon / agent-backend classification (folded in — minimal, no consolidation)

Owner decision: fold the daemon classification into this idea but **do NOT** consolidate the two registries (init's `AGENT_DESCRIPTORS` and the daemon's `KNOWN_AGENTS`/`AGENT_MENU`). Add only the minimal pieces:

- **`offline` agentType vocabulary.** Add `"offline"` to `cli/daemon-agent.mjs` `KNOWN_AGENTS` (so `--agent`/validation accept it) and to the accepted values in `cli/agent-backend-prompt.mjs`. `"offline"` = in `daemon.json` for the `chorus mcp` proxy key, but the daemon builds no spawner and dispatches no wake. It is the fail-closed classification for any selected agent whose backend isn't daemon-wakeable (opencode / openclaw / pi, dsh while dormant). The spawner-select path must treat `offline` as "never wake" (mirrors Multica's opt-in, fail-closed capability maps — absent-from-wakeable = safe default).
- **Per-selected-agent key capture.** `cli/init/steps/credential-seed.mjs` loops the init selection: one Chorus key per selected agent (TTY prompt; `--api-key`/env pre-fill for the first), each validated then written to `daemon.json` `agents[]` with its `agentType` (a wakeable backend, or `offline`). 0600, never echoed. Merge-safe (preserves other agents / `yoloAckAt` / `cwds`).
- **Reuse selection, suppress the re-prompt.** `cli/init/steps/daemon-setup.mjs` currently calls `resolveInstallAgent`, which renders "Which local agent backend should this daemon wake?" (`daemon-install-config.mjs:378`). When init already has a selection, pass it through so `resolveInstallAgent` derives `agentType` per agent from the selection instead of prompting. init step 1 (`select.mjs`) is the single selection point.
- **Selection-id → agentType mapping (name mismatch — must not pass through verbatim).** init adapter ids and daemon `KNOWN_AGENTS` values are NOT identical: the init id `claude` must map to the daemon `agentType` **`claude-code`** (`KNOWN_AGENTS = ["claude-code","codex","kiro","dsh"]`). Explicit, total map: `claude → claude-code`, `codex → codex`, `kiro → kiro`; `opencode / openclaw / pi → offline`; `dsh → offline` (while its daemon backend is de-advertised). A single mapping helper is the one place this translation lives; the integration test MUST include `claude` so the `claude → claude-code` case is actually exercised (not just the same-name backends).
- **Capability-gate the auto-start prompt.** daemon-setup shows the "enable daemon autostart?" prompt only when ≥1 selected agent is daemon-wakeable; an all-offline selection persists the `agents[]` entries, skips the prompt + service install, and reports "no daemon-wakeable agent selected".

Boundary preserved from Round 1: still no touching of the daemon-managed *dsh composition* path (`cli/dsh-spawner.mjs`); this is the daemon.json config + interactive selection surface only.

## Implementation Plan

1. dsh installer + state reader + profile picker (interactive + non-TTY fallback) + pnpm precheck; remove stale `GUIDED_MESSAGES.dsh`; wire descriptor.
2. openclaw installer + state reader + version guard + install/enable; remove `GUIDED_MESSAGES.openclaw`; wire descriptor.
3. kiro file-template method (`file-template.mjs` + shared manifest) + state reader + mcp.json merge; remove `GUIDED_MESSAGES.kiro`; wire descriptor; download assets from `$CHORUS_URL/kiro-plugin/…`.
4. Daemon classification: add `offline` to the vocabulary; per-selected-agent key capture in credential-seed; reuse-selection (suppress `resolveInstallAgent`'s menu) + capability-gate the auto-start prompt in daemon-setup; spawner never wakes `offline`.
5. Integration checkpoint: correct pi guided copy; end-to-end init test across the broadened set (install + daemon.json agentType/offline); confirm `supported` flips, per-agent failure isolation holds, and the daemon step does not re-prompt.

## Risks & Mitigations

- **Wrong dsh profile-store assumption** → verify against real dsh CLI; degrade to prompt-for-name if the profile list can't be enumerated. Never install into a guessed profile.
- **openclaw host-version drift** → read `minHostVersion` from the package rather than hardcoding; guard before install.
- **kiro manifest drift between JS and bash** → a single shared *data file* both read at runtime (bash can't import a JS module) plus a parity test asserting the two resolve the same asset set.
- **kiro instance unreachable / assets unservable** → the kiro installer downloads `.kiro/` assets from `$CHORUS_URL/kiro-plugin/…`; it must verify each fetch and report `failed` (naming the unreachable URL) rather than a partial drop. (This trades offline capability for zero-bundle + always-fresh assets — an accepted tradeoff since `chorus init` is inherently connecting to an instance anyway.)
- **Cross-platform (Windows)** → kiro installer is pure JS (node fs + path + built-in `fetch`), no bash/curl; chmod is POSIX-guarded.
- **Per-agent key capture in non-TTY** → a single `--api-key` can't distinguish N agents; the non-interactive path must report which selected agents still need a key rather than silently reusing one across identities.
- **`offline` must fail closed everywhere it's read** → the spawner-select / wake-dispatch path must skip `offline` explicitly; a code path that doesn't recognize `offline` must not fall through to a default backend and wake it. Mirror the daemon's existing opt-in capability-map discipline.
