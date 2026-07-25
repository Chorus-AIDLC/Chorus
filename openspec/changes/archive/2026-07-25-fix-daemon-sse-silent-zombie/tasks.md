## 1. Client Watchdog and Acknowledgment

- [ ] 1.1 Add the generation-local 75-second byte watchdog to `SseListener`, including refresh-on-chunk, abort-to-reconnect, and lifecycle cleanup.
- [ ] 1.2 Advertise `livenessAck=v1`, parse the registration generation, and acknowledge received heartbeat comments through a narrow best-effort daemon REST call without forwarding them into the event router.
- [ ] 1.3 Add fake-timer and controlled-stream tests for timeout, refresh, reconnect/backfill, acknowledgment failure, and obsolete-timer isolation.

## 2. Truthful Server Liveness

- [ ] 2.1 Extend the connection handshake with a generation fence and add an authenticated heartbeat-acknowledgment route that calls the existing generation-fenced registry touch.
- [ ] 2.2 Disable timer-side `lastSeenAt` updates only for `livenessAck=v1` streams; preserve legacy touches for absent/unknown capabilities plus SSE emission, abort cleanup, the 90-second rule, and existing 409 mapping.
- [ ] 2.3 Add route and service regressions for valid, unauthorized, cross-owner, and stale-generation acknowledgments plus 409-before-turn-creation behavior.

## 3. Half-Open Network Verification

- [ ] 3.1 Add a bounded fault-injection harness that blackholes an established SSE connection without FIN or RST.
- [ ] 3.2 Verify watchdog-triggered reconnect, missed-notification backfill, absence of false server freshness, and stale-origin 409 end to end; record observed recovery timing.
