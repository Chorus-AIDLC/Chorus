# Proposal: Sync the OpenClaw plugin event router with the daemon's newly-added wake events

## Why

Chorus has **two independent "SSE event → wake an AI agent" paths** that consume the same server-side notification/control stream:

1. **CLI daemon** — `cli/event-router.mjs` + `cli/prompts.mjs`, which turns a notification into a headless `claude -p` subprocess wake.
2. **OpenClaw plugin** — `packages/openclaw-plugin/src/event-router.ts`, which wakes an in-process embedded agent via `runEmbeddedAgent`.

The two paths share **no runtime code**: the plugin is a separately-published npm package (`@chorus-aidlc/chorus-openclaw-plugin`, `rootDir: src`) that cannot import from the monorepo's `cli/`. Each therefore reimplements its own `switch (notification.action)` router and its own per-action wake prompts. The shared producer is the server (`src/services/notification-listener.ts` mints the notification actions; `src/services/notification-turn.ts` classifies triggers).

The server + CLI have grown three new **stage-advance** wake actions, all shipped:

- `elaboration_verified` — a human clicked **Verify Elaborate** → wake the assigned agent to **write the proposal** (`add-elaboration-verify-wake`, PR merged).
- `start_development` — a human clicked **Start Development** → wake the agent to **claim + execute all remaining tasks** in dependency order (`add-stage-advance-start-development`, PR merged).
- `yolo_requested` — a human clicked **Yolo** → wake the agent to **drive the whole idea to done** via the yolo skill, stage-adaptively (`add-stage-advance-yolo`, PR #404 merged to `develop`).

The CLI daemon handles all three (they are in `cli/prompts.mjs`'s `WAKE_ACTIONS` with dedicated prompt bodies). **The OpenClaw plugin's router has not been updated since 2026-06** and handles none of them — they fall through its `switch` to the `default` branch and are logged as `"Unhandled notification action"`. An OpenClaw-hosted agent whose human clicks Verify Elaborate / Start Development / Yolo is therefore **never woken** — the feature silently no-ops for that host.

This change closes that gap for the three fully-missing events, and installs a lockstep guard so the two routers do not drift apart again.

## What Changes

- **Route the three stage-advance wake actions in the plugin.** Add `elaboration_verified`, `start_development`, and `yolo_requested` cases to `ChorusEventRouter`'s `switch (notification.action)` in `packages/openclaw-plugin/src/event-router.ts`, each waking the embedded agent with a dedicated prompt (a new `handle*` method mirroring the existing handlers). Contract-equivalent to the CLI's `cli/prompts.mjs` cases: `elaboration_verified` → "the idea is elaborated, write the proposal (do NOT answer questions)"; `start_development` → "claim and execute ALL remaining tasks in dependency order, loop until none claimable"; `yolo_requested` → "drive the whole idea to done via the yolo skill, resume from whatever phase it is in; never merge/push a PR without human approval."

- **Keep the plugin's existing prompt voice (elaboration decision q4=c).** The new prompt bodies are written in the plugin router's own style (the existing `[Chorus] …` + `buildMentionGuidance` shape), not a byte-for-byte copy of `cli/prompts.mjs`. The CLI's `HEADLESS_PREAMBLE` is subprocess-specific and is **not** ported — the embedded agent needs no headless preamble. Each new wake carries the same `@mention` guidance the sibling idea-rooted handlers already emit, and a `contextKey` of `chorus:<action>:<entityUuid>` for burst dedup, exactly like every existing handler.

- **Install a lockstep parity guard (elaboration decision q3=a — mirror, locked by a test).** Add a repo-level test under `cli/__tests__/` that asserts the plugin router's handled-action set is a superset of the daemon's wake-action set, minus the two actions the plugin deliberately routes elsewhere (`resource_resumed` via the reverse control channel; `human_instruction` via `deliver_turn` / pending-turn delivery). This test lives in `cli/__tests__/` because the root Vitest config includes `cli/**/__tests__` but **excludes** `packages/` — so a guard there runs in the main CI and can read both source files, catching the next drift automatically.

- **Add plugin-side unit tests (elaboration decision q5=a).** Extend `packages/openclaw-plugin/src/__tests__/event-router.test.ts` with the three new actions in the existing `it.each` table (assert the wake message contains the action's distinctive instruction and the `contextKey` is `chorus:<action>:<entityUuid>`). These run in the plugin's own Vitest. Real-machine end-to-end verification (a running OpenClaw host + live SSE) is explicitly handed to a human — it cannot be automated from this headless session.

- **No SDK shim change.** `packages/openclaw-plugin/src/openclaw-sdk.d.ts` already exposes `runEmbeddedAgent` and the wake plumbing; adding notification-action cases is pure routing/prompt work that needs no new runtime capability.

- **No `dist/` edit.** `packages/openclaw-plugin/dist/` is gitignored (0 tracked files) and rebuilt at publish time from `src/` (`prepublishOnly` runs `typecheck` + `test` + `build`). The source edit is authoritative; the build step regenerates `dist`.

## Capabilities

### Modified Capabilities

- `openclaw-event-bridge`: Extend the plugin's event-routing contract with a requirement that the router handles the three stage-advance wake actions (`elaboration_verified`, `start_development`, `yolo_requested`) by waking the embedded agent with an action-appropriate prompt, and a requirement that the plugin's handled-action set stays in lockstep with the daemon's wake-action set (superset minus the two control/turn-delivered actions).

## Impact

- **Schema**: **zero migrations.** No model, enum, or column touched. The server already mints all three actions.
- **Plugin code** (`packages/openclaw-plugin/`, separately-published npm package):
  - `src/event-router.ts` — three new `case` arms in `fetchAndRoute`'s `switch`, and three new private `handle*` methods.
  - `src/__tests__/event-router.test.ts` — three new rows in the routing `it.each` table.
- **Repo code** (`cli/`, main package — CI-run):
  - `cli/__tests__/openclaw-plugin-wake-parity.test.mjs` (new) — the lockstep guard.
- **Server code**: none — the notification actions and daemon triggers already exist.
- **Docs**: none required. The daemon-vs-plugin wake parity is captured by the new spec requirement and the parity test; no MCP tool, skill, or `docs/MCP_TOOLS.md` change (the wake actions are server-minted, not agent-callable tools). No user-facing UI, so no `design.pen` change.
- **Runtime**: no new dependencies, no migrations, no new permission bit, no new MCP tool.
- **Backward compat**: fully additive. The nine existing plugin handlers are unchanged. Actions the plugin still does not route (`resource_resumed`, `human_instruction`) are unchanged — they are handled on the control / turn-delivery paths, not the notification `switch`, and remain out of scope here.

## Out of Scope

- The two **degraded** (not missing) parity gaps, deferred to a follow-up idea by explicit owner decision (elaboration q1=a):
  - `resource_resumed` crash-vs-user (`resumedFrom`) prompt distinction in the plugin's control/resume path.
  - The autonomous `deliver_turn` split (the plugin currently rebuilds every pending turn as a `human_instruction` prompt; the CLI re-reads the notification for directed autonomous turns).
- Directed-delivery broadcast suppression in the plugin (`targetConnectionUuid` / `suppressWake`), also a follow-up.
- Extracting a shared framework-agnostic action→prompt module, or build-time generation from a single source (elaboration q3 rejected b/c). This change keeps the mirror approach and guards it with a test.
- Any change to how a proposal is written, how tasks are executed, or how the yolo pipeline runs — the new wakes reuse the existing flows exactly as the CLI's do.
