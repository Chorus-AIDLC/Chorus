# Design — Merged-turn transcript collapse

## Context

Wake coalescing settles coalesced-away turns to `status = "merged"`
(`daemon-session.service.ts:1846-1863`, `MERGED_TURN_STATUS = "merged"`, deliberately a
free String value NOT in `TURN_STATUSES`, so no Prisma enum/migration). These turns are
delivered to the front-end verbatim — `getSessionDetail` queries candidate turns with **no
status filter** and `toTurnView` passes `status` through unchanged. The transcript is a
pure presentational consumer of an **ascending-by-seq** turn list
(`transcript-view.tsx:550-561`; the ascending invariant is held by the container's
`insertTurnBySeq` / `mergeTurnPage`).

## Server invariant this design relies on

At settlement time the oldest pending turn (seq `X`) advances to `running`; the next
`coalescedCount − 1` **pending** turns of the same session by ascending seq
(`seq > X`, `take: N−1`) are marked `merged`. Because the daemon serializes same-session
wakes through a per-(agent,session) queue and the server assigns `seq` monotonically in
arrival order, the merged turns are exactly the **contiguous run immediately after** the
absorbing turn. This is what makes pure seq-adjacency grouping correct (elaboration q2 =
front-end inference, no migration).

## Decision 1 — Front-end grouping by seq-adjacency

`transcript-view.tsx` pre-processes its ascending `turns` list into render groups before
mapping to `<TurnBand>`:

```
type TurnGroup = { absorbing: TurnWithMessagesView; merged: TurnWithMessagesView[] };
```

Algorithm (single pass, O(n)):

- Walk turns in order, tracking the last non-merged turn as the current absorbing anchor.
- A `status === "merged"` turn attaches to the current anchor's `merged[]` **iff** an
  anchor exists (it is the immediately-preceding non-merged turn).
- A non-merged turn starts a new group and becomes the anchor.
- A `merged` turn with **no** anchor (a leading merged run whose absorbing turn is outside
  the loaded window) renders as its **own** standalone group (`absorbing = the merged
  turn`, `merged = []`) — never dropped, never an anchor for later merged turns.

A merged turn never absorbs another merged turn (an anchor is only ever a non-merged turn),
so a leading `[merged, merged]` renders as two standalone merged bands, not one nested pair.

The mapping then renders **one `<TurnBand>` per group** (the absorbing turn), passing the
group's `merged[]` down. `key` stays the absorbing turn's `uuid`.

### Live vs reload — one rule, two arrival paths

Grouping keys strictly on `status === "merged"`. The front-end never guesses that a
`pending` turn is a future coalesce victim (a legitimately-queued turn is also `pending` and
must keep rendering as "Queued"). Convergence to the merged rendering therefore depends on
the turn actually being `merged` in the client's in-memory list — which the reload path
gives for free (`getSessionDetail` returns `merged`) and the live path gets from Decision 3.

## Decision 2 — `TurnBand` owns the expandable merged-events section

`turn-band.tsx` gains:

1. **A `merged` status branch (lines 73-92 region).** Add `const merged = turn.status ===
   "merged"`. Treat it as settled/terminal (`terminal = ended || interrupted || merged`) so
   it is not "active/queued" and does not fall to the "Ended" default. `statusLabel` gains
   a `merged ? t("turnStatusMerged")` arm. The empty-body fallback for a standalone merged
   turn shows a neutral merged note (`turnMergedNote`), never the `turnNoMessages`
   error/empty copy. (`turn.promptText`, when present, still renders — the instruction that
   was merged is useful context.)

2. **A new optional prop** `mergedEvents?: { turn: TurnWithMessagesView; linkedExecution:
   ExecutionView | null }[]`. When non-empty, after the turn body, render a shadcn
   `<Collapsible>` (already used in `transcript-view.tsx:375-477` for "Connection details")
   whose trigger is a `t("turnMergedCount", { count })` chip (collapsed by default,
   `ChevronDown` rotate on open, touch-usable — not hover-only) and whose content lists one
   `MergedEventRow` per merged event.

