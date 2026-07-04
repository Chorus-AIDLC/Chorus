# daemon-rest-client — delta: turn-advance carries interrupted status + reason

## MODIFIED Requirements

### Requirement: A shared host-agnostic client SHALL own the `/api/daemon/*` reporting payload shapes

The system SHALL provide a single shared module that encapsulates every daemon→server report — `turn-advance`, `transcript`, `execution-state`, `report-interrupt`, and the `pending-turns` read — and SHALL be the single source of truth for those request/response shapes. The module SHALL be constructed from only host-agnostic inputs (`url`, `apiKey`, a `getConnectionUuid` accessor, an injectable `fetchImpl`, and an optional logger) and SHALL authenticate every request with the agent `Authorization: Bearer <apiKey>` header and no other mechanism. The module SHALL NOT import or reference any daemon-host-specific facility (no child-process spawning, no `claude` invocation, no stream-json parsing, no OpenClaw SDK), so that both the chorus CLI daemon and the OpenClaw plugin can consume it unchanged.

#### Scenario: The client exposes the five daemon reporting operations

- **WHEN** the shared client is constructed with `{ url, apiKey, getConnectionUuid, fetchImpl }`
- **THEN** it MUST expose operations that POST to `/api/daemon/turn-advance`, `/api/daemon/transcript`, `/api/daemon/execution-state`, and `/api/daemon/report-interrupt`, and that GET `/api/daemon/pending-turns`
- **AND** every request MUST carry the `Authorization: Bearer <apiKey>` header

#### Scenario: The payload shapes match the existing server contract

- **WHEN** the client issues each operation
- **THEN** the `turn-advance` body MUST carry `{ connectionUuid, sessionId, status }` (with optional `entityType`/`entityUuid`, and — when `status` is `interrupted` — an `interruptedReason` of `user`, `crash`, or `shutdown`), the `transcript` body MUST carry `{ sessionId, messages: [{ role, text }] }`, the `execution-state` body MUST carry `{ connectionUuid, executions: [{ taskUuid, rootIdeaUuid|null, status, startedAt|null }] }`, the `report-interrupt` body MUST carry `{ connectionUuid, entityType, entityUuid, reason }`, and the `pending-turns` read MUST be `GET /api/daemon/pending-turns?connectionUuid=<uuid>`
- **AND** these MUST be the exact shapes the server endpoints accept

#### Scenario: The client has zero daemon-host coupling

- **WHEN** the shared module's source is inspected
- **THEN** it MUST NOT import `child_process`, spawn `claude`, parse stream-json, or import any OpenClaw SDK symbol
- **AND** its only outbound effect MUST be HTTP calls via the injected `fetchImpl`

#### Scenario: The server rejects a daemon claiming the offline reason

- **WHEN** a turn-advance report carries `status = "interrupted"` with `interruptedReason = "offline"`
- **THEN** the server MUST reject it (the `offline` verdict is reserved to server-side reconcile)
