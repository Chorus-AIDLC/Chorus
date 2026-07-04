# sse-resume-timing delta

## ADDED Requirements

### Requirement: SSE reconnects after tab resume wait for the auth resume gate

Client contexts that react to `visibilitychange` to visible (notification, realtime, and agent-presence) SHALL defer their entire resume-triggered handler work — the EventSource reconnect AND every accompanying network-triggering action in the same handler, including the notification unread-count fetch, the agent-presence executions re-fetch, and the realtime catch-up notifications that fan out into consumer re-fetches — until the auth resume gate settles: the gate is armed by the tab-resume signal, held open while the auth context's resume revalidation (cookie prime plus session probe) is in flight, and settled when that revalidation completes or a hard timeout elapses, whichever comes first. Only the visibility-resume path is gated; initial-mount connections and fetches SHALL proceed immediately. This SHALL bound the number of near-simultaneous middleware-covered requests carrying an expired access token after a resume, so at most one request races to refresh the token instead of one per stream or fetch.

#### Scenario: Resume reconnects are deferred until revalidation settles

- **WHEN** a backgrounded tab with an expired access token becomes visible and the auth
  context begins its resume revalidation
- **THEN** the SSE contexts do not open new EventSource connections until the revalidation
  settles, after which they reconnect using the refreshed cookie

#### Scenario: Accompanying resume fetches are gated with the reconnect

- **WHEN** a visibility-resume handler would, alongside its EventSource reconnect, fetch
  the notification unread count, re-fetch the presence executions aggregate, or emit
  realtime catch-up notifications that trigger consumer re-fetches
- **THEN** none of those requests are issued before the resume gate settles; they run
  after the gate releases, in their existing order

#### Scenario: Gate timeout prevents deadlock

- **WHEN** the resume gate is armed but the revalidation never settles (auth provider
  absent, unmounted, or hung)
- **THEN** waiting SSE contexts are released after the hard timeout and reconnect anyway

#### Scenario: No gating outside a resume window

- **WHEN** an SSE context connects at initial mount, or reconnects while no resume window
  is armed
- **THEN** the connection proceeds immediately without waiting on the gate

#### Scenario: Visibility re-checked after the wait

- **WHEN** an SSE context finishes waiting on the resume gate but the document has been
  backgrounded again during the wait
- **THEN** the context does not open the connection until the next visible transition
