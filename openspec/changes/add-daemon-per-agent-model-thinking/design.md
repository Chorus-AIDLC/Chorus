## Overview

Give each `agents[]` entry its own model and thinking/reasoning-effort level, delivered as the backend's own command-line flags by the daemon's spawners. The daemon stays a **pass-through**: it maps two neutral field names onto per-backend flags and forwards the values verbatim — it never normalizes one backend's vocabulary into another's, and never validates a value against a list it would then have to track as the harnesses evolve.

Scope for v1 is the three backends with **verified** flags: `claude-code`, `pi`, `codex`. `dsh` and `kiro` accept the fields in configuration but do not receive them (one visible warning line at startup), because no parameter for either could be verified in this environment.

## Architecture

```
~/.chorus/daemon.json
  { "model": <default>, "thinking": <default>,
    "agents": [ { "label": ..., "apiKey": ..., "agentType": "claude-code",
                  "model": "opus", "thinking": "high" }, ... ] }
        │
        ▼
resolveAgentConfigs()            cli/daemon-config.mjs
  • per-agent override over top-level default
  • structural validation: present ⇒ non-empty string, else throw naming agent+field
        │  AgentConfig { model?, thinking? }
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
buildMultiAgentDaemon()          cli/daemon.mjs   runDaemon() flat branch (no agents[])
  • per-agent deps: permissionMode / agentType /      • resolves the file's top-level
    cwds / maxConcurrency / sigintTimeoutMs /           model/thinking and passes them
    browseRoots / model / thinking                      into buildDaemon deps
  • startup line per agent: … <backend>,              • banner rows: Model / Thinking
    <permissionMode>, N path(s),                      • non-zero exit on an invalid value
    maxConcurrency=N[, model=<v>][, thinking=<v>]       (same validation contract)
        │                                                       │
        └───────────────────────┬───────────────────────────────┘
                                ▼
selectSpawner(agentType, { …, model, thinking })     cli/spawner-select.mjs
  ├── ClaudeSpawner.wake → buildArgs({ …, model, thinking })   → --model / --effort
  ├── PiSpawner.wake     → buildPiArgs({ …, model, thinking }) → --model / --thinking
  ├── CodexSpawner.wake  → buildCodexArgs({ …, model, thinking })
  │                                                          → -m / -c model_reasoning_effort=
  ├── KiroSpawner        → unchanged (fields not delivered)
  └── DshSpawner         → unchanged (fields not delivered)
```

The foreground counterpart mirrors the same mapping over the same config entry:

```
chorus agents run --name <agent> [-- <verbatim args…>]
  resolveLaunchAgent()          cli/credentials.mjs   → carries model/thinking
  runAgentLaunch()              cli/agent-launcher.mjs
    argv = [ ...mappedModelFlags, ...passthrough ]     (passthrough wins on collision)
```

## Data Model

No database change. The "data model" here is the `daemon.json` config shape.

```jsonc
{
  "url": "https://chorus.example.com",
  "model": "sonnet",            // optional default for every agent below
  "thinking": "medium",         // optional default for every agent below
  "agents": [
    {
      "label": "dev",
      "apiKey": "cho_…",
      "agentType": "claude-code",
      "cwds": ["/home/me/projA"],
      "model": "opus",          // overrides the top-level default for THIS agent
      "thinking": "high"
    },
    {
      "label": "cheap",
      "apiKey": "cho_…",
      "agentType": "pi",
      "cwds": ["/home/me/projB"],
      "model": "anthropic/claude-haiku-4-5",
      "thinking": "low"
    }
  ]
}
```

Field contract (identical shape to every other per-agent field):

| Field | Type | Required | Semantics |
|---|---|---|---|
| `model` | non-empty string | no | Backend model id/alias, forwarded verbatim. Absent ⇒ backend's own default resolution (today's behavior). |
| `thinking` | non-empty string | no | Backend thinking/reasoning-effort level, forwarded verbatim. Absent ⇒ backend default. |

Validation rules:

1. A **present** `model` / `thinking` that is not a non-empty string ⇒ `resolveAgentConfigs` throws `Agent <label>: invalid <field> …` ⇒ the daemon exits non-zero (consistent with the existing `permissionMode` precedent, and with the "never silently drop or fall back" clause of the `daemon-multi-agent` spec).
2. An **absent** field inherits the top-level default; if there is none, nothing is passed to the backend.
3. The **value** is never checked against a whitelist. A typo surfaces as the harness's own startup error (visible in the daemon log / turn transcript), not as a daemon-side rejection.

Backend vocabulary (informative — the daemon does not enforce it; verified against the harness CLIs/docs during design):

| Backend | `model` examples | `thinking` accepted by the harness |
|---|---|---|
| claude-code | alias (`opus`, `sonnet`, `haiku`, `default`), full model id | `low` \| `medium` \| `high` \| `xhigh` \| `max` (+ `ultracode`); a level the active model does not support falls back to the highest supported level at or below it |
| pi | `provider/id` (e.g. `anthropic/claude-sonnet-4-5`) | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| codex | model id / `provider/id` | catalog-driven (`supported_reasoning_levels[].effort` in the model catalog; e.g. `low` \| `high` \| `max`) |

