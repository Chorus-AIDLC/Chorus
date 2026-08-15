# Tasks — Daemon Wake Coalescing

> Chorus task drafts are the source of truth; this list mirrors them for OpenSpec validation.

## 1. WakeQueue batch draining (daemon core)
- [ ] Convert per-key pending list to data items; add `runBatch(key, items)` runner
- [ ] Drain the whole pending list on slot-free (no cap, no timer); preserve serialization, concurrency cap, poisoned-batch isolation, drain()/stop()
- [ ] Update `wake-queue` unit tests to the new contract

## 2. buildBatchPrompt (daemon prompt)
- [ ] Size-1 delegates to `buildPrompt` (byte-identical)
- [ ] Size-N: headless + backlog preamble + per-event labeled blocks in arrival order
- [ ] Same-entity/action collapse (Q2); skip null bodies
- [ ] Unit tests

## 3. wakeBatch + snapshot clearing + router wiring (daemon)
- [ ] Refactor `wake` core; add `wakeBatch(notifications, key, attribution)` (single subprocess)
- [ ] Emit one running exec row for the session anchor; drop merged-away resources from the snapshot
- [ ] Route notification/human_instruction/autonomous/resume enqueues as `{notification, attribution}` payloads; wire `daemon.mjs` runBatch
- [ ] Unit tests (event-router + waker)

## 4. Server settles superseded pending turns
- [ ] On advance-to-running for a session, mark strictly-older same-session `pending` turns as terminal `merged`
- [ ] Unrelated sessions untouched; single non-coalesced turn unchanged; no migration
- [ ] Service unit test

## 5. Docs
- [ ] Note coalescing wake behavior where daemon wake behavior is documented (skill/docs), if applicable
