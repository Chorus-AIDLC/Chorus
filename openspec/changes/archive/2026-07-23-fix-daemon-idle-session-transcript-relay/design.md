# Design — fix daemon idle-session transcript relay (#444)

## Context

Daemon-mode session continuation. Two "session" concepts exist; the bug is in the
**`DaemonSession` + `DaemonSessionTurn`** durable conversation (not the swarm
`AgentSession`). A wake runs headless `claude -p --output-format stream-json`; the
daemon parses NDJSON, relays user/assistant text to `POST /api/daemon/transcript`, and
advances the turn lifecycle `pending → running → ended|interrupted` via
`POST /api/daemon/turn-advance`.

Key invariant that anchors the diagnosis (`cli/waker.mjs`, `turn-band.tsx`): a turn only
reaches **`ended`** when the daemon actually spawned `claude` and it **exited code 0**;
the daemon reports `ended` in the subprocess-exit path. A never-spawned wake stays
`pending`; a dirty exit / server orphan-reconcile is `interrupted`. So the screenshot's
clean-`ended` + empty turns prove the daemon **ran** the turns and the
`turn-advance` channel was healthy — the transcript is what went missing.

## Reproduction

`/tmp/repro444.mjs` drove the REAL `cli/upload-hooks.mjs` (`createTranscriptUploadHooks`)
with an injected `fetchImpl`. Findings:

```
hook keys: [ onConnect, onSessionStart, onTranscriptMessage, onExecutionChange ]
has flush()?: undefined   has onSessionEnd()?: undefined
posted immediately after exit (before debounce fires): []   ← turn ends with transcript UNSENT
posted after debounce w/ failing POST: [{ ok:false, n:1 }]
total upload attempts (retry would be >1): 1                ← single 502 → transcript DROPPED
warn logs: ["[Chorus] transcript upload returned 502"]
```

Two confirmed defects:

1. **No flush-on-exit.** The hooks expose no `flush()` / `onSessionEnd()`. Transcript is
   POSTed on a 50 ms debounce (`createTranscriptUploadHooks`, `batchDelayMs = 50`), but
   `waker.wake()` advances the turn to `ended` the instant the subprocess exits — the last
   batch is still in the debounce buffer. `daemon.stop()` drains the wake queue
   (`queue.drain`) but never the transcript buffer.
2. **No retry.** `daemon-rest-client.transcript()` → `post()` returns `{ ok:false }` on a
   non-2xx and logs one `warn`; the caller (`upload()`) swallows it. A single 502 (Docker
   reverse-proxy hiccup) permanently loses the turn's transcript.

Duplicate turns 2 / 3 / 4: `send-instruction-box.tsx` `send()` shows **no success
feedback** ("the sent turn appears in the transcript live (SSE)"), so an empty-ended turn
reads as "nothing happened" → the user retries → each retry mints a new `human_instruction`
`pending` turn (`createInstructionTurn` → `createReturningTurn`, no idempotency).

## Goals / Non-Goals

**Goals**
- A turn's trailing transcript is reliably persisted before the turn is marked terminal.
- A transient transcript POST failure is retried, not silently dropped.
- A daemon shutdown/restart flushes the active session's transcript buffer.
- Retried identical instructions collapse instead of minting duplicate empty turns.
- An empty terminal `human_instruction` turn reads honestly and offers retry.

**Non-Goals**
- Pending-turn watchdog/timeout (turns reached `ended`, not stuck) — out of scope.
- Re-work of `claude --resume` cold-start (already probes disk + cold-starts) — kept.
- No wire-contract change to `/api/daemon/*`, no Prisma migration, no new dependency.

## Decisions

### D1 — Flush-before-terminal in the waker (root cause, primary)

Add `onSessionEnd({ sessionId })` to `UploadHooks`. In `createTranscriptUploadHooks` it
**cancels the debounce timer and awaits the in-flight + pending batch** (drains `pending`
through the serialized `chain`). `waker.wake()`, in its subprocess-exit path, **awaits
`hooks.onSessionEnd({ sessionId })` BEFORE** calling `advanceTurn(ended|interrupted)`.

Why this ordering is correct: the server's `appendTranscriptMessages` attaches transcript
to the session's **`running`** turn (falling back to most-recent seq). Flushing while the
turn is still `running` guarantees the trailing text lands on the correct turn — before
the `→ ended` transition. It also naturally covers **shutdown**: `interruptAll()` kills the
subprocess, the wake-exit path runs, flushes, then advances to `interrupted(shutdown)`, and
`daemon.stop()`'s existing `queue.drain(...)` already awaits that wake — so the transcript
buffer is drained within the same bounded window (no separate stop-path plumbing needed;
`mergeUploadHooks` gains a fan-out `onSessionEnd` for completeness).

`onSessionEnd` is **best-effort + non-throwing** (mirrors the fire-and-forget contract):
a flush failure is logged, never crashes the wake. Old daemons without it are unaffected
(the merged hooks simply have nothing to fan out to).

