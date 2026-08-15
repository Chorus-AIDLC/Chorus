# Daemon Wake Coalescing

## Why

The daemon serializes wakes per session key (`WakeQueue`, keyed on the direct idea
or the ad-hoc session). While the agent is busy running a turn for a key, every
later wake for that **same** key is enqueued as its own task and, when the slot
frees, runs as its **own** `claude --resume` turn — `buildPrompt(n)` only ever
carries a single notification. So N events that piled up during one turn become N
sequential turns, each re-loading context and re-orienting the agent.

This is wasteful and unnatural in exactly the cases that happen most:

- A human sends several chat messages (`human_instruction`) in a row while the
  agent is mid-turn — each becomes a separate turn instead of one "here is my
  backlog" turn.
- A burst of autonomous events on one idea (several `@mention` comments, a
  sequence of task status changes) stacks up on the same key and drips through
  one turn at a time.

The idea: while queued wakes are **still pending (not yet started)**, merge them
so that when the key's slot frees, **all** the piled-up events are delivered in a
**single** turn (one `claude --resume` call) with one combined prompt.

## What Changes

- **Coalesce pending same-key wakes.** When a session key's execution slot frees,
  the `WakeQueue` drains **all** currently-pending wakes for that key and runs
  them as **one** batch (one subprocess), instead of one wake per turn. Natural
  batching only — no debounce timer; the batch is exactly "whatever piled up while
  the previous turn ran." (Elaboration Q4=a, Q7=b: no cap.)
- **Merge everything on one session, labeled per event.** All events sharing a
  session key merge into the one turn regardless of trigger type (mention +
  task_assigned + human_instruction + start_development + yolo_requested all
  together); the combined prompt states each event's **type and content** in its
  own labeled block. (Q1: owner free-text — "只要是一个 session 上的，所有事件都合并，
  只是在 PE 里写清楚各个事件的类型和事件.")
- **Include human chat backlog in v1.** Multiple queued `human_instruction`
  messages are part of the same coalescing — they land on the same session key as
  autonomous wakes and merge with them. (Q3=a.)
- **Backlog-preamble prompt, per-event blocks, same-entity collapse.** One
  "you have N queued events, handle them together, in order" preamble followed by
  one labeled block per event (reusing the existing per-action body). Repeated
  same-entity/same-action events collapse into one block ("3 new comments on idea
  X", newest shown). (Q5=a, Q2=b.)
- **Single-turn accounting; no stuck queued rows.** A coalesced batch is one
  running turn; the merged-away resources are dropped from the daemon's execution
  snapshot so the server reconcile ends them and the UI never shows them stuck in
  "queued". The daemon reports the coalesced event count; server-side, after the
  oldest pending turn advances to `running`, the next `count − 1` pending turns of
  the session (by seq) are settled to `merged` so coalesced-away turns are not left
  dangling `pending` (which would re-dispatch as duplicate wakes on reconnect).
  (Q6=a.)

Out of scope: any debounce/collect window; per-event token/size-based splitting;
changing cross-key concurrency; changing what counts as a wake action.

## Capabilities

- `daemon-wake-coalescing` (new) — the coalescing scheduler behavior, the batch
  prompt composition, single-turn execution accounting, and the server-side
  settlement of superseded pending turns.

## Impact

- **Daemon (`cli/*.mjs`)**: `wake-queue.mjs` (batch draining), `prompts.mjs`
  (`buildBatchPrompt`), `waker.mjs` (`wakeBatch` + snapshot clearing),
  `event-router.mjs` (enqueue payloads instead of thunks; route human_instruction
  + autonomous + resume through the same batch lane), `daemon.mjs` (wire the batch
  runner). Ships by `systemctl --user restart chorus-daemon.service` — no ECS deploy.
- **Server (`src/services`, `src/app/api`)**: `POST /api/daemon/turn-advance`
  gains an optional `coalescedCount` field (default 1); `daemon-session.service.ts`
  advance-turn path settles the next `count − 1` same-session pending turns (by seq)
  to `merged` on the running-transition. `status` is a free String column, so **no
  Prisma migration** is required.
- **Behavioral only for the UI**: queued rows clear via the existing
  execution-snapshot reconcile + SSE; no new UI, no new status enum, no new screen.
- **Backwards compatible**: a single queued wake (batch size 1) is byte-identical
  to today's single-wake prompt and turn accounting.
