# Prompt for agent type (backend) in daemon add / login / install flows

## Why

The daemon can serve multiple agents from one process (`agents[]` in
`~/.chorus/daemon.json`), and it already spawns a **per-agent backend**: each
`agents[]` entry may carry its own `agentType`, and at runtime the daemon
selects a spawner per entry (`cli/daemon-config.mjs` reads `entry.agentType`;
`cli/daemon.mjs` injects a per-agent `selectSpawner`). Mixing backends in one
daemon — e.g. one Claude Code + one Codex — is therefore fully functional.

The gap is purely in the **credential-capture UX**: the commands that add or
first-configure an agent only ever prompt for **Chorus URL** and **API key**,
never for which backend the agent should use:

- `chorus login` (single-agent first setup) — never asks, never persists a
  backend, and ignores `--agent` entirely.
- `chorus login --add` / `chorus daemon add` (append an agent) — prompts only
  URL + key; writes `agentType` **only** when `--agent` was passed on the
  command line, never interactively.
- `chorus install`'s "Add another agent?" loop — calls `appendAgent({ url,
  apiKey, agentUuid, agentName })` with **no** `agentType` at all, and does not
  read `--agent`.

Consequently every agent added through these flows silently falls back to the
daemon's top-level default backend (claude-code unless a daemon-level `--agent`
overrides). The multi-backend capability the daemon already has cannot be
reached from the supported setup commands — which is exactly the scenario
multi-agent mode is most useful for.

## What Changes

Capture the agent backend at credential-add / first-login time, reusing the
**existing** interactive backend menu so the two paths never drift:

- Extract the numbered backend menu (currently a private `AGENT_MENU` +
  inline prompt inside `resolveInstallAgent`) into one shared prompt helper
  that returns a chosen backend **or `undefined`** when the operator presses
  Enter / declines. `resolveInstallAgent` is refactored to consume the shared
  menu with no behavior change.
- `chorus login` (single-agent) and `chorus login --add` / `chorus daemon add`
  gain an interactive backend prompt on a TTY, and honor the existing
  `--agent` flag for non-interactive use.
- `chorus install`'s "Add another agent?" loop gains the same prompt (and
  honors `--agent`).
- Selection is persisted where the runtime already reads it: the single-agent
  path writes the top-level `agent` field; the append paths write the entry's
  `agentType`.

**Default when the operator makes no choice** (plain Enter, no `--agent`, or a
non-TTY run): write **nothing**. An empty `agentType` on an appended entry
inherits the daemon's top-level default at resolve time; an empty top-level
`agent` resolves to claude-code. This is the least-surprising behavior and
matches the current outcome — the only change is that the operator is now
*asked*.

The interactive menu deliberately reuses the shared `AGENT_MENU` list, which
today advertises **claude-code / codex / kiro** (the `dsh` backend is
temporarily de-advertised); dsh reappears in every prompt automatically the day
the menu re-advertises it — no second edit.

## Capabilities

- `daemon-add-agent-type` (new): the daemon credential-add / first-login /
  install-add commands MUST offer an agent-backend selection (interactive menu
  on a TTY, `--agent` flag otherwise), persist it to the location the runtime
  reads, and inherit the daemon default when the operator makes no choice.

## Impact

- **Code:** `cli/login.mjs` (`runLogin` — both single and `--add` branches),
  `cli/daemon-install-config.mjs` (extract `AGENT_MENU`; wire the add-loop),
  and a new shared prompt module imported by both. `cli/daemon-agent.mjs`
  (`KNOWN_AGENTS`, `DEFAULT_AGENT`) and `cli/daemon-config.mjs` (per-agent
  `agentType` resolution) are unchanged — the runtime is already ready.
- **Help text:** `cli/client-args.mjs` login/daemon usage notes that `--agent`
  applies to the add flows too.
- **Config format:** unchanged. Reads the existing top-level `agent` and
  per-entry `agentType` fields; no migration.
- **Back-compat:** the default (no selection → inherit) reproduces today's
  behavior byte-for-byte, so existing scripts and non-TTY installs are
  unaffected. No GUI is involved (CLI-only), so `docs/design.pen` is not
  touched.
