# Collapse coalesced "merged" turns into one band in the daemon chat transcript

## Why

Wake coalescing (parent idea `c179b6ee`, PR #489) merges the wakes that pile up while a
turn is running into ONE `claude --resume` turn. On the server this settles the oldest
pending turn (seq `X`) to `running → ended` — it carries the merged prompt and does the
real work — and settles the next `N−1` same-session pending turns (seq `X+1..X+N−1`) to
the terminal `status = "merged"` (`daemon-session.service.ts:1846-1863`).

The chat transcript front-end never learned about `merged`:

- `turn-band.tsx` (lines 73-92) derives its status label with an explicit ladder for
  `running / pending / interrupted` and an **else** that returns `t("turnStatusEnded")`.
  `merged` matches nothing, so it is **mislabeled "Ended."**
- The same component treats a turn as `terminal` only when `status === "ended" ||
  "interrupted"`, so a `merged` turn is *not* terminal, skips the "honest empty" copy, and
  falls to the generic `t("turnNoMessages")` placeholder ("No transcript retained…").

The result the owner reported: after a coalesced burst the transcript shows a **string of
independent, empty, "Ended"-labeled bands** — one per merged-away wake — instead of "one
integrated whole" that says *this turn processed N events at once.*

There is a second, live-only face of the same bug. The merged settlement runs as a raw
`updateMany` and — unlike every other turn transition, which goes through `advanceTurn`
and publishes a `turn_status_changed` SSE event (`daemon-session.service.ts:761`) — emits
**no event**. A viewer watching live therefore sees the merged-away turns frozen as
"Queued" (their last `turn_created` state) until a refetch re-reads them as `merged`. The
feature must read correctly both live and on reload.

## What Changes

1. **`merged` gets first-class transcript semantics** — its own status label (a new i18n
   key, all four locales), treated as a settled non-error terminal state so it never reads
   "Ended" and never shows the "no transcript retained" error placeholder. This alone fixes
   a standalone / un-collapsed merged turn.
2. **Contiguous merged runs collapse into their absorbing turn** — the transcript groups a
   run of `status === "merged"` turns into the immediately-preceding non-merged turn (the
   invariant from the server: merged turns are the next `N−1` turns by ascending seq after
   the absorbing turn). The absorbing band gains an expandable **"merged N events"** chip
   (collapsed by default) that lists each merged-away event with its own provenance —
   trigger glyph + label, prompt text, and entity deep-link — reusing the existing single-
   turn band vocabulary. Grouping is **pure front-end, seq-adjacency, no migration**
   (elaboration q2).
3. **Live convergence (no migration)** — the merged settlement publishes a
   `turn_status_changed` transcript event for each settled turn so live viewers converge to
   `merged` and the *same* collapse rule applies live and on reload. This reuses the
   existing `TranscriptEvent` shape and `publishTranscriptEvent`; no schema/field is added.

   > **Deliberate extension beyond elaboration q2, flagged for the owner.** Elaboration q2
   > chose front-end seq-adjacency for the *grouping mechanism* ("纯前端分组，不改服务端
   > /schema"). Item 3 is a *separate* concern — live delivery — not grouping. Without it,
   > the collapse only works after a reload (live viewers keep seeing "Queued" bands),
   > because the merged settlement is the one turn mutation that emits no SSE event. The
   > emit is additive, reuses the existing channel/payload, and adds **no migration and no
   > new field**, so it stays within q2's "免迁移" intent while completing the feature. If
   > the owner prefers strictly zero server code, T2 can be dropped and the feature ships
   > reload-only.

## Capabilities

- `daemon-merged-turn-transcript` (**new**) — how the daemon chat transcript presents
  coalesced-away `merged` turns: status semantics, collapse-into-absorbing-turn grouping,
  the expandable merged-events provenance, and live SSE convergence.

## Non-goals

- No Prisma migration, no new turn field, no explicit `coalescedIntoUuid` back-link
  (elaboration q2 chose the front-end seq-adjacency path).
- No change to the conversation-list last-message preview (elaboration q5 scoped this to
  the transcript only).
- No change to the presence / execution snapshot (queued/running rows) — the daemon
  already drops merged-away execution resources.

## Impact

- **Affected specs:** adds capability `daemon-merged-turn-transcript`.
- **Affected code:** `src/components/agent-presence/chat/turn-band.tsx`,
  `src/components/agent-presence/chat/transcript-view.tsx`,
  `src/services/daemon-session.service.ts` (settlement emit only),
  `messages/{en,zh,ja,ko}.json`, and `docs/design.pen`.
- **Risk:** low. Front-end grouping is presentational and reversible; the server change is
  an additive SSE emit on an existing channel with an existing payload shape.
