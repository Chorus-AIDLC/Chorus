# Design — Daemon Wake Coalescing

## Context

Today's wake flow (per `cli/daemon.mjs` header): SSE `new_notification` →
`EventRouter` → `WakeQueue` → `Waker` (spawn/resume `claude`).

- **`WakeQueue`** (`cli/wake-queue.mjs`): per-key FIFO with a global concurrency
  cap. `enqueue(key, task)` pushes an **opaque thunk** `() => waker.wake(n, key, attr)`.
  `#runNext(key)` `shift()`s **one** thunk per slot; same key is strictly serial,
  different keys run concurrently up to `maxConcurrency`.
- **`Waker.wake(notification, key, attribution)`** (`cli/waker.mjs`): builds the
  prompt via `buildPrompt(n)` (one notification), decides new-vs-`--resume` by
  probing the on-disk transcript, spawns the subprocess, tracks the execution row
  (`markQueued` → running → settle), and advances the server turn
  (`turn-advance`: running → ended/interrupted).
- **`keyFor(n)`** returns `key = idea:<directIdeaUuid>` (idea-anchored session) or
  `entity:<type>:<uuid>` (ad-hoc). The `human_instruction` re-dispatch path
  (`event-router.mjs`) keys the **same** way — so autonomous wakes and chat
  messages for one session already land on the **same** queue key. This is the
  hinge that makes Q1+Q3 (merge chat with autonomous) implementable.
- **Server** creates one **pending** `DaemonSessionTurn` per wake-worthy
  notification at the notification chokepoint (`src/services/notification-turn.ts`
  → `createPendingTurn`); the daemon only advances lifecycle. Turn `status` and
  `trigger` are free String columns (no DB enum). Execution rows
  (`DaemonExecution`) accept only `running`/`queued` from the daemon;
  `reconcileSnapshot` ends any active row **absent** from the next uploaded
  snapshot.

## Goals / Non-goals

- **Goal**: when a key's slot frees, deliver **all** pending same-key events in one
  turn; single-turn accounting; no stuck queued rows.
- **Non-goal**: any timer/debounce; size-based splitting; changing concurrency,
  wake-action set, or cross-key behavior.

## Decisions (from elaboration Round 1)

| Q | Decision | Design consequence |
|---|----------|--------------------|
| Q1 scope | Merge **all** same-session events, label each in prompt | Queue coalesces by key only; no trigger filtering, no exemption for yolo/start_development |
| Q2 stale | Collapse same-entity duplicates | `buildBatchPrompt` groups by `(action, entityUuid)`; one block per group with an occurrence count + newest content |
| Q3 human_instruction | In v1 | Route the `human_instruction` deliver/backfill lane through the same coalescing enqueue |
| Q4 window | Natural batching, no timer | Drain-what's-present at slot-free; no `setTimeout` |
| Q5 prompt | Backlog preamble + per-event blocks | `buildBatchPrompt` reuses `buildPromptBody(n)` per block |
| Q6 accounting | Single turn; mark merged resources delivered | One running exec row + drop the rest from the snapshot; server settles superseded pending turns |
| Q7 cap | No cap | Drain the entire pending list for the key |

## Architecture

Coalescing MUST be **daemon-side**: the "natural batching" window (Q4) is defined
by daemon runtime timing (what piled up while the previous turn ran), which the
server cannot observe. The server's only role is settling the turn ledger.

### C1 — `WakeQueue` becomes payload-carrying (`cli/wake-queue.mjs`)

Change the per-key pending list from opaque thunks to **data items**, and give the
queue a single batch runner:

- Constructor: `new WakeQueue({ maxConcurrency, logger, runBatch })` where
  `runBatch(key, items) => Promise<void>`.
- `enqueue(key, item)` pushes an opaque data `item` (the router passes
  `{ notification, attribution }`).
- When a slot frees for a key, drain the **entire** pending array for that key
  (`splice(0)`) and call `runBatch(key, items)` **once**. No cap (Q7).
- Preserve every existing invariant: strict per-key serialization (the next batch
  waits for the current batch to finish), the global `maxConcurrency` cap,
  poisoned-batch isolation (a throwing `runBatch` is logged and the key's next
  batch still proceeds), and `drain()`/`stop()` graceful-shutdown semantics.

Natural batching falls out for free: items that arrive while batch N runs
accumulate and become batch N+1 when the slot re-frees.

> Back-compat note for tests: the queue no longer runs thunks. Existing
> `wake-queue` unit tests are updated in lockstep (TDD) to the `runBatch` +
> data-item contract. The queue stays plain ESM, zero-dep, in-memory.

### C2 — `buildBatchPrompt(notifications)` (`cli/prompts.mjs`)