## Module Contracts

- **`resolveAgentConfigs` (cli/daemon-config.mjs)** — returns `AgentConfig[]`; two new optional string members `model` / `thinking`. Both merge paths (flat back-compat, `agents[]`) populate them. Validation is structural only and throws an `Error` naming the agent **and** the offending field so the daemon's top-level handler turns it into a non-zero exit.
- **Wake-path hand-off (cli/daemon.mjs → cli/spawner-select.mjs → spawner)** — the two values travel as plain `model` / `thinking` strings in the spawner options object. A spawner that does not support them simply ignores them (it must not throw, so one unsupported agent can never take down a daemon serving supported ones).
- **Spawner argv builders** — pure functions, extended with `model` / `thinking`:
  - `buildArgs({ sessionId, isNew, mcpConfigPath, permissionMode, model, thinking })` → appends `--model <v>` and/or `--effort <v>`.
  - `buildPiArgs({ sessionId, model, thinking })` → inserts `--model <v>` and/or `--thinking <v>` **before the trailing `-p`**. pi's arg parser slurps the next bare token after `-p` as a message, so `-p` MUST stay last (`cli/pi-spawner.mjs` documents this; `pi-spawner.test.mjs` asserts it).
  - `buildCodexArgs({ isNew, threadId, permissionMode, model, thinking })` → appends `-m <v>` and/or `-c model_reasoning_effort=<v>` in **both** shapes (fresh `exec` and `exec resume <id>`).
  - Flag order is fixed and test-assertable: daemon-owned base flags first, then `model`, then `thinking` — with pi's `-p` remaining the final token.
- **Flat-path delivery (no `agents[]`)** — the single-agent branch resolves the file-level `model`/`thinking` through the same resolver and passes them into `buildDaemon` deps, so a legacy flat `daemon.json` with a top-level `model` is honored rather than silently ignored (the exact bug class this change exists to remove). Its startup banner gains `Model` / `Thinking` rows; an invalid value fails the same way as in multi-agent mode.
- **`chorus agents run` precedence** — the mapped flags are prepended before the verbatim passthrough. If the passthrough already carries a flag for the same knob (`--model`, `--effort`, `--thinking`, `-m`, `-c model_reasoning_effort=…`), the launcher injects nothing for that knob, so the explicit user argument is the one the backend sees and no last-wins ambiguity is introduced. The launch diagnostics name the resolved `model` / `thinking` when set.
- **`resolveLaunchAgent` (cli/credentials.mjs)** — carries the selected entry's `model` / `thinking`, resolving a value the entry omits from the file's top-level default, exactly as the daemon's resolver does.
- **Unsupported-backend visibility** — when an agent whose `agentType` is not in the v1 delivery set has `model` or `thinking` set (directly or by top-level default), the daemon logs one warning line naming the agent, the field, and the backend. The value is not delivered and startup does not fail.

## Implementation Plan

1. **Resolver** — extend the `AgentConfig` typedef, add an `optionalNonEmptyString`-style helper (throw on present-but-invalid), merge in both paths, extend the existing multi-agent resolver tests (override, default inheritance, invalid value, flat back-compat).
2. **Wake path** — thread the two fields through the per-agent deps and `selectSpawner`; extend each spawner's argv builder + its unit test (including pi's `-p`-stays-last ordering); extend the per-agent startup line; thread the flat single-agent path's resolved values into `buildDaemon` + the startup banner.
3. **Foreground parity** — carry the fields through `resolveLaunchAgent`, map them in `runAgentLaunch` with the passthrough-wins rule, extend the launcher test.
4. **Docs + end-to-end** — `docs/DAEMON.md` field/delivery tables; then a real `chorus daemon` run with two agents on different models/levels against the local server, checking the startup lines and a live turn; then `openspec archive` + spec mirror.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Flag names drift with harness releases (e.g. claude's effort flag, codex's config key) | Tests assert the **argv shape** the daemon produces, not the harness's own parsing; the values are pass-through, so a renamed harness flag is a docs+map update in one place per backend, never a value-validation change |
| A level the model does not support | Deliberately not validated: the harness clamps or errors (claude-code clamps to the highest supported level ≤ the requested one), which keeps the daemon ignorant of model catalogs |
| `dsh` / `kiro` cannot deliver the fields (unverifiable here) | Documented as unsupported + a visible startup warning; the (already existing) `initialize.params.model` dsh field is noted in `docs/DAEMON.md` as a future extension point rather than wired blind |
| Silent no-op regression (the bug this change fixes) | Structural validation throws on a present-but-invalid value; the unsupported-backend case warns; tests assert that a configured value actually reaches the argv |
| Foreground/daemon divergence | One mapping table, two call sites, one shared test matrix (claude/pi/codex × model/thinking × unset) |
| Back-compat break for existing installs | Absent fields produce no argv/env delta; the existing `daemon-multi-agent` tests stay green unchanged |
