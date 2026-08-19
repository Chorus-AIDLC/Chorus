## Context

The approved dsh bridge owns producer normalization. For each prompt-to-idle interval it forwards committed root `user/message` and non-empty `assistant/message` frames, aggregates root assistant usage, and emits exactly one `dsh.turn.completed` frame. The shared upload hook already extracts those transcript and usage shapes, resets captured usage at `onSessionStart`, and returns the current usage from `onSessionEnd`.

The generic waker anchors direct-Idea work on `sessionId === directIdeaUuid`, passes hook usage only on the terminal turn edge, and the server atomically persists turn usage with the idea-anchored session totals. Existing tests cover each generic layer, but the dsh backend integration test currently stops at backend selection and process interruption.

## Goals / Non-Goals

**Goals:**

- Exercise the real dsh consumer dialect through transcript upload and terminal usage reporting.
- Prove malformed, incomplete, and type-mismatched dsh usage frames are ignored without setting captured usage or disrupting transcript relay.
- Assert the terminal report uses the active Chorus idea/session anchor and carries dsh usage exactly once.
- Assert sequential wakes do not inherit or re-subtract the previous wake's usage.
- Keep the test deterministic and independent of a live DeepSeek API or external dsh runtime.

**Non-Goals:**

- Reimplement or move dsh event production and aggregation from `DshSpawner`.
- Add a persistent dsh usage baseline map.
- Change the server's usage schema, source validation, attribution model, or rollup implementation.
- Add dsh session resume; v1 intentionally creates a fresh runtime and session per wake.

## Decisions

### Test the composed consumer and waker boundary

Use the existing upload hooks with a controlled dsh-emitting spawner and a captured `advanceTurn` reporter. This proves the actual extractor, lifecycle reset, session anchor, and terminal forwarding behavior together.

Testing extractors alone was rejected because it cannot detect dropped usage between `onSessionEnd` and `turn-advance`. A live runtime-only test was rejected as the regression gate because it introduces provider, network, and external-runtime nondeterminism.

The composed fixtures must use the exact `user/message`, `assistant/message`, and `dsh.turn.completed` field names defined by the cumulative `daemon-dsh-backend` specification. Where the producer exposes a reusable fixture/helper, the integration test should import it; otherwise the producer test and consumer integration test must assert the same canonical frame shape explicitly.

### Test rejected dsh usage frames at the extractor and hook boundary

Add focused cases for non-object input, a non-terminal or mismatched `type`, a terminal frame with missing or non-object `usage`, and partial token fields. Dsh fixtures use the producer's camelCase `inputTokens`, `outputTokens`, `cacheCreationTokens`, and `cacheReadTokens` fields, never the Claude/Codex snake_case dialect. Rejected frames return `null` and leave hook usage unset; a partial object with at least one valid category preserves valid values while normalizing absent or invalid categories to `null`.

Relying only on the composed happy path was rejected because it would not protect the `?? extractDshTurnUsage(message)` dispatch from accidental capture after wire drift.

### Treat bridge usage as the authoritative per-wake delta

The test supplies one normalized terminal frame per wake and asserts the same values arrive once at the terminal reporter. A second wake without a terminal usage frame must report no usage; a second wake with its own frame must report only that frame.

A persistent `dsh-usage-map.mjs` was rejected because the bridge already scopes aggregation to one prompt-to-idle interval. Subtracting another baseline would duplicate state and risk double subtraction.

### Reuse generic server persistence coverage

Do not add dsh-specific route or service behavior. Existing tests already prove that a normalized usage object with a free-form source is validated, persisted on terminal edges, and atomically added to the resolved session rollup. The dsh integration test proves that the correct idea-anchored session and payload reach that generic boundary.

## Risks / Trade-offs

- [The composed test may duplicate some generic lifecycle assertions] -> Keep assertions dsh-specific: dialect extraction, active idea/session identity, single terminal payload, and sequential-wake isolation.
- [Future bridge wire drift could invalidate fixtures] -> Pin fixture event names and fields to the cumulative `daemon-dsh-backend` contract and reuse producer helpers where available.
- [A mocked reporter does not prove database writes] -> Retain the existing route and service persistence tests as the database contract gate.

## Migration Plan

1. Add defensive dsh extractor/hook cases for rejected and partial frames.
2. Add the deterministic dsh consumer-to-terminal lifecycle test.
3. Run focused dsh, upload-hook, waker, route, and service tests.
4. Roll back by removing only the new tests; no production or persisted state changes are introduced.

## Open Questions

None.