- **Size 1** → delegate to `buildPrompt(n)` verbatim (byte-identical single-event
  path; all current prompt tests keep passing).
- **Size > 1**:
  1. `HEADLESS_PREAMBLE` (unchanged, paid once).
  2. A backlog preamble: "You have N queued Chorus events on this session that
     arrived while you were busy. Handle them together, in order. Each event is
     labeled with its type below."
  3. **Same-entity/same-action collapse (Q2), with a `human_instruction`
     exemption**: group notifications by `(action, entityUuid)` preserving
     first-seen order. For a group with >1 member, render one block noting the
     count and the **newest** message; a singleton renders its normal block.
     **`human_instruction` is NEVER collapsed** — every chat message renders its
     full `instructionText` as its own block, in arrival order. Rationale: chat
     text lives ONLY on the turn/notification and is not re-fetchable (unlike
     comments, which the agent can re-read via `chorus_get_comments`), so
     collapsing to "newest only" would silently drop earlier instructions and
     defeat Q3 ("一次看完积压消息"). Collapse therefore applies only to actions whose
     full content is re-derivable server-side (mentions/comments, task lifecycle);
     `human_instruction` (and any future free-text-carrying action) is exempt.
  4. Per block: a header line `### Event i — <action> on <entityType> <entityUuid>`
     followed by `buildPromptBody(n)` (reused, so each event keeps its own
     `@mention` guidance and tool hints). Blocks that produce a `null` body (empty
     `human_instruction`) are skipped.
- Ordering is arrival order (the queue drains FIFO).

### C3 — `Waker.wakeBatch(notifications, key, attribution)` (`cli/waker.mjs`)

Refactor the existing single-wake body so the subprocess machinery (transcript
new-vs-resume probe, spawn, interrupt-child registration, usage capture,
turn-advance) is shared, and add the batch entry point:

- Build the merged prompt with `buildBatchPrompt(notifications)`.
- **Execution snapshot (Q6)**: the coalesced run is anchored on the session, so
  emit **one** running execution row for the session-anchor resource and **remove**
  the merged resources from the `executions` map before emitting the snapshot. The
  server's `reconcileSnapshot` then ends those absent rows and SSE clears them from
  the UI's "queued" bucket — no new status value needed.
  - **Synthesize the anchor row (reviewer NOTE)**: the running row is
    `idea:<directIdeaUuid>` (or the ad-hoc entity), which is **not necessarily one
    of the merged items** — e.g. a batch of `@mention` notifications on child
    tasks A and B under idea D has no `idea:D` item, yet the session anchor IS
    `idea:D`. So the anchor execution row must be **synthesized** from the batch
    attribution (`directIdeaUuid`/session id), not assumed to be one of the drained
    resources. All the drained resources (A, B, …) are removed from the snapshot.
- **Turn (Q6)**: advance the one running turn (running → ended) exactly as today,
  keyed by `sessionId`, **and report `coalescedCount = notifications.length`** on
  the running-transition so the server can settle the coalesced-away turns (C4).
  The count travels via the existing `turn-advance` call (a new optional field —
  see C4); `wake` (batch size 1) reports `coalescedCount = 1`, so its behavior is
  unchanged.
- `wake(n, key, attr)` is retained as a thin `wakeBatch([n], key, attr)` wrapper
  (or the router calls `wakeBatch` directly) so a batch of size 1 is unchanged.

### C4 — Router enqueues payloads; server settles superseded pending turns

- **`cli/event-router.mjs`**: every `queue.enqueue(key, () => waker.wake(...))`
  becomes `queue.enqueue(key, { notification, attribution })`. This covers the
  live notification path (`#resolveAndEnqueue`), the `human_instruction` +
  autonomous re-dispatch (`dispatchPendingTurn` / `#redispatchAutonomousTurn`),
  and the synthetic resume (`dispatchResume`). `markQueued` is still called
  per-item before enqueue so each resource shows "queued" until its batch runs.
  `daemon.mjs` builds the queue with `runBatch = (key, items) =>
  waker.wakeBatch(items.map(i => i.notification), key, items[0].attribution)`.
  (All items on one key share the session anchor, so `items[0].attribution` is the
  batch attribution; `rootIdeaUuid`/`directIdeaUuid` are identical across the batch
  because the key IS `idea:<directIdeaUuid>`.)
