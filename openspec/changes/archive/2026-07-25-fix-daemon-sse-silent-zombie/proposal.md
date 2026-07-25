## Why

A daemon can become deaf after an idle network path silently drops its long-lived SSE socket without FIN or RST. The client then waits in `reader.read()` until an implicit undici timeout, while the server's own heartbeat timer falsely keeps the connection online and accepts instructions that the daemon cannot receive.

## What Changes

- Add a fixed 75-second client-side SSE byte watchdog. Any received bytes, including SSE comments, refresh the deadline; expiry aborts the current stream and enters the existing reconnect and backfill path.
- Let upgraded daemons advertise `livenessAck=v1`, then replace server-generated liveness writes for those streams with authenticated, generation-fenced acknowledgments sent after receiving an SSE heartbeat.
- Preserve legacy timer-side touches for clients that do not advertise the capability, enabling server-first rolling deployment without making old daemons stale.
- Preserve the existing 90-second effective-online threshold and 409 read-only response, but make `lastSeenAt` evidence that the daemon is alive rather than evidence that a server timer is running.
- Add deterministic stream tests plus a network fault-injection test that blackholes an established connection without FIN or RST.
- Do not add retries to unrelated daemon REST calls and do not address unbounded CLI caches in this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-daemon`: Detect silent notification-stream stalls and recover through the existing reconnect and backfill path.
- `daemon-connection-registry`: Base connection freshness on client acknowledgments fenced to the active connection generation.

## Impact

- CLI: `cli/sse-listener.mjs`, daemon REST transport wiring, and focused listener/backfill tests.
- Server: notification SSE handshake payload, a daemon-authenticated connection heartbeat endpoint, connection registry liveness writes, and route/service tests.
- Contract: upgraded clients opt in with `livenessAck=v1`, and the handshake gains an opaque generation value used only to fence heartbeat acknowledgments; no database migration or external dependency is required.
- User-visible behavior: an origin that stops acknowledging heartbeats becomes read-only under the existing 90-second rule, so instruction submission returns the existing structured 409 instead of creating a pending turn.
