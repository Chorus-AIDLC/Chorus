# Design: Daemon single-active-session guard (Step 4b narrow)

## Context

The server-side wake chokepoint `createTurnAndResolveTarget`
(`src/services/notification-turn.ts`) resolves, for every wake-triggering notification
destined for a daemon agent, an `OriginSelection`:

```
type OriginSelection =
  | { kind: "directed";     connection: ConnectionView }  // deliver to ONLY this conn
  | { kind: "online_first"; connection: ConnectionView }  // BROADCAST → online-first
  | { kind: "offline_pin" }                                // notify-only, suppress all
  | { kind: "none" };                                      // agent fully offline
```

Mapping to the wire (consumed by `cli/event-router.mjs`):

| selection | targetConnectionUuid | suppressWake | daemon effect |
|---|---|---|---|
| `directed` | origin.uuid | false | Case 3 wake on target; Case 2 suppress on others |
| `online_first` | null | false | **Case 4 broadcast → every online connection wakes** |
| `offline_pin` | null | true | Case 1 suppress on all (notify-only) |
| `none` | null | false | nobody online |

The existing narrowing ladder (all gated on `RESIDUAL_CWD_UPGRADE_TRIGGERS`):

1. **Step 3** `resolvePinnedTarget` → instance/mention **cwd pin** (HARD). Match online →
   `directed`; offline → `offline_pin`.
2. **Step 4** `resolveIdeaSessionOriginTarget` → if the idea already has an ONLINE
   `DaemonSession.originConnectionUuid`, upgrade `online_first` → `directed` there.
3. **Step 4a** `resolveProjectOwnerCwdPin` → the agent owner's `ProjectAgentCwdPreference`
   `(host, cwd)` for this project; re-select against it as a HARD pin.

**Gap:** when none of the above narrows (no instance pin, no online idea origin, no project
pin) the selection stays `online_first` → Case 4 broadcast. This is the fan-out that lets
the same agent's concurrent connections each advance the same entity.

## Decision

Insert **Step 4b** immediately after step 4a and before the terminal `offline_pin`/`none`
gate:

```ts
// (4b) Single-active-session narrow (idea 62920792). A residual-family (autonomous
// idea-anchored, incl. un-pinned @mention) wake still `online_first` after steps 4 and 4a
// would broadcast to EVERY online connection of the agent. Deterministically narrow to the
// ONE online-first connection already chosen by selectOriginConnection and promote it to
// `directed`, so exactly one connection wakes (deliver_turn) and the rest suppress.
if (
  RESIDUAL_CWD_UPGRADE_TRIGGERS.has(trigger) &&
  selection.kind === "online_first"
) {
  selection = { kind: "directed", connection: selection.connection };
}
```

That is the whole functional change. Everything downstream — the cross-cwd session
re-point, the `deliver_turn` ping, the `targetConnectionUuid` stamp, the `directedRuntimeCwd`
= `origin.cwd` derivation — is the **existing** `directed` path and is reused unchanged.

### Why this is correct and convergent

- **Determinism.** `listConnectionsForAgent` returns connections via `sortConnectionViews`,
  which orders **online-first then by a stable identity tie-break** (`agentName → agentUuid
  → cwd → host → clientType → uuid`) and **deliberately excludes timestamps**. So the
  "first online" connection is a pure function of the current online set — two wakes that
  observe the same online set pick the *same* connection.
- **Convergence under concurrency (the bug).** Two near-simultaneous wakes W1, W2 for the
  same `(agent, idea)` with two online connections `[Y, Z]`:
  - Both compute `online_first = Y` (stable sort) → Step 4b → `directed(Y)`.
  - Both stamp `targetConnectionUuid = Y`. Y wakes (Case 3) for both; Z suppresses (Case 2).
  - Y's per-connection `WakeQueue` keys both by the idea and **coalesces them into one
    subprocess** (existing wake-coalescing). The server settles the superseded turn to
    `merged`. Net: one advancement, not two.
  - If W1 lands first and creates the idea's `DaemonSession` origin on Y, W2 is narrowed by
    **step 4** (origin online) rather than 4b — same target Y. Either path converges.
