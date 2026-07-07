# Design: Sync OpenClaw plugin wake events with the daemon

## Context

Two SSE→wake consumers, one server producer:

```
                     server (single producer)
   src/services/notification-listener.ts  — activity → notification action
   src/services/notification-turn.ts       — action → DaemonSessionTurn.trigger
                     │  same SSE / control stream
        ┌────────────┴─────────────┐
        ▼                           ▼
  CLI daemon                  OpenClaw plugin
  cli/event-router.mjs        packages/openclaw-plugin/src/event-router.ts
  cli/prompts.mjs             (in-process runEmbeddedAgent)
  (headless claude -p)        clientType = "openclaw"
  clientType = "claude_code"
```

The plugin cannot `import` from `cli/` (separate npm package, `rootDir: src`). So each path has its own router + prompts. The CLI's authoritative wake-action set is `WAKE_ACTIONS` in `cli/prompts.mjs`; its per-action prompt is `buildPromptBody(n)` in the same file.

### The delta this change closes

`WAKE_ACTIONS` (CLI) currently contains 14 entries. The plugin's `switch` handles 9. Categorizing the 5-action gap:

| Action | CLI has it? | Plugin has it? | This change? |
|---|---|---|---|
| `elaboration_verified` | yes (`prompts.mjs`) | **no** → `default` log | **add** |
| `start_development` | yes | **no** → `default` log | **add** |
| `yolo_requested` | yes | **no** → `default` log | **add** |
| `resource_resumed` | yes (control-channel synthetic) | routed elsewhere (control handler `resume`) | out of scope (follow-up) |
| `human_instruction` | yes (turn-delivered) | routed elsewhere (`deliver_turn` / pending-turn) | out of scope (follow-up) |

`resource_resumed` and `human_instruction` are **not** notification-`switch` actions in either host: the CLI routes them through `dispatchResume` / `dispatchPendingTurn`, and the plugin routes them through its control handler / daemon client. They are deliberately excluded from the notification router's parity set. Only the three stage-advance actions are truly missing from the plugin.

## Goals / Non-Goals

**Goals**
- The plugin wakes the embedded agent for `elaboration_verified`, `start_development`, `yolo_requested` with an action-appropriate prompt.
- The two routers cannot silently drift on wake-action coverage again.

