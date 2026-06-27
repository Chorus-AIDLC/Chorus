# Tasks

## 1. Server: directed deliver_turn ping + target stamp + elaboration_verified origin

- [ ] 1.1 In `notification-turn.ts`, when a turn is created for a PINNED `mentioned`/`task_assigned` wake against the resolved ONLINE target connection, emit a `deliver_turn` control ping on that connection (reuse `deliverTurnPing`/`dispatchControl`, now for these triggers — not only `human_instruction`). Fire-and-forget + non-fatal.
- [ ] 1.2 Stamp the resolved target `connectionUuid` as transport-only data on the wake notification the daemon reads (like `instructionText`) — NOT a persisted `Notification` column — so non-target daemons can suppress.
- [ ] 1.3 Offline pin / no online match (DEC Q2): create NO turn, emit NO ping, stamp NO target → notify-only, no wake. Do NOT fall back to online-first for a PINNED wake (reverses #354's offline-pin scenario). Un-pinned wake: no ping, no target → broadcast→online-first unchanged.
- [ ] 1.4 `elaboration_verified`: resolve target = idea's existing `DaemonSession.originConnectionUuid` (idea-anchored session) when online → ping + stamp; no session or offline origin → no target (online-first fallback). No Idea pin column / DDL.
- [ ] 1.5 Cross-cwd mention: a `mentioned` pin resolving to a `(host,cwd)` whose connection differs from an existing idea session's origin creates the turn on a per-instance session (own transcript) — never re-point an existing session's origin.
- [ ] 1.6 Unit tests: pinned-online → turn+ping+stamp; offline-pin → none (notify-only, changed #354 behavior); un-pinned → none; elaboration_verified resolve + both fallbacks; cross-cwd per-instance session. `tsc --noEmit` + lint clean.

## 2. Daemon: non-target suppression + directed-turn re-dispatch for autonomous triggers

- [ ] 2.1 `cli/event-router.mjs` `#fetchAndRoute`: read the notification's transport-only `targetConnectionUuid`; compare to this daemon's registered uuid (injected, same source `control-handler` uses). target≠me → suppress (log reason); target==me → wake; no target → wake as today (un-pinned byte-identical).
- [ ] 2.2 Pre-handshake window: if this daemon does not yet know its own connection uuid, treat a targeted wake as "not mine" → suppress (delivery covered by the `deliver_turn` to the actual target + reconnect backfill).
- [ ] 2.3 Widen `dispatchPendingTurn` (and the `deliver_turn`→`pendingTurnsOnly` path) so a `mentioned`/`task_assigned`/`elaboration_verified` pending turn is re-dispatched — rebuilding the autonomous wake prompt from the notification/entity (these turns have `promptText = null`, unlike `human_instruction`). See Tech Design "prompt-context constraint".
- [ ] 2.4 Dedup: the target's broadcast copy (`notificationUuid`) and the `deliver_turn`→pending delivery (`turn:{uuid}`) MUST collapse to exactly one wake via the shared `seen` set. Keep `human_instruction`'s path untouched; router stays non-throwing into the SSE loop.
- [ ] 2.5 Unit tests: target≠me suppressed; target==me wakes once; absent wakes (un-pinned identical); pre-handshake suppresses; a directed `mentioned`/`task_assigned`/`elaboration_verified` turn re-dispatches with its own prompt and dedups against the broadcast (single wake).

## 3. Integration checkpoint

- [ ] 3.1 Daemon-integration test: 2 online instances of one agent; a pinned `mentioned` and a pinned `task_assigned` each wake ONLY the pinned instance (the non-target suppresses); an un-pinned wake still wakes online-first; `elaboration_verified` wakes the idea's session-origin instance / falls back when no session. The exact 2-online-instance scenario PR #354's e2e missed.
- [ ] 3.2 `tsc --noEmit` + `pnpm lint` + full `pnpm test` green (coverage thresholds held).