### D2 — Bounded retry in the transcript upload (root cause, primary)

`createTranscriptUploadHooks.upload()` retries a failed `client.transcript(...)` with a
small bounded backoff (default **3 attempts**, ~200 ms × attempt), then drops-with-a-loud
`warn` naming the dropped message count. Retry lives in the hook (host-side), NOT in the
shared `daemon-rest-client` (which stays a single-shot transport by contract). Injectable
`sleepImpl` + attempt cap keep it unit-testable with no real timers.

### D3 — Idempotent `human_instruction` turn creation (stop duplicates, server)

In the `human_instruction` turn-creation path (`createTurnAndResolveTarget` step 6, reached
via `sendInstruction → createInstructionTurn → createReturningTurn`), before
`createPendingTurn`, look for an existing **`pending`** `human_instruction` turn on the same
session whose `promptText` **equals** the new instruction text. If found, **return that turn**
(and re-issue the `deliver_turn` ping) instead of creating a second one. Scope is tight:
same session, `status = "pending"` (never a `running`/terminal turn), `trigger =
human_instruction`, exact text match — so distinct instructions and legitimate re-sends
after a turn has started are unaffected. This directly collapses retry-storm turns 2/3/4.

### D4 — Send-success feedback (stop-the-bleed, frontend)

`ConversationReplyBox.send()` (and the shared `send-instruction-box` compose path) shows an
explicit success signal on a 2xx (a subtle inline "已发送 / Sent" confirmation via the
existing toast/inline affordance) so the user knows the instruction was accepted even
before the agent's reply streams in. Keeps the existing error toast.

### D5 — Honest empty terminal turn + retry (stop-the-bleed, frontend)

In `turn-band.tsx`, a turn that is **terminal** (`ended` / `interrupted`), of trigger
**`human_instruction`**, with **zero visible messages**, renders a comprehensible band —
**"回合结束，但未收到回复"** (turn ended without a reply) — plus a **Retry** action that
re-sends the same `promptText` as a new instruction (reusing the send endpoint; the D3
idempotency guard means a double-tap can't duplicate). Autonomous empty turns keep the
existing neutral "no messages" placeholder (they legitimately may produce only tool calls).
New i18n keys added to **all 4 locales** (en / zh / ko / ja).

## Module contracts

| Site | Change |
|---|---|
| `cli/upload-hooks.mjs` | `UploadHooks` gains `onSessionEnd?`. `createTranscriptUploadHooks` implements `onSessionEnd` (cancel timer + await drain) and bounded retry in `upload()`. `mergeUploadHooks` fans out `onSessionEnd`. `createNoopUploadHooks` gains a no-op `onSessionEnd`. |
| `cli/waker.mjs` | Exit path awaits `hooks.onSessionEnd({ sessionId })` before `advanceTurn(ended|interrupted)` (guarded, non-throwing). |
| `cli/daemon.mjs` | No new stop plumbing needed (queue.drain already awaits the flushing wake); confirm the active-session flush is covered by a shutdown test. |
| `src/services/notification-turn.ts` | `createTurnAndResolveTarget`: idempotent collapse of a duplicate unconsumed `human_instruction` pending turn (D3). |
| `src/components/agent-presence/send-instruction-box.tsx` | Success feedback on send (D4). |
| `src/components/agent-presence/chat/turn-band.tsx` | Empty terminal human_instruction turn → "ended without reply" + Retry (D5). |
| `messages/{en,zh,ko,ja}.json` | New keys for D4/D5 strings. |

## Risks

- **Flush adds latency to the wake-exit path.** Bounded by the retry cap × backoff; the
  wake is already async and the turn-advance is not user-blocking. Acceptable.
- **Idempotency false-collapse.** Mitigated by the tight match (same session + `pending`
  + `human_instruction` + exact text). A user deliberately sending the identical text
  twice while the first is still `pending` (un-started) is exactly the case we WANT to
  collapse (the agent hasn't consumed it yet).
- **Frontend verification is browser + theme-sensitive** (D4/D5 touch UI in both light
  and dark). Automated tests cover logic; the live-browser + `design.pen` acceptance is a
  headless-daemon gap — flagged for human sign-off in the task ACs.

## Test strategy

- **cli**: extend `transcript-upload-hooks.test.mjs` — `onSessionEnd` drains a pending
  batch; `upload()` retries a transient failure then succeeds; gives up after the cap with
  a warn. `waker` test: exit path awaits flush before `advanceTurn(ended)` (assert order).
- **server**: `notification-turn` / `daemon-instruction` test — a second identical
  `human_instruction` on a session with an unconsumed pending turn returns the SAME turn
  (no duplicate row); a different text, or a text whose prior turn is already `running`,
  creates a new turn.
- **frontend**: `turn-band` renders the "ended without reply" + Retry only for terminal,
  empty, `human_instruction` turns; send box shows success feedback on 2xx. Logic via
  Vitest; live-browser both-theme check flagged for human.
