## MODIFIED Requirements

### Requirement: A shared host-agnostic client SHALL own the `/api/daemon/*` reporting payload shapes

The system SHALL provide a single shared module that encapsulates every daemon→server report — `turn-advance`, `transcript`, `execution-state`, `report-interrupt`, and the `pending-turns` read — and SHALL be the single source of truth for those request/response shapes. The module SHALL be constructed from only host-agnostic inputs (`url`, `apiKey`, a `getConnectionUuid` accessor, an injectable `fetchImpl`, and an optional logger) and SHALL authenticate every request with the agent `Authorization: Bearer <apiKey>` header and no other mechanism. The module SHALL NOT import or reference any daemon-host-specific facility (no child-process spawning, no `claude` invocation, no stream-json parsing, no OpenClaw SDK), so that both the chorus CLI daemon and OpenClaw plugin clients can implement the same contract without host-specific transport behavior. A successful running `turn-advance` response SHALL expose the resolved turn UUID to its caller, and later reports MAY carry that UUID for exact correlation.

#### Scenario: The client exposes the five daemon reporting operations

- **WHEN** the shared client is constructed with `{ url, apiKey, getConnectionUuid, fetchImpl }`
- **THEN** it MUST expose operations that POST to `/api/daemon/turn-advance`, `/api/daemon/transcript`, `/api/daemon/execution-state`, and `/api/daemon/report-interrupt`, and that GET `/api/daemon/pending-turns`
- **AND** every request MUST carry the `Authorization: Bearer <apiKey>` header

#### Scenario: The payload shapes match the server contract

- **WHEN** the client issues each operation
- **THEN** the `turn-advance` body MUST carry `{ connectionUuid, sessionId, status }` and MAY carry `turnUuid`, `backendSessionId`, paired `entityType`/`entityUuid`, `coalescedCount`, `startedAt`, `endedAt`, `transcriptRelayError`, normalized `usage`, and an `interruptedReason` of `user`, `crash`, or `shutdown` when `status` is `interrupted`
- **AND** the `transcript` body MUST carry `{ sessionId, messages: [{ role, text }] }`; the `execution-state` body MUST carry `{ connectionUuid, executions: [{ entityType, entityUuid, rootIdeaUuid|null, directIdeaUuid|null, status, startedAt|null }] }`; the `report-interrupt` body MUST carry `{ connectionUuid, entityType, entityUuid, reason }`; and the `pending-turns` read MUST be `GET /api/daemon/pending-turns?connectionUuid=<uuid>`
- **AND** a host-specific mirror MAY expose a supported subset of optional `turn-advance` fields, but MUST NOT send a field the server rejects

#### Scenario: Running transition returns correlation

- **WHEN** `turn-advance` successfully moves a turn to `running`
- **THEN** the client MUST parse the response's resolved turn UUID and expose it to the wake lifecycle caller
- **AND** a later terminal report for that wake MUST be able to send the UUID as `turnUuid`

#### Scenario: Legacy response has no correlation

- **WHEN** a successful running response does not expose a turn UUID or an older daemon omits `turnUuid`
- **THEN** the client and server MUST retain the existing session-and-status FIFO fallback without crashing or silently dropping the report

#### Scenario: The client has zero daemon-host coupling

- **WHEN** the shared module's source is inspected
- **THEN** it MUST NOT import `child_process`, spawn `claude`, parse stream-json, or import any OpenClaw SDK symbol
- **AND** its only outbound effect MUST be HTTP calls via the injected `fetchImpl`

#### Scenario: The server rejects a daemon claiming the offline reason

- **WHEN** a turn-advance report carries `status = "interrupted"` with `interruptedReason = "offline"`
- **THEN** the server MUST reject it (the `offline` verdict is reserved to server-side reconcile)
