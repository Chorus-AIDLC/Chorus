# Design — Directed live delivery for pinned autonomous wakes

## Context

Three wake families exist on the daemon:

| Wake | Pin source | Server turn creation | **Daemon-side live delivery (today)** |
|---|---|---|---|
| `human_instruction` | n/a (origin is the session) | `notification-turn` chokepoint | **directed** — `deliver_turn` ping on `control:{originConnectionUuid}`; broadcast suppressed in `event-router` |
| `mentioned` | mention markup `(host,cwd)` → `ctx.pinnedHost/pinnedCwd` | pin-aware (`resolvePinnedTarget` + `selectOriginConnection`, #354) | **broadcast** — every online connection wakes; pin ignored ← **BUG** |
| `task_assigned` | `Task.targetHost/targetCwd` (#354) | pin-aware (same path) | **broadcast** — every online connection wakes; pin ignored ← **BUG** |
| `elaboration_verified` | none (Idea has no pin columns) | online-first (no pin) | **broadcast** — every online connection wakes ← lands on any cwd |

The bug: PR #354 made server-side **turn creation** pin-aware, but the live **wake** for `mentioned` / `task_assigned` still rides the agent-wide `notification:agent:{agentUuid}` SSE broadcast (`src/app/api/events/notifications/route.ts`), and `cli/event-router.mjs` enqueues a wake on **every** connection because the action is in `WAKE_ACTIONS`. Only `human_instruction` is excluded from the broadcast path (`event-router.mjs` ~L81-96) and delivered origin-only via the `deliver_turn` control ping.

**Chosen mechanism (elaboration Q4):** extend the proven `human_instruction` directed-delivery pattern — *"服务端按 `selectOriginConnection` 解析出 pinned 在线连接，向其 `control:{connectionUuid}` 发 `deliver_turn`；daemon 广播路径对带 pin 的 mention 忽略非目标那份。与子2 范式统一（把 `deliver_turn`/pending-turn 路径从 `human_instruction`-only 扩到 `mentioned`）"* — to the two pinned autonomous wakes and to `elaboration_verified`. This is a single mechanism with two cooperating halves (the directed `deliver_turn` ping **and** the non-target broadcast suppression), not a choice between them.

## Goals / Non-goals

**Goals**
- A pinned `mentioned` / `task_assigned` wake wakes ONLY the pinned online `(host,cwd)` daemon, via a `deliver_turn` ping to that connection's control channel.
- A non-target online connection of the same agent does NOT also wake from the broadcast (it ignores its copy).
- `elaboration_verified` (Verify Elaborate → write the proposal) wakes the cwd where the idea's conversation already lives (its session origin), falling back to online-first when no session exists.
- An **un-pinned** `mentioned` / `task_assigned` wake is byte-for-byte unchanged (broadcast → online-first, no `deliver_turn`, no suppression).
- An **offline-pin** wake records a plain notification and wakes NO instance (elaboration Q2 — a deliberate change from #354's online-first fallback; see below).
- Reuse the existing `deliver_turn` / `control:{connectionUuid}` / pending-turns machinery — no new transport, no new permission bit, no DDL.

**Non-goals**
- No durable queue/backfill that holds a turn until an offline pin comes online (a fully-offline or offline-pinned target stays a plain notification).
- No `project → cwd` inference (parent idea DEC-5).
- No re-pointing an existing session's origin to a different cwd for a mention (that would `No conversation found`; cross-cwd mentions open a per-instance session instead).
- The `human_instruction` path is unchanged.

## Mechanism (single, per Q4): directed `deliver_turn` ping + non-target broadcast suppression

### Server (`src/services/notification-turn.ts`)

1. `resolvePinnedTarget` + `selectOriginConnection` already resolve a pinned `mentioned` / `task_assigned` wake to its matching **online** connection (or none). Unchanged from #354.
2. For `elaboration_verified`, resolve the target as the idea's **existing `DaemonSession.originConnectionUuid`** (idea-anchored session) when that connection is online; else none. The `Idea` entity gets no pin column.
3. **When a turn is created against a resolved online target connection** (pinned mention/task, or the elaboration_verified session origin), emit a `deliver_turn` control ping on that connection's `control:{connectionUuid}` channel carrying the precise `turnUuid` — reusing the existing `deliverTurnPing` helper (`daemon-instruction.service.ts`) / `dispatchControl` (`daemon-control.service.ts`), now invoked for these triggers, not only `human_instruction`. Fire-and-forget + non-fatal (the persisted turn + reconnect backfill are the durability net), exactly as the keystone.
4. **Stamp the resolved target connection identity** on the wake notification the daemon reads via `chorus_get_notifications` (transport-only, like the existing `instructionText` denormalization — NOT a persisted `Notification` column) so non-target daemons can recognize the wake is not theirs and suppress it.
5. **Offline pin / no online target (Q2): create NO turn and emit NO `deliver_turn`.** The already-created notification stands as the plain record. Do **not** fall back to online-first for a *pinned* wake — that silent re-route to the wrong cwd is the user-visible half of this bug. (This is the one deliberate behavior change from #354's "offline pin → online-first" scenario; #354's text predates the Q2 decision.) Because no online target exists, no daemon matches the stamped identity, so every connection suppresses → notify-only with no wake anywhere.
6. **Un-pinned wake:** stamp NO target and emit NO ping → the daemon broadcast wakes online-first exactly as before this change.

### Daemon (`cli/event-router.mjs`, `cli/control-handler.mjs`)

1. **Broadcast suppression** (`event-router.mjs` `#fetchAndRoute`): for a wake-action notification that carries a stamped `targetConnectionUuid`, compare it to **this** daemon's registered connection uuid (injected from the same source `control-handler.mjs` uses via `getConnectionUuid()`):
   - target set AND ≠ me → **suppress** the broadcast wake (log the reason).
   - target set AND = me → wake (the target acts on its broadcast copy, which carries the full prompt context).
   - no target (un-pinned, or offline-pin-no-turn) → wake exactly as today (broadcast → online-first). Un-pinned behavior is byte-identical.
2. **Directed delivery** (`control-handler.mjs` → `deliverTurn` → `backfill.pendingTurnsOnly` → `dispatchPendingTurn`): the `deliver_turn` ping for the target triggers the connection-scoped pending-turns sweep. `dispatchPendingTurn` is widened from `human_instruction`-only to also re-dispatch a `mentioned` / `task_assigned` / `elaboration_verified` pending turn (see the prompt-context constraint below).
3. **Dedup**: the target may receive both its broadcast copy (keyed `notificationUuid`) and the `deliver_turn`→pending-turn delivery (keyed `turn:{uuid}`). These must collapse to ONE wake. The shared `seen` set is the dedup point; the implementer must ensure the two delivery routes for the same logical wake do not double-spawn (e.g. by keying the pending-turn re-dispatch and the broadcast handling so the first to run marks the other seen). This mirrors the existing `seen`-set discipline the router already applies across live + backfill.
4. The `human_instruction` dedicated early-return + `deliver_turn` path is unchanged.

### The prompt-context constraint (why the daemon still needs the broadcast)

`getPendingTurnsForConnection` returns every pending turn for a connection's sessions including `trigger`, but a `mentioned` / `task_assigned` / `elaboration_verified` turn has **`promptText = null`** — only `human_instruction` carries canonical free text on the turn. The autonomous wake prompt (`cli/prompts.mjs buildPrompt`) needs notification context (`entityTitle`, `entityType`, `actorName`, `message`). So:

- **Live case (normal):** the target daemon builds the wake prompt from the **broadcast notification it received** (it is online, so it got the broadcast); the `deliver_turn` ping is the precise/reliable nudge (子2 role) and the dedup ensures one wake.
- **Missed-broadcast case (rare):** if the target's broadcast copy was dropped but the `deliver_turn` ping arrived, the pending-turn re-dispatch must rebuild the autonomous prompt — by re-reading the notification it already fetches in `#fetchAndRoute` (`chorus_get_notifications`) or the entity by the turn's `sessionId`/`directIdeaUuid`. This re-derivation path is the one genuinely new daemon-side wiring beyond `human_instruction`; flagged for the implementer to build against the current code, and covered by the unit tests below.
- **Durability:** the reconnect pending-turn backfill remains the net — a turn persisted at the chokepoint is never lost, only delivered late.

## Risks

- **Daemon does not yet know its own connectionUuid** (before the SSE handshake `onConnectionId`): a targeted wake arriving in that window has no self-identity to match. Safe default: treat a targeted wake as **not mine** → suppress; the `deliver_turn` ping to the actual target + the reconnect backfill cover delivery. The control handler already treats an unregistered uuid as "<unregistered>" and ignores targeted commands — same posture. Documented and tested.
- **Double-wake of the target** (broadcast copy + `deliver_turn`→pending): mitigated by the shared `seen` set; this is the single most important thing the daemon tests must pin down.
- **Stale/recycled connectionUuid**: the server resolves the target at notification time against the live registry (online match), so the stamped uuid is current; a daemon that reconnected with a new uuid simply won't match a stale target and falls to the pending-turns backfill — the robustness the control channel already assumes.
- **Behavior change from #354 (offline pin)**: #354's archived spec says an offline pin falls back to online-first. Q2 reverses that for a *pinned* wake (notify-only, no wake). The spec delta MODIFIES that requirement and replaces the corresponding scenario; un-pinned wakes still go online-first, so only the explicit-pin path changes.

## Test strategy

- **Server unit** (`notification-turn.test.ts`): a pinned `mentioned`/`task_assigned` wake whose pin matches an online connection creates the turn, emits a `deliver_turn` to that connection, and stamps it as the target; an offline pin (no online match) creates NO turn, emits NO ping, stamps NO target (notify-only — the changed #354 behavior); an un-pinned wake stamps none and emits none; `elaboration_verified` resolves the idea's online session origin (ping + stamp) and falls back to none/online-first with no session or an offline origin; a cross-cwd mention opens a per-instance session.
- **Daemon unit** (`event-router` / `control-handler` tests): a broadcast whose `targetConnectionUuid` ≠ my uuid is suppressed; = my uuid wakes; absent wakes (un-pinned path identical); the pre-handshake (no self uuid) window suppresses a targeted wake; a `deliver_turn` for a `mentioned`/`task_assigned`/`elaboration_verified` turn re-dispatches it (prompt rebuilt) and dedups against the broadcast copy so the target wakes exactly once.
- **Daemon integration**: with 2 online instances of one agent, a pinned `mentioned` and a pinned `task_assigned` each wake ONLY the pinned instance (the scenario PR #354's single-instance e2e never exercised); an un-pinned wake still wakes online-first.
