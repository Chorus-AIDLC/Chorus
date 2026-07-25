## Context

The notification SSE stream is the daemon's only permanently open connection. The server emits a comment every 30 seconds, but `SseListener` ignores comments and waits indefinitely in `reader.read()` when a network device silently blackholes the socket. Undici normally raises `UND_ERR_BODY_TIMEOUT` after about 300 seconds, but that implicit default is too slow and does not cover every half-open failure mode.

The server currently calls `touchConnection` from the same timer that writes the outbound heartbeat. That proves only that the server timer ran. If the peer disappeared without an observable abort, the timer continues refreshing `lastSeenAt`; `assertContinuable` therefore sees a fresh origin and permits a turn that no daemon can receive. The existing stale-origin behavior is already correct: after 90 seconds without a valid touch, instruction submission returns a structured 409 before creating a turn.

## Goals / Non-Goals

**Goals:**

- Detect an SSE stream that has delivered no bytes for 75 seconds.
- Reuse the existing abort, reconnect backoff, and notification backfill flow.
- Make server-side connection freshness depend on proof that the daemon received a heartbeat.
- Fence delayed acknowledgments so an obsolete stream cannot refresh a newer registration generation.
- Prove recovery with deterministic tests and a no-FIN/no-RST network fault.

**Non-Goals:**

- Retrying `turnAdvance`, `executionState`, `reportInterrupt`, or `readPendingTurns`.
- Adding limits or TTLs to the event-router `seen` set or lineage cache.
- Changing the 30-second heartbeat cadence, 90-second server staleness threshold, instruction API error shape, or origin-pinning semantics.
- Guaranteeing delivery of an instruction accepted immediately before a connection becomes stale; reconnect backfill remains the durability mechanism.

## Decisions

### Use a byte-arrival watchdog in `SseListener`

Each successful stream starts a 75-second deadline. Every non-empty chunk returned by `reader.read()` refreshes it before decoding, so comments, partial frames, and data events all count as transport activity. On expiry, the listener logs a distinct warning and aborts that connection. The normal stream-exit logic schedules reconnect, and `onReconnect` performs backfill.

The watchdog is connection-generation local: reconnect and explicit `disconnect()` clear the prior timer, and a stale timer may not abort a replacement controller. The timeout is injectable for tests but is not exposed as user configuration in this change.

Alternative considered: rely on undici's 300-second `bodyTimeout`. It is implicit, slower, and transport-implementation dependent.

### Negotiate acknowledgment liveness explicitly

An upgraded daemon adds `livenessAck=v1` to its SSE self-report. The server treats only this exact capability value as acknowledgment-aware. For an opted-in stream, the server does not call `touchConnection` from its outbound timer and expects client acknowledgments. For a stream without the capability, including every old daemon, the server retains legacy timer-side touches.

This supports a server-first rolling deployment: deploying the server changes no legacy client's liveness, then each upgraded daemon opts into truthful liveness when it reconnects. Unknown capability values fall back to legacy behavior. After the minimum supported CLI version includes acknowledgments, a later independent cleanup may remove the compatibility branch.

Alternative considered: infer support from `clientVersion`. Explicit protocol negotiation avoids semver parsing, prerelease ambiguity, and coupling transport behavior to packaging metadata.

### Make heartbeat receipt produce a generation-fenced acknowledgment

The `connection_registered` handshake includes the connection UUID and its registration-generation timestamp (or an equivalent opaque lease token). After parsing each `: heartbeat` comment, the daemon sends a best-effort authenticated acknowledgment carrying both values to a narrow daemon connection heartbeat endpoint.

The endpoint reconstructs the existing `ConnectionHandle` fence and calls `touchConnection`; an acknowledgment from an older stream therefore updates zero rows after a newer generation has registered. Authentication and company/agent ownership checks are applied before the write. The acknowledgment does not enter the notification router or wake path.

Acknowledgment failure is logged at a bounded cadence and is not retried by this change. If the network is broken, failures stop `lastSeenAt` from advancing, which is the desired liveness result. A transient failure may temporarily age the row, but the next 30-second heartbeat can refresh it before the 90-second threshold.

Alternative considered: continue touching from the server heartbeat timer and inspect `controller.enqueue`. Enqueue success only proves that a local stream buffer accepted bytes, not that the remote daemon received them, so it cannot close the false-online gap.

### Preserve the existing server refusal path

For opted-in streams, the server removes the timer-side `touchConnection` call but keeps heartbeat emission and abort cleanup. Legacy streams retain timer-side touches during the rolling compatibility window. All effective-online readers continue using `status === "online" && age <= 90s`. `assertContinuable` and the instruction route therefore already provide the selected behavior for upgraded daemons: stale origin means the existing read-only 409 and no turn mutation.

### Verify the actual half-open failure

Unit tests use fake timers and controlled streams to cover chunk refresh, heartbeat parsing and acknowledgment, timeout abort, timer cleanup, stale-generation fencing, and 409-before-mutation behavior. An integration fault test places a TCP proxy between listener and SSE server, establishes the stream, then blackholes traffic without closing either socket. It must observe watchdog expiry, reconnect, backfill of a notification created during the gap, and server staleness/refusal while acknowledgments are absent.

## Module Contracts

- `SseListener` owns the 75-second byte watchdog and clears all connection-local timers on replacement or disconnect.
- SSE heartbeat comments remain invisible to `onEvent`; they additionally trigger a best-effort liveness acknowledgment.
- The SSE handshake provides a generation fence. A heartbeat acknowledgment must identify both connection UUID and generation.
- `livenessAck=v1` selects acknowledgment-driven liveness; absent or unknown values select the legacy timer-touch behavior.
- For opted-in streams, only a valid acknowledgment for the active generation advances `lastSeenAt`; outbound server heartbeat ticks never do.
- Existing `STALE_THRESHOLD_MS`, `SessionReadOnlyError`, HTTP 409 mapping, origin pinning, reconnect backoff, and backfill semantics remain authoritative.

## Risks / Trade-offs

- [Risk] A transient heartbeat-acknowledgment failure makes a live daemon appear stale. -> Three 30-second opportunities fit within the inclusive 90-second threshold; subsequent successful acknowledgments restore freshness.
- [Risk] A delayed request from an obsolete stream refreshes the active row. -> Fence every update on the generation value emitted by registration.
- [Risk] The watchdog timer from an old connection aborts a new one. -> Capture the controller/generation in the timer closure and clear it on every lifecycle transition.
- [Risk] Fault-injection tests are timing-sensitive. -> Keep unit coverage on fake timers and use generous bounded assertions only for the network-level proof.

## Migration Plan

Deploy the server first. Streams without `livenessAck=v1` continue using legacy timer-side touches, so existing daemons remain online. Deploy the new CLI next; each upgraded daemon advertises the capability on connect and enters acknowledgment-driven liveness. Rollback of the CLI reconnects without the capability and automatically restores legacy behavior; rollback of the server ignores the extra query parameter. No data migration or atomic release is required.

## Open Questions

None. Implementation must choose either the existing `connectedAt` value or a new opaque lease token as the wire fence without adding persistent schema state.
