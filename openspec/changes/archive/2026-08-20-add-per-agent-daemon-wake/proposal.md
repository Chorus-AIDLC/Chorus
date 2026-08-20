## Why

PR #506 encoded "should the daemon wake this agent?" directly into `agentType`: a daemon-capable backend (claude/codex/kiro) got its real `agentType`, a daemon-incapable one got `offline`. That conflates two orthogonal facts:

1. **Backend capability** — can this backend be woken by the daemon *at all*? (pi / opencode / openclaw / dormant dsh cannot.)
2. **Operator intent** — even for a capable backend, does the operator want the daemon to wake *this* agent that they just added?

The owner (real-host test of #506) wants an added agent to default to **not woken**, opting in explicitly — and finds overloading `agentType` for this confusing.

## What Changes

- **Keep the `offline` `agentType`**, narrowed to mean strictly "the backend does not support the daemon" (pi / opencode / openclaw / dormant dsh). These are never wakeable.
- **Add a per-agent boolean `daemonWake`** on each `daemon.json` `agents[]` entry: whether the daemon should wake that (capable) agent. This is separate from `agentType`, which stays the backend identity.
- **`chorus init` defaults `daemonWake: false`** for each daemon-capable selected agent (the agent is added and its key is available to `chorus mcp`, but it is NOT woken). Interactively, init asks per capable agent "Enable daemon waking for `<name>`? [y/N]" (default No); Yes → `daemonWake: true`. Non-interactively, `--daemon-wake <ids>` / `--daemon-wake-all` opt specific agents in; default stays off.
- **Daemon runtime wake gate** becomes `isWakeableAgentType(agentType) && daemonWake !== false`. So: `offline` → never woken; wakeable + `daemonWake:false` → proxy-only (no spawner, no wakeable connection — the same runtime path as `offline`); wakeable + `daemonWake` true/absent → woken. **Absent = woken** preserves the entries #506 already wrote (which carry no `daemonWake`).
- **The auto-start (boot-service) prompt** is gated on "≥1 selected agent will actually be woken (`wakeable && daemonWake`)" instead of "≥1 wakeable" — extending #506's all-offline skip to an all-not-woken skip.

## Capabilities

### Modified Capabilities

- `chorus-init`: init writes `daemonWake` per agent (default off + opt-in prompt/flags); the auto-start gate counts woken agents, not merely wakeable ones.
- `daemon-multi-agent`: add the per-agent `daemonWake` opt-in and its runtime wake gate; `offline` retained for daemon-incapable backends.

## Impact

- Code: `cli/daemon-config.mjs` (carry `daemonWake` into each agent `cfg`), `cli/daemon.mjs` (`buildMultiAgentDaemon` skip + `anyWakeable` gate), `cli/init/steps/credential-seed.mjs` (default-off + opt-in), `cli/init-args.mjs` (`--daemon-wake` / `--daemon-wake-all`), `cli/init/steps/daemon-setup.mjs` (auto-start gate on woken).
- Tests: `daemon-config`, `daemon-multi-agent-runtime`, `init-credential-seed`, `init-args`, `init-daemon-setup`, `init-integration`.
- Backward-compatible: existing `agents[]` entries with no `daemonWake` stay woken; `chorus daemon install` (no init selection) path is unchanged.
- Lands on `feat/broaden-init-plugin-install` (folds into the unmerged PR #506, refining its `offline` design before it ships).
- Out of scope: the dsh cordis composition; changing which backends are wakeable.