- **Precedence preserved.** Step 4b only fires when `selection.kind === "online_first"`, i.e.
  after steps 3/4/4a declined. A cwd pin, an online idea origin, or a project pin all short-
  circuit it (they yield `directed`/`offline_pin`). So the owner's order — cwd pin → project
  pin → narrow — holds exactly.
- **Directed/pinned untouched (Q6).** Human-directed and pinned wakes resolve `directed` or
  `offline_pin` in step 3 and never reach `online_first`; `human_instruction` is excluded
  from `RESIDUAL_CWD_UPGRADE_TRIGGERS` and owns its own send path. Un-pinned `@mention` IS in
  the residual family, so it also narrows to one connection (a *pinned* mention stays step-3
  directed) — consistent with "single active per (agent, idea)".
- **Offline / single-connection degrade.** `offline_pin` and `none` never have kind
  `online_first`, so Step 4b cannot alter them. With exactly one online connection, "narrow
  to first online" is that connection — `directed` to the only candidate, behaviorally
  equivalent to the prior broadcast-to-one, but now with an explicit target + ping.

### Spawn cwd is unchanged

For a narrowed wake `pin` is null, so `runtimeCwd = null` and
`directedRuntimeCwd = runtimeCwd ?? origin.cwd ?? null = origin.cwd`. The delivery target IS
`origin`, whose own bound cwd is `origin.cwd`, so telling it to spawn in `origin.cwd` is a
no-op relative to today's broadcast-to-online-first (which used that connection's own cwd).
No misroute; when `origin.cwd` is null the stamp falls back to null and the daemon uses the
connection's bound cwd, exactly as before.

### Session re-point interaction

The existing `if (directed && directIdeaUuid)` re-point (line ~947) fires for a narrowed
wake only when a session row already exists with a *different, offline* origin (an online
origin would have been caught by step 4). Re-pointing the idea's canonical session to the
now-active online connection is the intended "follow the instance" behavior (idea 2ddd1d11,
Q1=a) and is safe for `--resume` (the daemon probes the transcript per-cwd). For the common
first-wake case there is no session yet → no re-point, just create-on-origin.

## Risks / Mitigations

- **Over-narrowing an intended second cwd.** If a human genuinely wants two cwds working one
  idea concurrently, they pin (step 3) or the project preference (4a) selects — both precede
  4b. Absent any pin there is no basis to prefer a cwd, and running two autonomous sessions
  on one idea is exactly the defect. Accepted per Q6=a / Q1 free-text ("project 也没 pin 则收窄").
- **Chosen connection races offline between resolve and delivery.** Handled by the existing
  Case 2/3 logic + reconnect backfill; the next wake re-narrows to the next deterministic
  online connection. No regression versus today.
- **Failure isolation.** Step 4b is pure in-memory selection mutation (no I/O), inside the
  existing try/catch that logs visibly and never aborts the already-created notification.

## Alternatives considered (rejected)

- **Server action-idempotency only (Q1=b)** — leave routing, dedup rounds/comments. Rejected:
  treats symptoms, not the fan-out; N subprocesses still spin up and burn tokens.
- **Daemon cross-connection lock (Q1=c)** — a shared claim across connections. Rejected: the
  daemon has N independent per-connection queues with no shared view; the lock would live
  server-side anyway, which is what Step 4b already is, more cheaply.

## Testing

Unit tests in `src/services/__tests__/notification-turn.test.ts`:

1. Residual-family (`task_assigned`, `elaboration`, un-pinned `mentioned`) + un-pinned +
   two online connections → `directed` with `targetConnectionUuid` = the deterministic
   first-online connection (was `online_first`/null before).
2. Two invocations with the same connection set → the **same** `targetConnectionUuid`
   (convergence).
3. Step 4 still wins: when the idea has an ONLINE session origin, target is that origin
   (Step 4b does not override it).
4. Step 3 pin and `offline_pin` unaffected (pinned online → its target; pinned offline →
   `suppressWake:true`, no narrow).
5. `none` (no online connection) unaffected — no turn, no target.
6. `human_instruction` excluded — stays on its own path (no narrow).
