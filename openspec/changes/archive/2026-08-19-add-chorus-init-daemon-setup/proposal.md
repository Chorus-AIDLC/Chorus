# Proposal: `chorus init` daemon-setup step + real cross-platform auto-start

## Why

The `chorus init` foundation (shipped) already detects coding agents, seeds the
Chorus URL + API key once into the centralized `~/.chorus/daemon.json`, and
installs each agent's plugin. Its step registry explicitly reserves a slot for a
**daemon-setup** step (this change) so a machine can go from "nothing" to "a
Chorus daemon running and auto-starting on boot" in one command.

Today that last mile is manual: after `chorus init` the user still has to run
`chorus daemon install` themselves, and on macOS that command only *prints* a
launchd template — it never actually installs a boot service. So the smoothest
onboarding path stops short of a running, boot-persistent daemon on two of the
three target platforms.

This change closes that gap: `chorus init` gains an opt-in daemon-setup step, and
the underlying `daemon install` becomes a **real** boot-service install on macOS
(launchd), not just Linux (systemd).

## What Changes

- **New `chorus init` daemon-setup step** (`once`-scoped, ordered after
  credential-seed and plugin-install). It:
  - Runs the same full preflight as `chorus daemon install` — resolves/persists
    credentials **plus** the served working-directory set (`cwds`) and the
    default backend agent — so the installed service is usable out of the box.
  - Offers an **opt-in** "auto-start the daemon on boot?" choice, **defaulting to
    No** in a TTY.
  - Only offers auto-start where the platform actually supports it (Linux systemd
    or macOS launchd). On an unsupported platform it still writes `daemon.json`
    and prints the manual start steps, never a broken service.
  - In a non-interactive / CI run it installs the boot service only when an
    explicit `--daemon-autostart` flag is passed; otherwise it writes
    `daemon.json` and skips the service (never guesses).
  - On accept, installs **and enables** the boot service (starts now and at every
    boot).
  - Is idempotent: a re-run where the service is already installed reports
    "already configured" and skips, repairing only on drift.

- **Real macOS launchd install/uninstall** for `chorus daemon install` /
  `uninstall` — writes the LaunchAgent plist to `~/Library/LaunchAgents/` and runs
  `launchctl load -w` / `unload -w`, mirroring the Linux systemd path (validate,
  surface failures non-zero, no silent success). Windows/other stays a printed
  template. This is what makes the init auto-start option real on macOS.

- **Platform auto-start capability classification** — a single helper that
  classifies the host as `systemd` | `launchd` | `unsupported`, so both the init
  step and `daemon install` agree on what "supported" means. Supervisor detection
  is extended to recognize an installed launchd LaunchAgent (not just systemd).

- **launchd lifecycle delegation** — `chorus daemon status` / `stop` / `restart` /
  `logs` recognize a loaded launchd service on macOS and delegate to `launchctl`,
  so a real macOS boot service is manageable through the CLI rather than being
  misreported via the pidfile path.

## Capabilities

- `chorus-init` — ADDED: "Optional daemon auto-start step in `chorus init`".
- `daemon-background-lifecycle` — MODIFIED: "Supervisor service install /
  uninstall" (macOS becomes a real launchd install); ADDED: "Platform auto-start
  capability classification"; ADDED: "macOS launchd lifecycle delegation".

## Non-goals / Boundaries (owner decisions, elaboration Round 1)

- **Credential model is connection-only.** `daemon.json` continues to hold only
  the Chorus URL + API key. This change does **not** add a provider-secrets /
  `env` block and does **not** inject `AWS_*` / `ANTHROPIC_*` / Bedrock secrets
  into the service unit. Provider credentials remain inherited from the daemon
  process environment; for a clean-env boot service the operator is responsible
  for supplying them (documented, with concrete guidance, in `design.md`).
- **MCP-proxy boundary.** This change only guarantees `daemon.json` is the single
  credential source and introduces no per-agent secret injection. The `chorus mcp`
  proxy that consumes those credentials is sibling idea cc115e6b — out of scope.
- **Windows auto-start is out of scope.** Windows remains "unsupported for
  auto-start" (write `daemon.json` + print manual steps). Only Linux systemd and
  macOS launchd are real auto-start targets this version.

## Impact

- New file: `cli/init/steps/daemon-setup.mjs`; new flag `--daemon-autostart` in
  `cli/init-args.mjs`; registration in `cli/init/registry.mjs`.
- Modified: `cli/daemon-service.mjs` (real launchd install/uninstall + capability
  classification + launchd-aware supervisor detection), `cli/daemon.mjs`
  (lifecycle delegation to launchctl on darwin).
- No database, API, or web-UI change. No new runtime dependency (pure Node, no
  native bindings, no `shell:true`).
- Docs: `chorus init` help text and the chorus skill docs (standalone + plugin)
  gain the daemon-setup step, the `--daemon-autostart` flag, and the
  provider-credential note.
