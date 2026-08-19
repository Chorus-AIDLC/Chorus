# Technical Design: agent-type prompt in add / login / install flows

## Overview

Add a single shared "which backend?" prompt and wire it into the three
credential-capture entry points. No runtime/spawn changes — the daemon already
resolves and spawns a per-agent backend from `agent` (top-level default) and
per-entry `agentType`. This change only fills the capture gap.

## Current state (verified)

- `cli/daemon-install-config.mjs`
  - `AGENT_MENU` (private const): `[{claude-code, "…(default)"}, {codex}, {kiro}]`
    — `dsh` intentionally omitted (de-advertised, offline).
  - `resolveInstallAgent(flags, env, opts)`: resolves the **daemon-level**
    backend (`--agent` > `CHORUS_AGENT` > stored `agent` > TTY menu > default),
    persists top-level `agent`, probes the CLI. The install *first* agent is
    thus already covered; only the "Add another agent?" loop (≈ lines 143-171)
    is missing the prompt — it calls `appendAgent({url,apiKey,agentUuid,agentName})`.
- `cli/login.mjs`
  - `runLogin(flags, deps)`: prompts URL + key. `--add` branch sets
    `agentObj.agentType` only when `flags.agent` is non-empty; the single-agent
    branch writes `{url,apiKey,agentUuid,agentName}` and never touches backend.
  - `appendAgentConfig(agentObj, deps)`: accepts an optional `agentType` field
    and writes it verbatim into the new `agents[]` entry — no change needed.
- `cli/daemon-agent.mjs`: `KNOWN_AGENTS = [claude-code, codex, kiro, dsh]`,
  `DEFAULT_AGENT = claude-code`. `resolveAgentType` falls back
  flag>env>file>default; unknown values are a hard error.
- `cli/daemon-config.mjs`: per-entry `agentType` else top-level default; unknown
  `agentType` is a hard error. Empty per-entry `agentType` → inherits top-level.

## Architecture

### New module: `cli/agent-backend-prompt.mjs`

Owns the menu list and the interactive selection so both `login.mjs` and
`daemon-install-config.mjs` share one source of truth (avoids an import cycle:
`daemon-install-config.mjs` already imports `appendAgentConfig` from
`login.mjs`, so the menu cannot live in either file).

```
export const AGENT_MENU = [ {value,label}, … ]   // moved verbatim from daemon-install-config

// Interactive numbered menu. Returns the chosen backend value, or undefined
// when the operator presses Enter / declines / it is not a TTY.
export async function promptAgentBackend({ ask, log, isTTY }) : Promise<string|undefined>
```

Contract:
- **Not a TTY** (or `isTTY` false) → return `undefined` immediately, print
  nothing, never block.