3. **`MergedEventRow`** (small local sub-component) reuses the exact single-turn provenance
   vocabulary: trigger glyph + label from `TRIGGER_META[turn.trigger]` (fallback
   `triggerUnknown`), the `t("turnLabel", { seq })`, `turn.promptText` when present, and the
   entity deep-link via `execHref(linkedExecution)` (`hooks.ts:138-155`) when it resolves.
   Rendered compact (smaller type, muted) and correct in light + dark via semantic tokens
   (`text-muted-foreground`, `border-border`) — no hard-coded hex.

`transcript-view.tsx` resolves each merged event's `linkedExecution` the same way it does
for the absorbing turn (`executionsByUuid.get(turn.executionUuid) ?? null`,
`transcript-view.tsx:555-559`) and passes the array down.

### Trigger-map completeness (opportunistic)

`TRIGGER_META` (turn-band.tsx:46-52) maps only 5 of the 8 `TURN_TRIGGERS`
(`elaboration_verified`, `start_development`, `yolo_requested` fall to "Turn"). Merged
events can carry any trigger, so we add the three missing labels + glyphs and their i18n
keys while we are here, so a merged event never shows the generic "Turn" fallback.

## Decision 3 — Live convergence: emit `turn_status_changed` on settlement (no migration)

Every other turn transition publishes a `turn_status_changed` `TranscriptEvent` via
`advanceTurn` (`daemon-session.service.ts:761`); the merged settlement is the one mutation
that skips it because it is a raw `updateMany` (line 1859). We make the settlement block, in
`advanceTurnForWake` after the `updateMany`, re-read the settled rows and call
`publishTranscriptEvent({ trigger: "turn_status_changed", turn: toTurnView(row), messages:
[] })` once per settled turn (companyUuid from the already-resolved session). The client's
`applyTranscriptEvent` handles `turn_status_changed` by merging `event.turn` into the
in-memory turn (`daemon-chat.tsx:164-166`), flipping its status `pending → merged`, at which
point Decision 1's grouping applies with no reload.

This reuses the existing channel (`transcript:{sessionUuid}`), the existing payload shape,
and the existing publish helper — **no new field, no migration** (honors elaboration q2's
"免迁移" constraint). `coalescedCount === 1` settles nothing, so it emits nothing:
byte-identical to the pre-coalescing single-wake path.

## i18n

New keys in the `daemonChat` namespace across all four locales
(`messages/{en,zh,ja,ko}.json`; locate the namespace by key, not by line number, since line
numbers drift):

- `turnStatusMerged` — the merged status label (en "Merged", zh "已合并").
- `turnMergedCount` — the chip label, ICU plural in en (`{count, plural, one {merged #
  event} other {merged # events}}`), flat count phrase in zh/ja/ko.
- `turnMergedNote` — neutral body note for a standalone merged turn.
- `triggerElaborationVerified`, `triggerStartDevelopment`, `triggerYoloRequested` — the
  three previously-unmapped trigger labels.

Locale-key parity is checked with the project's AST/JSON parity tooling (all four locales
carry the same key set with correct ICU shape).

## Risks / trade-offs

- **Absorbing turn outside the loaded window.** A leading merged run renders as standalone
  merged bands (correctly labeled, not "Ended"). This is the acceptable fallback; the
  Decision-1 algorithm handles it explicitly.
- **Live `pending` bands during the transient window** (before the Decision-3 event lands):
  they read "Queued", which is honest — they *are* queued at that instant. Decision 3 closes
  the window to a single round-trip.
- **Redis vs in-memory EventBus.** Decision 3 publishes on the same channel the create/
  advance events already use, so multi-instance fan-out behaves identically to existing
  transcript events (no new channel to wire through Redis).
- **`executionUuid` often null** on turns → a merged event's entity deep-link may not
  resolve; provenance then leans on trigger + promptText (documented, acceptable).