- **`src/services/daemon-session.service.ts` + `POST /api/daemon/turn-advance`**:
  settle the coalesced-away pending turns using the daemon's reported
  `coalescedCount`. **Why not "strictly-older":** `advanceTurnForWake` advances the
  **OLDEST** pending turn to `running` (`orderBy: { seq: "asc" }`,
  daemon-session.service.ts ~L1745–1759). So the running turn IS the oldest and the
  "strictly-older" set is empty — the N−1 *newer* coalesced-away turns would stay
  `pending` and, because pending turns are the reconnect-backfill source
  (`getPendingTurnsForConnection`, ~L1847), would re-dispatch as **duplicate wakes**
  on reconnect. That was the Round-1 BLOCKER-1.
  - **Fix (race-safe, count-driven):** the daemon reports
    `coalescedCount = N` on the running-transition. The server, after advancing the
    oldest pending turn (seq `X`) to `running`, settles the **next `N−1` pending
    turns of the same session by ascending seq** (i.e. seq `> X`, limit `N−1`) to a
    terminal String status `"merged"`. Because the daemon drains its per-key queue
    **FIFO** and the server assigns `seq` monotonically in arrival order, "the N
    oldest pending turns" is exactly the batch the daemon coalesced. A notification
    that arrives **after** the daemon's drain has a higher seq beyond the first N,
    so it is **not** settled and correctly survives for the next batch — no race,
    no lost instruction.
  - `coalescedCount` is a new **optional** field on the `turn-advance` zod body
    (default `1`); `status` stays a free String column, so **no Prisma migration**.
    `"merged"` is added to any server-side turn-status vocabulary/whitelist and the
    conversation/turn read renders it as a settled (non-error) turn.
  - Guardrails: only strictly-newer (`seq > X`) same-session `pending` turns are
    touched, capped at `N−1`; the running turn itself and turns of other sessions
    are never affected.

## Data flow (coalesced turn)

```
busy turn running on key K (idea:<D>)
  ├─ SSE mention on task A  → markQueued(A)  → enqueue(K,{n_A})   [A: queued]
  ├─ SSE mention on idea D  → markQueued(D)  → enqueue(K,{n_D})   [D: queued]
  └─ human_instruction ×2   → markQueued(D)  → enqueue(K,{n_h1}), enqueue(K,{n_h2})
slot frees → drain K = [n_A, n_D, n_h1, n_h2]
  → wakeBatch([...], K, attr)
       prompt = preamble + block(mention A) + block(mention D + 2 chats collapsed by entity/action)
       exec snapshot: D running (synthesized anchor); A dropped → reconcile ends A's queued row
       one claude --resume <D> turn; turn-advance running→ended, coalescedCount=4
server: advance oldest pending (seq X) → running; settle next 3 pending (seq>X) → "merged"
```

## Testing strategy

- **Daemon unit tests (headless-verifiable via `pnpm test` / node test runner):**
  - `wake-queue`: multiple `enqueue` on one key before the slot frees → exactly
    one `runBatch` with all items; per-key serialization preserved; cross-key
    concurrency preserved; poisoned batch does not wedge; `drain()`/`stop()`.
  - `prompts.buildBatchPrompt`: size 1 == `buildPrompt`; size N has one preamble +
    N labeled blocks in order; same-entity/action collapse; null bodies skipped.
  - `waker.wakeBatch`: single subprocess spawned for N items; snapshot emits one
    running + drops the rest; turn advanced once.
  - `event-router`: N same-key dispatches enqueue N items on one key; the runBatch
    coalesces; human_instruction + autonomous share the key.
- **Server unit test:** advance-to-running settles older same-session pending
  turns to `merged`; unrelated sessions untouched; a single non-coalesced turn is
  unchanged.
- **Live e2e (hand off to human — headless cannot restart the daemon or drive a
  real multi-event burst):** restart `chorus-daemon.service`, send a burst while
  the agent is busy, confirm ONE turn carries all events and the queued rows clear.

## Risks / mitigations

- **Mixing a whole-idea trigger (`yolo_requested`/`start_development`) with a plain
  mention in one turn** — owner explicitly chose this (Q1). Mitigation: each event
  is a clearly-labeled block, so the agent sees "one of the events is a Yolo
  directive" and acts accordingly; the whole-idea directive naturally dominates.
- **Prompt size with no cap (Q7=b)** — natural batching bounds a batch to "one
  turn's worth" of piled-up events; same-entity collapse (Q2) further shrinks it.
  Accepted per owner.
- **Attribution divergence across a batch** — guarded: the queue key IS
  `idea:<directIdeaUuid>`, so all batched items share `directIdeaUuid`/`rootIdeaUuid`.
  Ad-hoc keys are `entity:<type>:<uuid>` (single entity), also consistent.
- **Coalesced-away pending-turn settlement racing a slow daemon** — the settlement
  is keyed to the running-transition and touches only the next `N−1` **strictly-newer**
  (`seq > X`) same-session `pending` turns (capped by the daemon's reported
  `coalescedCount`), so it can never cancel the running turn, never touch another
  session, and never settle a turn that arrived after the drain (its higher seq
  falls beyond `N`, so it survives for the next batch).
