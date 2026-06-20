# daemon-rest-client Specification

## Purpose
TBD - created by archiving change align-openclaw-daemon-parity. Update Purpose after archive.
## Requirements
### Requirement: A shared host-agnostic client SHALL own the `/api/daemon/*` reporting payload shapes

The system SHALL provide a single shared module that encapsulates every daemon→server report — `turn-advance`, `transcript`, `execution-state`, `report-interrupt`, and the `pending-turns` read — and SHALL be the single source of truth for those request/response shapes. The module SHALL be constructed from only host-agnostic inputs (`url`, `apiKey`, a `getConnectionUuid` accessor, an injectable `fetchImpl`, and an optional logger) and SHALL authenticate every request with the agent `Authorization: Bearer <apiKey>` header and no other mechanism. The module SHALL NOT import or reference any daemon-host-specific facility (no child-process spawning, no `claude` invocation, no stream-json parsing, no OpenClaw SDK), so that both the chorus CLI daemon and the OpenClaw plugin can consume it unchanged.

#### Scenario: The client exposes the five daemon reporting operations

- **WHEN** the shared client is constructed with `{ url, apiKey, getConnectionUuid, fetchImpl }`
- **THEN** it MUST expose operations that POST to `/api/daemon/turn-advance`, `/api/daemon/transcript`, `/api/daemon/execution-state`, and `/api/daemon/report-interrupt`, and that GET `/api/daemon/pending-turns`
- **AND** every request MUST carry the `Authorization: Bearer <apiKey>` header

#### Scenario: The payload shapes match the existing server contract

- **WHEN** the client issues each operation
- **THEN** the `turn-advance` body MUST carry `{ connectionUuid, sessionId, status }` (with optional `entityType`/`entityUuid`), the `transcript` body MUST carry `{ sessionId, messages: [{ role, text }] }`, the `execution-state` body MUST carry `{ connectionUuid, executions: [{ taskUuid, rootIdeaUuid|null, status, startedAt|null }] }`, the `report-interrupt` body MUST carry `{ connectionUuid, entityType, entityUuid, reason }`, and the `pending-turns` read MUST be `GET /api/daemon/pending-turns?connectionUuid=<uuid>`
- **AND** these MUST be the exact shapes the existing server endpoints already accept (no server change)

#### Scenario: The client has zero daemon-host coupling

- **WHEN** the shared module's source is inspected
- **THEN** it MUST NOT import `child_process`, spawn `claude`, parse stream-json, or import any OpenClaw SDK symbol
- **AND** its only outbound effect MUST be HTTP calls via the injected `fetchImpl`

### Requirement: The chorus CLI daemon SHALL consume the shared client without behavior change

The chorus CLI daemon (`cli/daemon.mjs` and its reporter modules) SHALL be refactored to issue its `/api/daemon/*` reports through the shared client rather than via independent hand-written fetch logic, so the CLI and OpenClaw hosts cannot drift in payload shape. The refactor SHALL be behavior-preserving: the CLI daemon's externally observable reporting SHALL be unchanged, and its existing automated test suite SHALL pass without modification to the assertions.

#### Scenario: The CLI daemon's reports go through the shared client

- **WHEN** the CLI daemon reports a turn advance, transcript, execution snapshot, interrupt, or reads pending turns
- **THEN** it MUST do so by calling the shared client
- **AND** it MUST NOT retain a parallel second implementation of those payload shapes

#### Scenario: Existing CLI daemon tests stay green after extraction

- **WHEN** the extraction refactor is complete
- **THEN** the CLI daemon's existing test suite MUST pass without weakening or deleting its reporting assertions

### Requirement: Reporting failures SHALL be surfaced, never silently swallowed

A failed daemon report (network error, non-2xx response, empty body where a result is expected) SHALL be logged visibly and surfaced to the caller; it SHALL NOT be silently discarded. A reporting failure SHALL NOT crash the agent run that triggered it — a failed transcript or turn-advance post SHALL be logged and the run SHALL continue — but the failure MUST remain visible in logs for debugging.

#### Scenario: A failed report is logged and surfaced

- **GIVEN** a daemon report whose HTTP call fails or returns a non-2xx status
- **WHEN** the client handles the failure
- **THEN** it MUST log the failure with the underlying cause
- **AND** it MUST NOT swallow the error into a silent success