**Non-Goals**
- Byte-identical prompt text between CLI and plugin (owner chose q4=c — keep the plugin's voice).
- Fixing the two degraded paths, fan-out suppression, or extracting shared code (all deferred).

## Decisions

### D1 — Prompt bodies: contract-equivalent, plugin voice (q4=c)

Each new handler mirrors the CLI prompt's **instructional contract**, written in the plugin's existing style. Concretely (the distinctive instruction each must carry, so a unit test can assert on it):

- **`elaboration_verified`** (idea): "Elaboration for '<title>' was VERIFIED by a human (ideaUuid …, projectUuid …). The idea is now elaborated — do NOT answer elaboration questions. Proceed to WRITE THE PROPOSAL: gather context with chorus_get_idea + chorus_get_elaboration, then author it via the proposal flow (chorus_pm_create_proposal / the proposal skill)." + `buildMentionGuidance(n, "idea")`.
- **`start_development`** (idea): "A human started DEVELOPMENT for '<title>' (ideaUuid …, projectUuid …). The proposal is approved and unfinished tasks remain. Claim and execute ALL remaining tasks in dependency order via the develop workflow: repeatedly chorus_get_unblocked_tasks → chorus_claim_task → implement → chorus_report_criteria_self_check → chorus_submit_for_verify, looping until NO claimable task remains. Do NOT stop after one task. Leave to_verify tasks and other sessions' tasks untouched. If nothing is claimable, post a brief status comment and end the turn." + `buildMentionGuidance(n, "idea")`.
- **`yolo_requested`** (idea): "A human requested a YOLO run for '<title>' (ideaUuid …, projectUuid …). Drive this idea all the way to done following the yolo skill (Idea → Elaboration → Proposal → Execute → Verify). First read the current state (chorus_get_idea, chorus_get_elaboration, chorus_get_proposals) and RESUME from whatever phase it is in — do NOT assume a fixed stage. Complete through done + completion report, but do NOT merge or push a pull request without explicit human approval." + `buildMentionGuidance(n, "idea")`.

All three are idea-anchored, so `entityType` is `idea` and the mention guidance targets the idea (matching `handleIdeaClaimed` / `handleElaborationAnswered`). Each uses `contextKeyFor("<action>", n.entityUuid)`.

The `yolo_requested` prompt explicitly preserves the **"yolo never merges"** rule ("do NOT merge or push a pull request without explicit human approval") — the same clause the CLI prompt carries.

### D2 — Wiring: three new `case` arms + three `handle*` methods

Mirror the existing structure exactly. In `fetchAndRoute`'s `switch`, add three arms before `default`:

```ts
case "elaboration_verified":
  this.handleElaborationVerified(notification, attribution);
  break;
case "start_development":
  this.handleStartDevelopment(notification, attribution);
  break;
case "yolo_requested":
  this.handleYoloRequested(notification, attribution);
  break;
```

Each `handle*` method follows the `handleElaborationAnswered` shape: build `mentionGuidance = this.buildMentionGuidance(n, "idea")`, then `this.wake(message, this.contextKeyFor(action, n.entityUuid), attr)`. Attribution threading (lineage resolve → `{entityType, entityUuid, rootIdeaUuid, directIdeaUuid}`) is already done once in `fetchAndRoute` before the switch — the new handlers receive it unchanged, so idea lineage / session anchoring works identically to the existing idea handlers.

### D3 — Lockstep guard location: `cli/__tests__/` (q3=a)

The root `vitest.config.ts` `include` is `['src/**/__tests__/**/*.test.{ts,tsx}', 'cli/**/__tests__/**/*.test.mjs']` and `exclude` lists `packages`. So:

- Plugin unit tests (`packages/openclaw-plugin/src/__tests__/*.test.ts`) run **only** in the plugin's own Vitest (its `pnpm --filter … test`), not in the root run.
- A guard that must run in the **main CI** and read **both** files belongs in `cli/__tests__/`.

The guard (`cli/__tests__/openclaw-plugin-wake-parity.test.mjs`) reads both source files as text and asserts set membership:

1. Parse the CLI's `WAKE_ACTIONS` — import `{ WAKE_ACTIONS }` from `../prompts.mjs` (it's an exported `Set`, so no fragile regex).
2. Parse the plugin's handled actions from `packages/openclaw-plugin/src/event-router.ts` — extract every `case "<action>":` label inside the router `switch` via regex over the file text (the plugin is TS and not importable from an `.mjs` test without a build, so text-scan is the pragmatic, dependency-free approach — and it is exactly what the "did someone add a case?" check needs).
3. Define `CONTROL_OR_TURN_DELIVERED = new Set(["resource_resumed", "human_instruction"])` — the actions the plugin routes off the notification `switch` by design.
4. Assert: for every `a` in `WAKE_ACTIONS` not in `CONTROL_OR_TURN_DELIVERED`, the plugin's parsed case-set includes `a`. On failure, list the missing actions so the next drift names itself.

This makes the mirror **enforced**, not merely documented: the next time someone adds a wake action to `cli/prompts.mjs` without porting it to the plugin, the main CI fails with the exact missing action name. It does not assert prompt-text equality (q4=c allows divergent wording) — only action coverage.

> Why not assert the reverse (plugin ⊆ CLI)? The plugin could legitimately handle a host-specific action the CLI never needs. The one-directional superset check (CLI-wake ⊆ plugin-handled, modulo the control/turn set) is the invariant that matters: "every server-minted wake the daemon acts on, the plugin acts on too."

### D4 — Fetch path is unchanged

The plugin's `fetchAndRoute` already fetches the notification, resolves lineage/attribution, and dispatches by action. The three new actions are idea-entity notifications exactly like `elaboration_answered`, so they flow through the existing fetch + attribution code with zero change — only the `switch` gains arms. No change to `sse-listener.ts`, `daemon-client.ts`, `control-handler.ts`, `lineage.ts`, or the SDK shim.

## Risks / Trade-offs

- **Mirror still duplicates prompt text.** Accepted (q3=a): the parity test guards *coverage*, not wording; wording drift is tolerated by design (q4=c). A future idea may extract a shared module (rejected here as too heavy for a 3-case sync).
- **Text-scan parse of the plugin `switch`.** The regex keys on `case "<label>":`. If someone writes the case label via a computed expression it would miss — but every existing handler uses a string literal, and a new contributor copying the pattern will too. The failure mode is a false *pass* only if a case is added in a non-literal form, which no existing code does; the common drift (a case simply not added) is caught.
- **No automated e2e.** Real OpenClaw + live SSE verification is manual (q5=a). Mitigated by the unit tests (message + contextKey per action) and the parity guard.

## Migration Plan

None. Additive code + tests only; no schema, no data, no config. Ships in the plugin's next publish (rebuilds `dist` from `src`).

## Open Questions

None — all five elaboration questions are resolved (q1=a scope, q2=a yolo in-scope, q3=a mirror+lockstep, q4=c plugin voice, q5=a unit+parity tests, manual e2e).
