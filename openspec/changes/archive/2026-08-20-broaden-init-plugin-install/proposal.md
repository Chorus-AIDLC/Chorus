## Why

The core purpose of `chorus init`, once a coding agent is selected, is to **install that agent's Chorus plugin**. Today only agents with a *native remote marketplace / plugin CLI* are truly automated:

- ✅ `claude` — `claude plugin marketplace add` + `plugin install -y`
- ✅ `codex` — `codex plugin marketplace add` + `plugin add`
- ✅ `opencode` — `opencode plugin <module> -g`
- ❌ `kiro` / `openclaw` / `pi` / `dsh` — all fall back to `guided()` (an `unsupported` text hint), no real install

The install abstraction (`cli/init/install-methods.mjs` + `cli/init/adapters.mjs`) implicitly assumes "install == native remote marketplace". That assumption is now wrong for two agents whose plugins ship differently:

- **dsh** has no remote marketplace but *does* have a native plugin CLI that installs from an **npm package**: the Chorus dsh integration is a published npm bundle (`@chorus-aidlc/chorus-dsh`, PR #499). Its `guided()` copy even claims dsh "is not a plugin surface — use the dsh Chorus MCP installer, not chorus init", which is now factually stale.
- **openclaw**'s Chorus plugin is now published to npm (`@chorus-aidlc/chorus-openclaw-plugin`) and openclaw has a real plugin CLI (`openclaw plugins install npm:… && openclaw plugins enable …`).

The owner's core point: **do not limit "install" to the git / remote-marketplace family.** If an agent's CLI has *any* command that correctly installs its plugin, `chorus init` should call it.

## What Changes

- **Reframe the install mechanism** so "install source" is per-agent (marketplace / git / **npm package name** / **file-template**), not assumed to be a remote marketplace. npm is just another source behind each agent's own CLI — no new shared abstraction; only kiro's file-template is a genuinely new install *method*.
- **dsh** — add a real `installDsh` + `readDshInstallState`: `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`. Precheck `pnpm` on PATH; `-w` is mandatory. The `--profile <name>` is obtained by **detecting existing dsh profiles and letting the user pick** (interactive), with a non-TTY fallback. Configures only the **interactive** dsh profile — never the daemon-managed composition (`cli/dsh-spawner.mjs`).
- **openclaw** — add a real `installOpenclaw` + `readOpenclawInstallState`: `openclaw plugins install npm:@chorus-aidlc/chorus-openclaw-plugin` then `openclaw plugins enable chorus-openclaw-plugin`; guard on the package's declared `minHostVersion` (`>=2026.4.27`).
- **kiro** — add a **native, cross-platform (pure JS) file-template install method**: copy the `.kiro/` asset tree (chorus-* skills, main + reviewer agents, steering doc, hook scripts with `__CHORUS_BIN__` absolute-path substitution) into `~/.kiro/` and merge the `chorus` server into `settings/mcp.json`. Share the artifact manifest with `public/install-kiro.sh` so the two never drift. No shelling to bash (Windows-safe).
- **Replace the stale `GUIDED_MESSAGES.dsh`** and drop the guided entries for openclaw/kiro once they have real installers. **pi stays guided** (deferred) but with corrected, honest copy.
- Preserve the **VERIFIED discipline**: every hardcoded command is verified against the agent's real CLI; unverifiable commands are not guessed.

### Daemon / agent-backend classification (folded in — owner decision; see Boundary note)

The owner expanded this idea from "plugin-install adapter only" to "`chorus init` handles each selected agent end-to-end", adding a daemon-classification workstream **without consolidating the two existing registries** (owner chose the minimal shape after evaluating Multica's single-descriptor consolidation — Chorus and Multica differ too much to justify it):

- **New `agentType: "offline"`** in the daemon vocabulary (`daemon-agent.mjs` `KNOWN_AGENTS` + `agent-backend-prompt.mjs` accepted values): an agent that is in `daemon.json` (with its own validated key) purely so `chorus mcp` can proxy under its identity, but that the daemon never wakes and builds no spawner for. It is the fail-closed classification for any selected agent whose backend is not daemon-wakeable (opencode / openclaw / pi, and dsh while dormant).
- **Every selected agent → its own `daemon.json` `agents[]` entry with its own validated Chorus key** (credential-seed captures one key per selected agent), each carrying its `agentType` (a wakeable backend, or `offline`). Keys are written 0600 and never echoed.
- **The daemon-setup step reuses the init step-1 selection and does NOT re-prompt the agent backend** — `resolveInstallAgent`'s "which local agent backend?" menu is suppressed when init already supplied a selection; the `agentType` is derived from the selection.
- **The "enable daemon autostart?" prompt is gated on capability**: shown only when ≥1 selected agent is daemon-wakeable; an all-offline selection skips the prompt and the service install (nothing to wake), still persisting the `agents[]` entries.
- Borrow (cheap wins, no consolidation): 0600 + never-echo for keys; **marker-block non-destructive merge** for kiro's `settings/mcp.json`; store the bare command alongside any pinned binary path (version managers move binaries).

## Capabilities

### Modified Capabilities

- `agent-plugin-install`: broaden "install via native remote marketplace" to "install via each agent's real mechanism (marketplace / git / npm package / file-template)", and add per-agent requirements for dsh (npm + profile), openclaw (npm + enable), and kiro (file-template), plus honest guided fallback for still-unsupported agents.
- `chorus-init`: replace single-key seeding with **per-selected-agent** credential seeding into `daemon.json` `agents[]`; add "backend derived from selection, not re-prompted" and "all-offline selection skips the auto-start prompt".
- `daemon-multi-agent`: add the `offline` `agentType` — a valid, never-woken, proxy-only `agents[]` entry.

## Impact

- Code (plugin-install): `cli/init/install-methods.mjs` (new `installDsh` / `installOpenclaw` / `installKiro` + state readers, revised `GUIDED_MESSAGES`), `cli/init/adapters.mjs` (wire the three descriptors + the `supported` correction), a small `cli/init/file-template.mjs` for the kiro download+merge.
- Code (daemon classification): `cli/daemon-agent.mjs` (`KNOWN_AGENTS` + `offline` acceptance), `cli/agent-backend-prompt.mjs` (offline in the accepted set), `cli/init/steps/credential-seed.mjs` (per-selected-agent keys), `cli/init/steps/daemon-setup.mjs` (reuse selection, capability-gate the auto-start prompt), the spawner-select path (never wake `offline`).
- Tests: `cli/__tests__/init-plugin-install.test.mjs`, `init-credential-seed.test.mjs`, `init-daemon-setup.test.mjs`, `init-integration.test.mjs`.
- Docs: `docs/CONNECT_DSH.md` / `CONNECT_KIRO.md` / openclaw README already document the manual commands this automates — cross-check for parity.
- Out of scope: consolidating the init + daemon agent registries into one descriptor (owner chose minimal/no-merge); the daemon-managed dsh composition path (sibling daemon-setup idea a7c2a3e8); pi automation (needs `@chorus-aidlc/chorus-pi` publishing + a monorepo-subdir remote source first).
- Boundary note: this supersedes Round-1 elaboration's "interactive surface only, don't touch daemon flow" — the owner folded the daemon-classification work in via Round-2 elaboration.
