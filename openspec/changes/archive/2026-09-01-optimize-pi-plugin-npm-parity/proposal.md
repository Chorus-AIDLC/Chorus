# Optimize the Pi Plugin: CC Parity + Standalone npm Package + Wakeable Daemon Backend

## Why

The Chorus **Pi** plugin (`@chorus-aidlc/chorus-pi`) already exists in `packages/chorus-pi/` — a `chorus.ts` extension, 11 skills, and 3 reviewer agents — but it is not production-grade:

- **Not published / hard to install.** It is workspace-excluded (`!packages/chorus-pi` in `pnpm-workspace.yaml`), absent from the coordinated npm release manifest, and version-drifted (0.17.0 vs app 0.17.1). Users install it by local path or a sparse git checkout, because pi cannot select a monorepo subdirectory from a git source (`pi install git:.../Chorus` loads the root `package.json`). The archived `broaden-init-plugin-install` change explicitly parked pi automation behind "needs `@chorus-aidlc/chorus-pi` publishing first" — this proposal is that prerequisite.
- **Behind the Claude Code (CC) plugin on features.** It depends on the third-party `@narumitw/pi-subagents` for reviewer subagents, requires a **manual copy** of `agents/*.md` into `~/.pi/agent/agents/` (pi manifests cannot declare agents), and is **missing the `brainstorm` skill** the CC plugin ships.
- **Not remotely wakeable.** pi is classified `offline` in the daemon (`agent-type-map.mjs`), so there is no `--agent pi` backend and the daemon cannot wake a pi session on remote dispatch — pi users get no reversed-conversation loop.

The six elaboration decisions on idea `76b27ec2` set the direction; this proposal executes them.

## What Changes

Grouped into four capabilities (each a delta spec + one Chorus task):

**A. Distribution (`pi-plugin-distribution`).** Give `chorus-pi` a publishable shape modeled on the dsh package: `publishConfig.access=public`, a `files` allowlist, `.npmignore`, `repository.directory`, version synced to the app version, and `check:package` / `check:pack` validation scripts. Publish **TypeScript source as-is** (pi loads `.ts` via jiti — no build/`dist` step). Re-add the package to the pnpm workspace **without** re-triggering the dashboard `tsc` build that caused its original exclusion (#458). Add it as the **4th** package in `scripts/coordinated-npm-release/manifest.json` and extend the hardcoded `expectedPackages` guard in `lib.mjs` (plus the release-contract test) so the CI publish flow builds and publishes it in lockstep.

**B. CC parity (`pi-plugin-parity`).** Replace `@narumitw/pi-subagents` with pi's **official subagent reference pattern** (from `examples/extensions/subagent/`: a child-`pi` spawn tool + Markdown agent defs). Make agent discovery **package-relative** so the 3 reviewer agents load directly from the package's own `agents/` dir with **zero manual copy**. Add the missing **`brainstorm`** skill (ported from the CC plugin). Skip Claude-only hooks (plan-mode Enter/Exit, TeammateIdle, TaskCompleted) — they have no pi analog; functional parity only.

**C. Wakeable daemon backend (`pi-daemon-backend`).** Promote pi from `offline` to a first-class wakeable backend: add `pi` to `KNOWN_AGENTS`, a new `cli/pi-spawner.mjs` implementing the shared `Spawner.wake(...)` contract (headless `pi --mode json -p` + client-owned `--session-id` for per-anchor resume; prompt over stdin; NDJSON event parse; creds exported into the child env), wire `selectSpawner`, `backendCli`, `backendClientType`, and `agent-type-map.mjs` (pi → `pi`), and add `"pi"` to the server's `DAEMON_CLIENT_TYPES` allowlist. pi has **no permission system**, so no sandbox/skip-permissions flag is needed (`permissionMode` is a no-op for pi).

**D. init integration (`pi-init-integration`).** Now that the package is npm-installable and pi is wakeable, flip pi in `chorus init` from a **guided** (manual-instructions) adapter to an **automated** install (`pi install npm:@chorus-aidlc/chorus-pi`), and update `docs/CONNECT_PI.md`.

## Impact

- **Affected packages:** `packages/chorus-pi/` (package.json, extension, skills, agents, README), root `pnpm-workspace.yaml`.
- **Affected release tooling:** `scripts/coordinated-npm-release/manifest.json`, `lib.mjs`, its `__tests__`, and the `release` / `plugin-maintenance` skill checklists.
- **Affected daemon/server:** `cli/daemon-agent.mjs`, new `cli/pi-spawner.mjs`, `cli/spawner-select.mjs`, `cli/init/agent-type-map.mjs`, `cli/init/adapters.mjs`, `src/services/daemon-connection.service.ts` (+ test).
- **Affected docs:** `docs/CONNECT_PI.md`, `packages/chorus-pi/README.md`.
- **Out of scope:** emulating Claude-only hooks; any change to the CC/Codex/Kiro/dsh/OpenClaw ports beyond what parity porting of the `brainstorm` skill requires.
- **Risk:** pi has no native MCP — a woken pi session reaches Chorus tools only through the chorus-pi extension / `pi-mcp-adapter`, so the wakeable backend (C) presumes the extension (A/B) is installed in the woken environment. Publishing (A) + init automation (D) make that reliable.
