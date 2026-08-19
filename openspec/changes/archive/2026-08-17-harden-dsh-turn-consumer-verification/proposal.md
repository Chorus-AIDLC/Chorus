## Why

The dsh bridge already emits committed conversation frames and one normalized per-wake usage frame, and the shared upload consumer already recognizes them. The remaining gap is deterministic coverage proving those dsh frames reach the idea-anchored transcript and terminal turn exactly once, without stale usage carrying into a later wake.

## What Changes

- Add focused dsh consumer lifecycle coverage from committed transcript frames through upload batching.
- Add extractor/hook unit coverage for malformed, incomplete, and type-mismatched dsh usage frames so rejected frames cannot trigger usage settlement.
- Prove a normalized `dsh.turn.completed` frame is attached to exactly one terminal `turn-advance` for the active idea/session.
- Prove a later wake on the same Chorus idea anchor does not inherit or subtract the previous wake's usage.
- Keep the existing bridge aggregation, upload extractors, generic turn persistence, and free-form `usage.source` contract unchanged.
- Do not add `dsh-usage-map.mjs`; the bridge output is already a per-wake delta.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-dsh-backend`: Add explicit consumer-side transcript, idea attribution, and per-wake usage isolation requirements.

## Impact

- Affects focused tests under `cli/__tests__/`, primarily dsh backend integration, transcript upload extraction, and upload/waker lifecycle coverage.
- Relies on the existing `cli/dsh-spawner.mjs`, `cli/upload-hooks.mjs`, `cli/waker.mjs`, and generic `turn-advance` persistence contracts.
- Adds no runtime dependency, data model, API, server schema, or production behavior change.
