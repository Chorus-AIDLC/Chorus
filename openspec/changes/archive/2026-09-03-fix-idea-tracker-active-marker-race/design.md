# Design — Deterministic connect-time reset for daemon session-activity

## Current architecture (pre-fix)

- `DashboardEventProvider` (`src/contexts/dashboard-event-context.tsx`) owns the one
  shell-level `EventSource` for the tab. On `onopen` it bumps `openGeneration`; on
  `onmessage` it JSON-parses the payload and fans it out synchronously to every
  subscriber.
- `AgentPresenceProvider` (`src/contexts/agent-presence-context.tsx`) subscribes to
  the transport. It reduces `session_started`/`session_ended` events into
  `sessionActivity` (via `reduceSessionActivity`), from which
  `activeSessionsByIdea` is derived and read by `IdeaCard`.
- On connect, the server (`/api/events`, `listVisibleRunningSessionActivities`)
  replays a `session_started` for every currently-running visible session.
- Today the client resets `sessionActivity` in a `useEffect` keyed on
  `openGeneration`:

  ```ts
  useEffect(() => {
    if (openGeneration === 0) return;
    setSessionActivity(emptySessionActivityState());   // ← the racy wipe
    // ... fetchExecutions() on later generations
  }, [openGeneration, fetchExecutions]);
  ```

## The race

`onopen` (→ `setOpenGeneration`) and the replay `onmessage` (→ `setSessionActivity`)
are separate browser event turns. The wipe runs as a **passive effect** scheduled
after the `openGeneration` commit; the replay is reduced synchronously in the
message handler. React gives no ordering guarantee between the scheduled passive
effect and a subsequently-dispatched message handler. When the replay reduces before
the deferred wipe effect runs, the wipe erases the just-replayed sessions → marker
blank until the next live event. This is intermittent by nature.

The unit test hid this by serializing `onopen()` and replay into separate `act()`
flushes, which forces the intended order.

## The fix — synthetic `stream_reset` on `onopen`

Move the reset out of a passive effect and into the **same synchronous, ordered
channel as the messages**, so transport ordering (open-before-message, guaranteed by
the EventSource spec) becomes the ordering guarantee for reset-before-replay.

### `DashboardEventProvider`

In `connect()`, `onopen` additionally fans a synthetic reset event to subscribers
**before returning** (i.e. before any `onmessage` can run):

```ts
eventSource.onopen = () => {
  setOpenGeneration((g) => g + 1);
  // Synchronous, in-band reset: dispatched through the SAME subscriber fan-out as
  // messages, so it is ordered strictly before any replay `onmessage` for this
  // connection (EventSource guarantees `open` fires before any `message`).
  for (const cb of subscribersRef.current) cb({ type: STREAM_RESET_EVENT });
};
```

`STREAM_RESET_EVENT = "stream_reset"` is a client-synthetic type the server never
emits. Export it so subscribers can match it by name.

### `AgentPresenceProvider`

- In the transport subscriber, handle the new type first:

  ```ts
  if (parsed.type === STREAM_RESET_EVENT) {
    setSessionActivity(emptySessionActivityState());
    return;
  }
  ```

- Remove `setSessionActivity(emptySessionActivityState())` from the `openGeneration`
  effect. Keep the `fetchExecutions()` self-heal there unchanged (executions are
  order-insensitive; a fetch is idempotent).

Because `stream_reset` is dispatched synchronously in `onopen` and the replay
`session_started` events arrive in later `onmessage` turns, the reduction order is
deterministically: reset (empty) → replay (repopulate) → live deltas. On a
reconnect the same holds, so the marker re-syncs every connect.

### Other subscribers

- `RealtimeProvider.handleEvent`: `stream_reset` has no `presence`/`execution` type
  and no `entityType/entityUuid/action` fields, so it falls through the existing
  guards and is ignored. Its reconnect catch-up continues to run off
  `sharedOpenGeneration` (unchanged).
- `NotificationProvider`: switches on known notification event types; an unknown
  `stream_reset` is ignored.

## Ordering guarantee (why this is race-free)

1. EventSource spec: the `open` event fires before any `message` event on a
   connection.
2. `DashboardEventProvider` dispatches `stream_reset` synchronously within the
   `open` handler, and messages synchronously within `message` handlers.
3. Therefore every subscriber receives `stream_reset` before any replay message of
   that connection.
4. `setSessionActivity` updates are applied in call order (functional reducer for
   deltas; a plain replace for the reset), so `empty()` then `reduce(...)` yields the
   populated map regardless of React batching.

No passive effect participates in the reset ordering, so effect-scheduling timing
can no longer invert it.

## Risks / alternatives

- **Alternative: server snapshot begin/end bracket.** More invasive (server event
  contract change); rejected — the synthetic client reset is minimal and sufficient.
- **Alternative: diff-reconcile replay against current state (no wipe).** Harder —
  the replay is a stream of individual `session_started` events with no end marker,
  so the client cannot tell when the full set has arrived to diff against. Rejected.
- **Risk: a subscriber mid-mount misses the first `stream_reset`.** The first reset
  is a no-op on an already-empty state, and the pre-existing subscribe-before-events
  ordering is unchanged, so this is not a regression.

## Test plan

- `dashboard-event-context.test.tsx`: on `onopen`, subscribers receive a
  `{ type: "stream_reset" }` event; assert it is delivered (and that a subsequent
  `onmessage` still fans out) — proving reset is in-band and ordered before messages.
- `agent-presence-context.test.tsx`: (a) a `stream_reset` event clears
  `activeSessionsByIdea`; (b) reset-then-replay leaves the session present (the
  intended order); (c) the existing "rebuild on stream open" test continues to pass
  now that the wipe is driven by `stream_reset` rather than the `openGeneration`
  effect.
- Full `pnpm test` + `pnpm lint` + `npx tsc --noEmit` green.
