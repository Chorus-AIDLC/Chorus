## Why

`pi` became a first-class wakeable daemon backend in `add-daemon-pi-backend` — `cli/init/agent-type-map.mjs` maps `pi` → `"pi"` (not `"offline"`), `KNOWN_AGENTS` includes it, `selectSpawner` has an explicit `PiSpawner` branch, and `isWakeableAgentType("pi")` is true. That change updated the `pi-daemon-backend` capability but left **older statements in two other capabilities** describing `pi` as not wakeable, so the spec of record contradicts itself and contradicts the code:

- `daemon-multi-agent`: the offline-classification requirement lists `pi` among the backends that map to `offline`, and the backend-selection requirement's example list omits `pi`.
- `chorus-init`: two requirements (the init→`agentType` mapping and the init daemon-wake opt-in) list `pi` as a non-wakeable/`offline` selection — directly contradicting `pi-daemon-backend`'s "`pi` → `pi` (no longer `offline`)" requirement.

A reader (or a future change) following the stale text would classify a pi agent as never-woken. This change is **documentation-of-record only**: no runtime behavior changes, no new requirement semantics — the corrected text states what the code already does.

Found while implementing the per-agent `model`/`thinking` feature (#549): a code-review NOTE flagged one of the sentences, and an exhaustive grep then showed the other three.

## What Changes

- `daemon-multi-agent` — **Per-agent backend selection**: the example backend list gains `pi`, and a scenario pins the claude-code + pi pairing (the pairing that was verified live end-to-end).
- `daemon-multi-agent` — **Offline agent type is a valid, never-woken agents[] entry**: the fail-closed list drops `pi` (it stays for `opencode`, `openclaw`, and `dsh` while its backend is de-advertised).
- `chorus-init` — **Daemon backend agentType derived from the init selection…**: the mapping sentence states `pi` → `pi`, the fail-closed list drops `pi`, the "non-wakeable maps to offline" scenario no longer uses `pi` as its example, and a new scenario pins the pi mapping.
- `chorus-init` — **Per-agent daemon-wake defaults off at init…**: the wakeable-backend list gains `pi`, and the "offline agent gets no daemonWake field" scenario no longer lists `pi`.
- `docs/DAEMON.md` — the per-agent `agentType` row lists the full accepted set (including `pi`), and the intro line no longer says the daemon wakes "a local headless Claude Code" only (the backend is selectable and defaults to claude-code).

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `daemon-multi-agent`: backend-selection list + scenario, and the offline fail-closed classification list.
- `chorus-init`: the init→`agentType` mapping requirement (text + one scenario + one new scenario) and the per-agent `daemonWake` opt-in requirement (text + one scenario).

## Impact

- **Spec/docs only** — no `cli/**`, `src/**`, `prisma/**` or test change; nothing to migrate.
- The corrected statements are pinned by the existing tests for the code they describe (`cli/__tests__/init-agent-type-map.test.mjs`, `daemon-agent.test.mjs`, `spawner-select.test.mjs`, `pi-spawner.test.mjs`), which already assert `pi` → `pi` and `isWakeableAgentType("pi") === true`; this change makes the prose match those assertions.
