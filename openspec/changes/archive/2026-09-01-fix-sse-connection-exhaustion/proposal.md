## Why

Each authenticated dashboard tab currently opens three long-lived SSE connections. In direct HTTP/1.1 Docker deployments, two tabs can consume the browser's six same-origin connections and indefinitely queue navigation, RSC, and API requests, as reproduced in GitHub Issue #521.

## What Changes

- Consolidate browser realtime change/presence, agent execution/session/transcript, and notification delivery onto one stable company-wide `/api/events` EventSource per dashboard tab.
- Keep the shell-level event spine stable across page navigation; page realtime consumers filter change and presence events by `projectUuid` before throttle, debounce, or subscriber work.
- Preserve the existing company/visibility scope for execution and session events.
- Add browser notification delivery to `/api/events` while retaining `/api/events/notifications` for daemon registration, control, and notification transport.
- Preserve notification UX after consolidation: hidden tabs update unread state but do not show toasts; visible transitions reconcile unread state through REST.
- Preserve a standalone EventSource fallback for `RealtimeProvider` when it is mounted outside the authenticated dashboard shell.
- Add regression coverage for one EventSource per tab, event routing, reconnect catch-up, visibility behavior, and cleanup.

## Capabilities

### New Capabilities

- `unified-browser-sse`: Defines the single-stream browser transport, routing scopes, notification visibility semantics, reconnect recovery, and standalone fallback.

### Modified Capabilities

- None.

## Impact

- Affects the main and notification SSE routes, `AgentPresenceProvider`, `RealtimeProvider`, `NotificationProvider`, dashboard provider composition, and their tests.
- Browser clients move from three SSE connections to one; daemon clients continue using `/api/events/notifications`.
- No database migration or new runtime dependency is required.
- HTTP/2 remains a recommended deployment improvement, but direct HTTP/1.1 deployments no longer depend on it for ordinary multi-tab use.
- Implementation and tests are in scope after proposal approval; creating or merging a pull request still requires separate explicit authorization.
