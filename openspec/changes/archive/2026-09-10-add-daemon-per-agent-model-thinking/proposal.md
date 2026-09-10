## Why

One `chorus daemon` process can already serve N fully independent agents — own `cho_` key/persona, own cwds, own backend, own permission mode, own concurrency cap. It cannot give them their own **model** or their own **thinking / reasoning effort**: those leak to machine-global harness configuration (`ANTHROPIC_MODEL` + `~/.claude/settings.json` for claude-code, `~/.codex/config.toml` for codex, `CHORUS_DSH_MODEL` / `DSH_MODEL` for dsh, pi's own settings for pi).

The practical consequences:

- An operator who wants one deep-reasoning agent and one cheap/fast agent must run **two daemons** (separate `HOME`, because `daemon.json` / `daemon.pid` hang off `homedir()`) or fall back to claude-code-only project settings (`.claude/settings.json` inside the served cwd). Neither works for codex/pi agents.
- Writing the obvious keys into an `agents[]` entry **does nothing and says nothing**: `resolveAgentConfigs` reads a fixed field whitelist (`cli/daemon-config.mjs:317-330`), so `"model": "opus"` is silently dropped — the operator believes it took effect.

Upstream demand is tracked in Chorus-AIDLC/Chorus#549. This change delivers it for the local fork.

## What Changes

- **Two new per-agent fields.** `agents[]` entries accept an optional, non-secret `model` and `thinking` (both non-empty strings). The same two keys at the top level act as **defaults**, with exactly the merge semantics of every other per-agent field (per-agent value wins, omitted field inherits, absent-and-no-default ⇒ today's behavior byte-for-byte). A `daemon.json` **without** an `agents[]` array (the legacy flat single-agent shape) resolves those top-level keys too — otherwise a flat install would hit the very silent-ignore bug this change removes.
- **Per-backend flag delivery**, on both the daemon wake path and the foreground `chorus agents run` path:

  | `agentType` | `model` → | `thinking` → |
  |---|---|---|
  | `claude-code` | `--model <v>` | `--effort <v>` |
  | `pi` | `--model <v>` | `--thinking <v>` |
  | `codex` | `-m <v>` | `-c model_reasoning_effort=<v>` |
  | `dsh`, `kiro`, `offline` | _(not delivered — documented unsupported in v1)_ | _(same)_ |

- **Structural validation only.** A present `model` / `thinking` must be a non-empty string; otherwise the daemon exits non-zero naming the offending agent **and** the field (mirrors the existing `permissionMode` validation precedent). The **value** is never validated or normalized — it is passed through verbatim and the backend harness is the thing that accepts or rejects it (matching the "no silent fallback" contract of `daemon-multi-agent`).
- **No silent drop for unsupported backends.** An agent whose backend does not receive these fields (`dsh` / `kiro` / `offline`) with a `model` or `thinking` configured gets one visible warning line at startup naming the agent, so the configuration gap cannot be mistaken for an applied setting.
- **Foreground parity.** `chorus agents run` applies the selected agent's `model` / `thinking` too, so the same `daemon.json` entry behaves identically in the terminal and under the daemon. Tokens after `--` still win: when the passthrough already carries the corresponding flag, the launcher does not inject its own.
- **Observability.** The per-agent startup line, the single-agent startup banner, and the `chorus agents run` launch line print `model` / `thinking` when set.
- **Docs.** `docs/DAEMON.md` per-agent field table + per-backend delivery section document both fields, their values-by-backend, and the unsupported backends.

## Capabilities

### New Capabilities

<!-- None — this extends two existing capabilities. -->

### Modified Capabilities

- `daemon-multi-agent`: the per-agent configuration requirement now lists `model` / `thinking` (with the structural-validation contract), and a new requirement defines per-backend delivery of the two fields plus the unsupported-backend warning.
- `cli-agent-launch`: a new requirement defines applying the selected agent's `model` / `thinking` to the foreground launch, including the passthrough-wins precedence rule.

## Impact

- **Config resolution** — `cli/daemon-config.mjs` (`AgentConfig` typedef + `resolveAgentConfigs`, per-agent override, top-level default, structural validation, flat back-compat path).
- **Wake path** — `cli/daemon.mjs` (per-agent deps handed to each agent runtime + the per-agent startup line), `cli/spawner-select.mjs` (forward the two fields to the spawner).
- **Spawners** — `cli/claude-spawner.mjs` (`buildArgs`), `cli/pi-spawner.mjs` (`buildPiArgs`), `cli/codex-spawner.mjs` (`buildCodexArgs`, both the new-run and `exec resume` shapes). `cli/dsh-spawner.mjs` / `cli/kiro-spawner.mjs` are deliberately untouched.
- **Foreground launch** — `cli/credentials.mjs` (`resolveLaunchAgent` carries the two fields), `cli/agent-launcher.mjs` (prepend mapped flags before the verbatim passthrough).
- **Docs/spec** — `docs/DAEMON.md`; this change's spec deltas for `daemon-multi-agent` + `cli-agent-launch`.
- **Tests** — `cli/__tests__/daemon-multi-agent-config.test.mjs`, `claude-spawner.test.mjs`, `pi-spawner.test.mjs`, `codex-spawner.test.mjs`, `agent-launcher.test.mjs`.
- **No** server/Prisma/UI change, **no** new dependency, **no** breaking change: the config surface is purely additive, and an existing `daemon.json` resolves to byte-identical argv/env.
