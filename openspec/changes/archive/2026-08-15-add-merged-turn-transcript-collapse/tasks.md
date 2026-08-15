# Tasks — Merged-turn transcript collapse

## 1. Merged-turn status semantics + i18n (foundation)
- [ ] Add a `merged` branch to `turn-band.tsx` status derivation: dedicated `turnStatusMerged` label, treat as settled/terminal (no "Ended", no `turnNoMessages` error placeholder; use a neutral `turnMergedNote` fallback).
- [ ] Add i18n keys `turnStatusMerged`, `turnMergedNote`, and the three missing trigger labels (`triggerElaborationVerified`, `triggerStartDevelopment`, `triggerYoloRequested`) + their `TRIGGER_META` glyphs, in all four locales.
- [ ] Unit test: a `merged` turn renders the merged label and no error placeholder.

## 2. Server live-convergence SSE emit (no migration)
- [ ] In `advanceTurnForWake`, after the merged `updateMany`, publish one `turn_status_changed` `TranscriptEvent` per settled turn (reuse `publishTranscriptEvent`, existing payload).
- [ ] `coalescedCount === 1` emits nothing (byte-identical to single-wake path).
- [ ] Unit test the settlement emit (N-1 events with `status: "merged"`; 0 events when count=1).

## 3. Front-end collapse + expandable provenance
- [ ] Group contiguous `merged` runs into the preceding absorbing turn in `transcript-view.tsx` (single-pass seq-adjacency; leading merged run → standalone bands).
- [ ] `TurnBand` renders a collapsed-by-default `<Collapsible>` "merged N events" chip; expand lists `MergedEventRow` per event (trigger glyph+label, seq, promptText, entity link). Light + dark correct.
- [ ] Unit tests: grouping (batch → one band; leading merged → standalone; count accurate), and the expansion renders provenance.
- [ ] Integration (B1): a test drives the emit→apply→group seam — a `turn_status_changed` event with `status:"merged"` (task 2's shape) through `applyTranscriptEvent`, then grouping, asserts the batch collapses into the absorbing band.
- [ ] N2: Collapsible uses semantic tokens only (no hard-coded hex) and is keyboard/touch-activatable (not hover-only).

## 4. design.pen + cross-cutting verification (depends on tasks 2 AND 3)
- [ ] Update `docs/design.pen` for the merged-events transcript band (via Pencil MCP).
- [ ] Locale-key parity across en/zh/ja/ko; `tsc --noEmit`, `pnpm lint`, and the affected `pnpm test` suites green.
- [ ] Verify both light and dark themes for the collapsed + expanded band.
