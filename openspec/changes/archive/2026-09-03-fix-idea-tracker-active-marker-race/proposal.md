# Fix unstable daemon active-session marker on Idea Tracker

## Why

The Idea Tracker shows a green "active session" marker on ideas that have a running
daemon session. Users report the marker **does not display stably** — entering the
Tracker (especially via a full reload, a `/ideas`→`/dashboard` 308 redirect, a
notification/search deep link, or any navigation that coincides with an SSE
reconnect) intermittently shows no marker even though a session is running.

Root cause (confirmed by code reading): the client-side session-activity state that
drives the marker is fed **only** by live SSE `session_started`/`session_ended`
events plus a one-shot server replay sent on each stream connect
(`listVisibleRunningSessionActivities`). On every EventSource open
(`openGeneration` bump) the provider wipes that state in a **passive `useEffect`**,
intending "wipe → then the replay refills it". But the wipe (a post-commit effect)
and the replay (reduced synchronously in the SSE `onmessage` handler) have **no
ordering guarantee**. When they batch together — common on reconnect — the wipe
effect runs *after* the replay has already populated the map and erases the
just-replayed sessions, so the marker vanishes until the next live event. The
timing dependence is exactly the reported "cannot display stably".

The existing unit test masks the bug because it wraps `onopen()` and each replay
dispatch in **separate `act()` blocks**, artificially forcing wipe-before-replay —
an ordering production never guarantees.

A second, related fragility: unlike the executions surface (self-healed by a 15s
poll), session-activity has no durable/poll-backed source, so a reconnect that
wipes-then-loses-the-replay leaves the marker blank with nothing to re-seed it.

## What Changes

- Make the connect-time reset **deterministic relative to the replay**: the shared
  dashboard event transport (`DashboardEventProvider`) emits a synthetic
  `stream_reset` event to its subscribers **synchronously inside `onopen`**, before
  any `onmessage` replay can arrive (the browser guarantees `open` fires before any
  `message`). The agent-presence provider clears its session-activity state on that
  `stream_reset` event instead of in a passive effect keyed on `openGeneration`.
  Because both the reset and the replay now flow through the same synchronous
  subscriber channel in transport order, the reset always precedes the replay — the
  race is eliminated.
- Remove the session-activity wipe from the `openGeneration` `useEffect` in the
  agent-presence provider (the `fetchExecutions()` self-heal in that effect is
  retained, unchanged).
- Other transport subscribers (`RealtimeProvider`, `NotificationProvider`) ignore
  the new `stream_reset` event type (they already switch on known `type` values and
  drop unknowns) — no behavior change for them.

Out of scope (deliberately): adding a new periodic REST poll for active sessions.
The deterministic reset already re-syncs on every connect/reconnect (the same
cadence as the executions self-heal is triggered), which satisfies the accepted
`initial_and_live` + `realtime_short` acceptance from elaboration. A dedicated poll
would be belt-and-suspenders and is left for a follow-up if ever needed.

## Impact

- Affected code: `src/contexts/dashboard-event-context.tsx`,
  `src/contexts/agent-presence-context.tsx`.
- Affected tests: `src/contexts/__tests__/dashboard-event-context.test.tsx`,
  `src/contexts/__tests__/agent-presence-context.test.tsx`.
- User-visible: the daemon active-session marker on the Idea Tracker (flat + lineage
  views) and any other `activeSessionsByIdea` consumer becomes stable across
  reloads, redirects, deep links, and reconnects.
- No API, schema, or server-contract change. The server replay contract is
  unchanged; only the client's reset ordering changes.
