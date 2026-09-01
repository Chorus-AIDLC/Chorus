## ADDED Requirements

### Requirement: One dashboard EventSource per tab
The authenticated dashboard SHALL use exactly one physical EventSource for browser change, presence, execution, session activity, transcript, and notification delivery. The EventSource SHALL remain stable across page navigation and SHALL reconnect only for transcript-session selection or connection recovery.

#### Scenario: Project dashboard mounts
- **WHEN** the authenticated dashboard mounts its shell and a project-scoped realtime page
- **THEN** the browser opens exactly one EventSource and its URL targets `/api/events`

#### Scenario: Navigation changes project
- **WHEN** the user navigates between dashboard projects without changing the selected transcript session
- **THEN** the physical EventSource remains open and is not replaced because of the project change

#### Scenario: Transcript session changes
- **WHEN** the selected transcript session changes
- **THEN** the shared EventSource reconnects with the new encoded `sessionUuid` and all domain subscribers remain registered

### Requirement: Shared realtime preserves event scopes
The unified browser stream SHALL deliver company-visible execution and session events without page-project filtering. A project-scoped realtime consumer MUST reject change and presence events for other projects before invoking throttle, debounce, general refresh, entity, or presence subscribers.

#### Scenario: Matching project change
- **WHEN** a change or presence event has the mounted realtime provider's `projectUuid`
- **THEN** the provider routes it through the existing page subscription behavior

#### Scenario: Unrelated project event
- **WHEN** a change or presence event has a different `projectUuid`
- **THEN** the provider invokes no page subscriber and schedules no throttle or debounce work

#### Scenario: Company-visible execution on any project page
- **WHEN** the stream emits an execution event visible to the authenticated caller
- **THEN** execution consumers receive it regardless of the mounted page project

### Requirement: Browser notifications share the main stream
The main `/api/events` route SHALL forward the authenticated browser user's existing notification-channel payloads on the unified stream. Daemon registration, control, liveness, disconnect, and notification transport MUST remain available on `/api/events/notifications`.

#### Scenario: Browser notification arrives
- **WHEN** the notification event bus publishes an event for the authenticated dashboard user
- **THEN** `/api/events` forwards the unchanged notification payload and the browser does not open `/api/events/notifications`

#### Scenario: Daemon connects to notification transport
- **WHEN** a daemon connects to `/api/events/notifications` with self-report parameters
- **THEN** its registration, control, liveness, disconnect, and notification behavior remains unchanged

#### Scenario: Unified stream aborts
- **WHEN** a browser `/api/events` request is aborted
- **THEN** its notification-channel listener and all other event listeners and timers are removed

### Requirement: Notification visibility behavior is preserved
Notification consumers SHALL read `document.visibilityState` when each notification is received. They MUST show a notification toast only while the document is visible, MUST allow unread counts to update while hidden, and MUST reconcile unread state through REST when the document becomes visible.

#### Scenario: Notification received while visible
- **WHEN** a `new_notification` event arrives and `document.visibilityState` is `"visible"`
- **THEN** the unread count updates and one toast is shown

#### Scenario: Notification received while hidden
- **WHEN** a `new_notification` event arrives and `document.visibilityState` is `"hidden"`
- **THEN** the unread count updates and no toast is shown

#### Scenario: Visibility changes after subscriber creation
- **WHEN** visibility changes between subscription time and notification receive time
- **THEN** toast behavior uses the visibility value at receive time rather than a captured earlier value

#### Scenario: Hidden tab becomes visible
- **WHEN** the document transitions from hidden to visible
- **THEN** the notification consumer fetches the unread aggregate through REST without reconnecting the shared EventSource

### Requirement: Reconnects trigger domain catch-up
The shared event provider SHALL expose a monotonically increasing open generation and distinguish initial connection from subsequent opens. Realtime and agent-presence consumers MUST run their existing catch-up behavior after a subsequent open where events may have been missed.

#### Scenario: Stream reopens after interruption
- **WHEN** the EventSource opens after an earlier successful open
- **THEN** realtime triggers general and entity catch-up and agent presence refreshes the execution aggregate

#### Scenario: Initial stream open
- **WHEN** the EventSource opens for the first time
- **THEN** consumers use their existing initial fetch paths without duplicate reconnect catch-up work

### Requirement: Standalone realtime fallback remains supported
A `RealtimeProvider` mounted outside the dashboard shared-event provider SHALL manage its own `/api/events` EventSource with optional project scoping and SHALL close it and clear all timers on unmount.

#### Scenario: Standalone project provider
- **WHEN** a project-scoped `RealtimeProvider` mounts without the shared dashboard provider
- **THEN** it opens `/api/events?projectUuid=<encoded-project-uuid>` and preserves its existing event routing

#### Scenario: Standalone provider unmounts
- **WHEN** the standalone provider unmounts
- **THEN** it closes its EventSource, removes visibility listeners, and clears pending throttle and debounce timers
