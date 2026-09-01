## 1. Unified server transport

- [x] 1.1 Add authenticated browser-user notification-channel forwarding and abort cleanup to `/api/events`.
- [x] 1.2 Preserve `/api/events/notifications` daemon registration, control, liveness, disconnect, and notification behavior.
- [x] 1.3 Extend route tests for browser notification forwarding, tenant/user isolation, unchanged payloads, and listener cleanup.

## 2. Shared dashboard event spine

- [x] 2.1 Introduce a transport-only `DashboardEventProvider` with one EventSource, typed subscriptions, transcript-session selection, open generations, visibility recovery, and cleanup.
- [x] 2.2 Migrate AgentPresence execution, session activity, transcript, reconnect reset, and execution catch-up behavior to the shared provider.
- [x] 2.3 Reorder the authenticated dashboard provider composition so AgentPresence, Notification, and Realtime consume the shared spine.

## 3. Realtime and notification consumers

- [x] 3.1 Migrate `RealtimeProvider` to shared change, presence, execution, and open-generation subscriptions while retaining its standalone EventSource fallback.
- [x] 3.2 Apply project filtering before all realtime throttle, debounce, and subscriber work, while preserving company-visible execution delivery.
- [x] 3.3 Remove the dashboard notification EventSource, consume shared notification events, gate toasts on receive-time visibility, retain hidden unread updates, and reconcile unread state on visible transitions.

## 4. Regression verification

- [x] 4.1 Add provider integration tests proving one dashboard EventSource, stable navigation, session-driven reconnect, and complete unmount cleanup.
- [x] 4.2 Add tests for matching/unrelated project routing, company-visible execution, initial versus reopen catch-up, and standalone realtime fallback.
- [x] 4.3 Add notification tests for visible and hidden delivery, stale-closure-resistant toast gating, hidden unread updates, visible REST reconciliation, and no duplicate event handling.
- [x] 4.4 Run focused route/context suites plus applicable type-check and lint validation.
