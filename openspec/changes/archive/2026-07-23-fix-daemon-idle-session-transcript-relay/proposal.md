# Fix #444 — daemon idle-session continuation: empty turns + duplicate instructions

## Why

GitHub issue **#444** (reporter: expoli): in daemon mode, after a session has been
idle for a long time (reporter: ~1 day), continuing the conversation produces a bug —
the same instruction appears repeated across turns 2 / 3 / 4, each turn is immediately
marked **"已结束" (ended)**, and each shows **"该回合没有保留对话记录" (this turn kept
no conversation record)**. The user's read is "无法拉起新回合 / 闲置之后无法发送指令".

Reporter environment: server ~0.14.3 **Docker**, **Linux**, agent **cc** (Claude Code),
daemon started with bare `npx @chorus-aidlc/chorus daemon`, idle **~1 day**. Reporter
log note: *"有报错…当时上传好像没上传上来。有日志，但是看着不像是报错"* (there was
something; an upload seemed to not get uploaded; the logs don't look like errors).

### Verified root cause (not a wake/delivery failure)

The UI **"已结束"** state is reachable ONLY via `pending → running → ended`, and the
daemon reports `ended` **only after it actually spawned `claude` AND the subprocess
exited cleanly (code 0)** (`cli/waker.mjs`; a never-spawned wake leaves the turn
`pending`; a dirty exit or the server orphan-reconcile yields `interrupted`, not
`ended`). Because the turns reached `ended`, the daemon→server `turn-advance` REST
channel was healthy — so the daemon **did** wake, run, and cleanly finish each turn.
The lost piece is the **transcript**: the agent's reply never became visible in Chorus.

Two deterministic defects in the daemon's transcript relay were **reproduced** against
the real `cli/upload-hooks.mjs` (see `design.md` §Reproduction):

1. **No flush-on-exit / no drain-on-stop.** The transcript hooks expose only
   `onConnect / onSessionStart / onTranscriptMessage / onExecutionChange` — there is
   **no `flush()` / `onSessionEnd()`**. Transcript messages are POSTed on a 50 ms
   debounce, but `waker.wake()` advances the turn to `ended` the instant the subprocess
   exits, and `daemon.stop()` drains the wake queue but never the transcript buffer. A
   batch still in the debounce window when the wake exits (or when the daemon restarts
   after a long idle) is silently lost.
2. **No retry on a failed POST.** A single non-2xx transcript POST (e.g. a 502 from the
   Docker reverse proxy — exactly the reporter's setup) **permanently drops** the turn's
   transcript: one `warn` log, no retry — which is why the reporter's logs "don't look
   like errors."

The **duplicate turns 2 / 3 / 4** are a separate, compounding defect: the send box gives
**zero success feedback** (`send-instruction-box.tsx` — "the sent turn appears live via
SSE"), so when the turn ends empty the user sees nothing happen and retries, each retry
minting a fresh `human_instruction` `pending` turn with identical text.

## What Changes

Three coordinated fixes, one per capability area, matching the elaboration decisions
(scope = **both** root-cause + stop-the-bleed):

- **Daemon transcript-relay reliability (root cause).**
  - Add an `onSessionEnd` hook (with a synchronous-capable `flush`) to the transcript
    upload hooks; `waker.wake()` **awaits the flush BEFORE** advancing the turn to
    `ended` / `interrupted`, so a turn's trailing transcript is always attached while the
    turn is still `running` (the server attaches transcript to the `running` turn).
  - Add **bounded retry with backoff** to the transcript upload (a transient non-2xx /
    network error is retried a few times before the batch is dropped-with-a-loud-warn).
  - `daemon.stop()` **drains the transcript buffer** (awaits `onSessionEnd`/flush for the
    active session) alongside the existing wake-queue drain.

- **Idempotent `human_instruction` (stop the duplicates).** When a `human_instruction`
  turn is created for a session that already has an **unconsumed (`pending`)
  `human_instruction` turn with identical `promptText`**, collapse to the existing turn
  (return it, re-ping it) instead of minting a duplicate — so a user's retries never pile
  up empty turns 2 / 3 / 4.

- **Honest send + empty-turn UX (stop-the-bleed).**
  - The send box shows explicit **success feedback** after a send lands (so the user
    knows it was accepted and doesn't retry blindly).
  - A **terminal** (`ended` / `interrupted`) `human_instruction` turn that produced **no
    visible messages** renders as a comprehensible **"回合结束，但未收到回复"** state
    with a **one-click retry**, instead of the dead-end neutral "该回合没有保留对话记录".
    All new strings localized in **4 locales** (en / zh / ko / ja).

### Out of scope

- **Pending-turn timeout / auto-reconcile.** The reported turns reached `ended` (they were
  not stuck `pending`), so a pending-turn watchdog does not address #444; deferred.
- **`claude --resume` cold-start-on-missing-transcript.** The daemon already probes the
  on-disk transcript and cold-starts (`--session-id`) when it is absent, and the evidence
  points at relay loss, not resume failure. The existing behavior is kept; not re-worked.

## Capabilities

- `daemon-session-conversation` — the daemon session / turn / transcript relay machinery
  and its send + empty-turn presentation. (ADDED requirements below; the existing
  capability spec is extended, not replaced.)

## Impact

- **Daemon CLI** (`cli/upload-hooks.mjs`, `cli/waker.mjs`, `cli/daemon.mjs`,
  `cli/daemon-rest-client.mjs`): additive hook + retry + drain; no wire-contract change.
- **Server** (`src/services/notification-turn.ts` / `notification.service.ts`):
  idempotent `human_instruction` turn creation; no schema change, no migration.
- **Frontend** (`src/components/agent-presence/…`, `messages/{en,zh,ko,ja}.json`):
  send-success feedback + empty-terminal-turn retry affordance.
- **No Prisma schema / migration changes.** No new dependency.
- **Backward compatible:** old daemons (without the new `onSessionEnd`) keep working —
  the flush is best-effort and the server idempotency + UI changes stand alone.
