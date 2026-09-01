## Context

The authenticated dashboard currently mounts three independent browser EventSources:

- `RealtimeProvider` opens `/api/events?projectUuid=...` (or `/api/events`) for page change, presence, and execution subscribers.
- `AgentPresenceProvider` opens a stable company-wide `/api/events`, optionally adding `sessionUuid`, for execution, session activity, and transcript events.
- `NotificationProvider` opens `/api/events/notifications` for unread counts and notification toasts.

The shell-level `/api/events` route already multiplexes change, presence, execution, session activity, and transcript events. The company stream therefore sends change/presence events that AgentPresence currently parses and ignores, while Realtime opens another stream to receive part of the same traffic. Browser notification events use a separate user channel on the notification route. Direct HTTP/1.1 deployments expose the browser connection-limit failure described in Issue #521.

## Goals / Non-Goals

**Goals:**

- Use exactly one long-lived EventSource for the authenticated dashboard tab.
- Keep that physical stream company-wide and stable across page navigation.
- Preserve current page project isolation, execution/session visibility, notification UX, and reconnect recovery.
- Keep daemon registration, reverse control, and notification transport on `/api/events/notifications`.
- Keep `RealtimeProvider` usable outside the dashboard shell.

**Non-Goals:**

- Sharing a connection across tabs through SharedWorker, BroadcastChannel leader election, or a service worker.
- Removing `/api/events/notifications` or changing daemon transport.
- Dynamically reconnecting the shell stream when page project scope changes.
- Guaranteeing unlimited tabs on HTTP/1.1; HTTP/2 remains recommended.
- Changing database schemas or notification persistence.

## Decisions

### Introduce a dedicated shell event-spine provider

A new `DashboardEventProvider` will own the sole dashboard `EventSource("/api/events")`, raw parsed-event subscriber registries, the selected transcript `sessionUuid`, and a monotonically increasing open generation. It wraps `AgentPresenceProvider`, `NotificationProvider`, and page `RealtimeProvider` instances.

This separates transport ownership from AgentPresence's domain state and avoids making Notification depend on a provider currently nested inside it. It also removes the runtime/type dependency cycle that would result if Realtime imported AgentPresence while AgentPresence imported Realtime event types.

The provider reconnects only for the existing low-frequency reasons: selected transcript session changes, a non-open stream is detected on visibility resume, or native EventSource reconnect completes. Page navigation does not alter its URL or lifecycle.

### Route domain events through stable subscriptions

The provider parses each SSE data message once and fans the typed payload to ref-backed subscribers. Subscription registration and removal do not reconnect the stream.

- `AgentPresenceProvider` subscribes to execution, session activity, transcript, and open-generation events. Its polling, merge generation guard, activity reset, and execution catch-up behavior remain intact.
- `RealtimeProvider` subscribes to change, presence, execution, and open-generation events when the shell spine is available.
- `NotificationProvider` subscribes to notification events and retains its REST unread reconciliation.

When `RealtimeProvider` is mounted without `DashboardEventProvider`, it retains its direct EventSource implementation as a standalone fallback.

### Filter page-scoped events before any page work

The shell stream stays company-wide to avoid navigation reconnect churn. A project-scoped `RealtimeProvider` rejects change and presence events with a different `projectUuid` before touching throttle timers, debounce timers, or subscribers. Unscoped company pages retain company-wide change/presence delivery.

Execution events remain company/visibility scoped. This preserves existing server behavior: the `projectUuid` query parameter filters change and presence handlers but does not filter execution channels.

Client filtering was chosen over dynamic server scope because changing scope requires replacing the EventSource. That would clear/replay session activity and re-fetch execution state on every project navigation, creating more churn and recovery risk than the lightweight early guard.

### Add browser notifications to the main route without moving daemon lifecycle

For authenticated browser-user streams, `/api/events` will subscribe to the existing `notification:<type>:<actorUuid>` event-bus channel and clean it up on abort. The event payload remains unchanged, including `new_notification`, `count_update`, and `unreadCount`.

Daemon clients continue to use `/api/events/notifications`, including registration outcome, control subscription, liveness touch, disconnect reconciliation, and daemon-targeted notifications. The consolidation does not remove or repurpose that route.

The server must not create duplicate browser notification subscriptions across both routes after the client migration; dashboard `NotificationProvider` no longer opens its own EventSource.

### Preserve notification visibility semantics at consumption time

The old notification stream disconnects while the document is hidden. The unified spine remains connected, so notification consumption must explicitly preserve toast behavior:

- On every `new_notification`, read `document.visibilityState` at receive time.
- Call `showToast` only when the value is exactly `"visible"`; do not capture visibility in a stale closure.
- Continue applying `unreadCount` updates while hidden.
- On visibility transition to visible, fetch unread state through REST to reconcile any disconnect or delivery gap.
- Visibility changes affect only notification consumption and never close the shared stream.

### Use open generations for gap recovery

`DashboardEventProvider` increments an open generation whenever the physical EventSource opens. Consumers distinguish initial open from subsequent opens:

- Realtime emits its existing general and entity catch-up notifications after a reopen.
- AgentPresence clears stale activity replay state and re-fetches the execution aggregate after a reopen.
- Notification relies on pushed unread counts plus its visibility REST reconciliation.

Callbacks read current subscriber refs, and all listeners, timers, and subscriptions are removed on unmount.

## Risks / Trade-offs

- **[Risk] Unrelated company events trigger page refresh work.** → Apply `projectUuid` rejection before throttle, debounce, and every page subscriber; regression-test zero callbacks for unrelated projects.
- **[Risk] The unified provider becomes a broad coupling point.** → Keep it transport-only with typed subscription contracts; domain state remains in the three existing providers.
- **[Risk] Hidden tabs start showing notification toasts.** → Gate `showToast` using receive-time `document.visibilityState` and test stale-closure-sensitive visibility changes.
- **[Risk] A reconnect loses events or causes stale views.** → Emit open generations and retain REST/poll catch-up paths; test native and explicit reconnects.
- **[Risk] Browser notifications are delivered twice during migration.** → Remove the dashboard notification EventSource in the same change and test one physical EventSource plus one toast per event.
- **[Trade-off] Company change/presence fan-out remains.** → This traffic already exists on the shell stream, and removing the duplicate project stream lowers total wire events. Revisit server scoping only with measured fan-out evidence.
- **[Trade-off] Six HTTP/1.1 tabs can still occupy six connections.** → One stream per tab materially raises the limit; HTTP/2 or a future cross-tab shared connection is the complete transport-level mitigation.

## Migration Plan

1. Add browser notification forwarding to `/api/events` while retaining the daemon route.
2. Introduce `DashboardEventProvider` and migrate AgentPresence to it.
3. Migrate Realtime and Notification consumers, then reorder dashboard providers so all share the spine.
4. Add route, context, composition, visibility, reconnect, and cleanup tests.
5. Deploy as one atomic application change. Rollback restores the three existing client EventSources; no data migration is involved.

## Open Questions

None required for implementation.