- **TTY** → print the same numbered list `resolveInstallAgent` prints. Read one
  line.
  - Empty (Enter) → `undefined` (**inherit default** — the answer to the
    "default" elaboration question).
  - A valid number `1..N` → that row's `value`.
  - A KNOWN_AGENTS value typed by name (muscle memory) → that value.
  - Anything else → `undefined` (treated as "no explicit choice"; do not error,
    do not loop — the caller's default/inherit path takes over).

> Difference from `resolveInstallAgent`'s inline menu: there, empty/garbage
> falls to `DEFAULT_AGENT` because the daemon-level `agent` must always be
> concrete. Here, empty/garbage returns `undefined` so callers can *omit* the
> field and let resolve-time inheritance apply. This is the deliberate
> semantic for the add flows.

### `resolveInstallAgent` refactor (no behavior change)

Import `AGENT_MENU` from the new module instead of the local const; delete the
local copy. Its own empty/garbage → `DEFAULT_AGENT` logic stays exactly as-is
(it does NOT use `promptAgentBackend`, whose undefined-on-empty semantics differ).
Existing `resolveInstallAgent` tests must still pass unchanged.

### `runLogin` wiring (`cli/login.mjs`)

After URL + key are collected and validated, resolve the backend once:

```
let agentType = nonEmpty(flags.agent);              // explicit flag wins
if (!agentType) agentType = await promptBackend({ ask, log, isTTY });  // TTY menu, else undefined
```

- `isTTY` comes from a new injectable dep (default `process.stdin.isTTY`), so
  a non-TTY / piped login never blocks on the menu — mirrors `resolveInstallAgent`.
- Inject `promptBackend` as `deps.promptBackend` (default the shared
  `promptAgentBackend`) for unit testing.

**`--add` branch:** set `agentObj.agentType = agentType` only when defined
(unchanged behavior when `--agent` was passed; new behavior via the menu). When
`undefined`, omit the field → entry inherits daemon default.

**Single-agent branch:** pass `agent: agentType` into `writeLoginFile` only when
defined so the top-level `agent` field is written; when `undefined`, write
nothing (resolves to claude-code). `writeLoginFile`/`updateDaemonConfig` already
merge partial fields, so adding `agent` to the payload is additive.

> `--agent` is already parsed by `client-args.mjs` into `flags.agent`; the value
> is validated downstream by `resolveAgentType` at daemon start (unknown → hard
> error), so `runLogin` does not need to re-validate. It MAY echo the chosen
> backend in its success line for confirmation.

### install add-loop wiring (`cli/daemon-install-config.mjs`)

Inside the existing `for` loop, after `u`/`k` are read and validated, before
`appendAgent(...)`:

```
let at = nonEmpty(flags.agent);
if (!at) at = await promptAgentBackend({ ask, log, isTTY });
const agentObj = { url: u, apiKey: k, agentUuid: id.uuid, agentName: id.name };
if (at) agentObj.agentType = at;
appendAgent(agentObj);
```

`isTTY`/`ask` are already in scope in this loop. When `at` is undefined the entry
omits `agentType` and inherits the daemon default (the install's own
`resolveInstallAgent` result).

## Module Contracts

- **Selection → persistence mapping:** append flows write per-entry
  `agentType`; single-agent login writes top-level `agent`. Both fields already
  exist and are read by `resolveAgentType` / the multi-agent normalizer.
- **"No choice" sentinel:** `promptAgentBackend` returns `undefined`. Every
  caller MUST treat `undefined` as "omit the field / inherit", never as a
  literal string. No caller writes `"claude-code"` on an empty selection.
- **Menu source of truth:** callers never hardcode the backend list; they import
  `AGENT_MENU`. Adding/removing a backend (e.g. re-advertising `dsh`) is a
  one-line edit in `agent-backend-prompt.mjs` that all prompts pick up.

## Testing

Vitest, existing thresholds (95% lines / 85% branches). Mock stdin via injected
`ask`/`isTTY`/`promptBackend` seams — no real TTY.

- `agent-backend-prompt` unit: menu text lists `AGENT_MENU` rows; Enter →
  `undefined`; `"2"` → `codex`; `"codex"` by name → `codex`; out-of-range /
  garbage → `undefined`; `isTTY:false` → `undefined` with no prompt call.
- `runLogin`: `--agent codex --add` → entry `agentType:"codex"`; menu pick in
  `--add` → `agentType` set; Enter in `--add` → no `agentType` key; single-agent
  `--agent kiro` → top-level `agent:"kiro"`; single-agent Enter → no `agent`
  key; non-TTY (no flag) → no prompt, no backend written; duplicate-key refusal
  path unchanged.
- install add-loop: menu pick → appended entry carries `agentType`; Enter → no
  `agentType`; `--agent` honored; validation-fail / duplicate skip paths
  unchanged.
- `resolveInstallAgent`: existing suite passes unchanged after the `AGENT_MENU`
  import move.

## Risks & Mitigations

- **Blocking a non-TTY login on the new menu.** Mitigation: `isTTY` guard in
  both `promptAgentBackend` and `runLogin`; default from `process.stdin.isTTY`;
  covered by a non-TTY test.
- **Import cycle** (`login.mjs` ↔ `daemon-install-config.mjs`). Mitigation: menu
  lives in the standalone `agent-backend-prompt.mjs`; neither importer imports
  the other for it.
- **Pinning an explicit backend that then differs from a later daemon `--agent`
  default.** Accepted: explicit selection is intentional and wins; only the
  *empty* selection inherits. Documented in the "No choice" contract.
- **dsh confusion** (elaboration mentioned dsh, menu omits it). Mitigation:
  reuse `AGENT_MENU` verbatim; do not re-add dsh here.

## Out of scope

- Editing an existing agent's backend via a command (elaboration answer:
  add-time only; hand-edit `daemon.json`).
- Any change to how the daemon resolves/spawns backends at runtime.
