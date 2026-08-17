# Proposal: Daemon single-active-session guard

## Why

When the same agent has **multiple daemon connections** online (two cwds, or two hosts),
an un-pinned **autonomous idea-anchored** wake is broadcast to *every* online connection
of that agent. Each connection spawns its own headless session, and each independently
advances the same entity — producing **duplicate elaboration rounds** and **near-duplicate
comments**.

Root cause, confirmed in the code:

- Wake-coalescing is **per-connection** — `WakeQueue`/`seen` are built inside
  `buildConnection(cwd, index)` (`cli/daemon.mjs`). Two connections of the same agent can
  never see each other's queue, so coalescing does not span them.
- The server resolves an un-pinned autonomous wake to `online_first` and emits it with
  `targetConnectionUuid: null, suppressWake: false`. On the daemon that is **Case 4**
  (`cli/event-router.mjs`) — "broadcast to every online connection, byte-identical" — so
  each connection wakes.

Live evidence (deployed server, 2026-08-17): a gateway SKIP wake fanned out to concurrent
Codex sessions that each wrote a duplicate evidence comment on one idea; symmetrically, an
actor idea received two near-simultaneous PASS confirmations from concurrent gateway
sessions of the same agent. This is the exact hazard.

## What Changes

Close the fan-out at the **single server chokepoint** every connection passes through:
`createTurnAndResolveTarget` in `src/services/notification-turn.ts`. That function already
runs an ordered connection-selection ladder — instance/mention **cwd pin** (step 3),
**idea-session-origin** upgrade (step 4), **project-owner cwd pin** (step 4a) — and only
falls through to a broadcast when *none* of those narrows the wake.

Add one terminal step — **Step 4b: deterministic single-connection narrow**. For a
residual-family (autonomous idea-anchored, incl. un-pinned `@mention`) trigger whose
selection is still `online_first` after steps 4 and 4a, promote the already-chosen
online-first connection to a **directed** selection. The wake is then delivered to that one
connection (existing `deliver_turn` ping + `targetConnectionUuid` stamp) and every other
connection suppresses its broadcast copy (existing Case 2).

Because the connection list is sorted by a **stable, timestamp-free** comparator
(`sortConnectionViews`: online-first + identity tie-break), concurrent wakes for the same
`(agent, idea)` deterministically converge on the **same** connection — whose existing
per-connection coalescing then folds them into one run. Once that connection builds the
idea's `DaemonSession` origin, step 4 pins subsequent wakes there. Bootstrap + self-sustaining.

### In scope (elaboration Round 1)

- **Q1 (a + free-text):** server routing narrowing only; selection order = cwd pin →
  project pin → deterministic narrow. The first two already exist; only the narrow is new.
- **Q2 (a):** guard keyed on `(agent, idea/entity)` — realized by the idea-anchored
  `sessionId` + deterministic per-agent connection order.
- **Q3 (a):** primary fix only.
- **Q6 (a):** applies to autonomous / residual-family wakes only; human-directed / pinned
  wakes (resolved `directed`/`offline_pin` in step 3) and `human_instruction` (own send
  path) are never affected.

### Out of scope (deferred)

- Elaboration round-creation idempotency (Q3=a excludes it). Recorded owner preference for
  a *future* iteration: **reject-with-error** (Q4=b) if it is later built.
- Server-side comment de-duplication (Q5=a — the routing fix removes the second author).
- A generic "one running/pending turn per (agent, entity)" guard on `createPendingTurn`.

## Capabilities

- `daemon-single-active-session` — new capability: the deterministic single-connection
  narrow that guarantees at most one of an agent's connections wakes for an un-pinned
  autonomous idea-anchored wake.

## Impact

- **Code:** one new step (~10 lines) in `createTurnAndResolveTarget`
  (`src/services/notification-turn.ts`). No schema change, no new model, no daemon change
  (the daemon already honors `targetConnectionUuid`/`suppressWake`).
- **Behavior:** un-pinned autonomous idea-anchored wakes now target one connection instead
  of broadcasting. Pinned/directed/offline/single-connection cases are byte-identical to
  today. No UI surface — no `docs/design.pen` change required.
- **Tests:** unit coverage in `src/services/__tests__/notification-turn.test.ts`.
