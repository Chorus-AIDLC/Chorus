# daemon-rest-client Specification

## Purpose
TBD - created by archiving change align-openclaw-daemon-parity. Update Purpose after archive.
## Requirements
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

### Requirement: Terminal turn-advance edge SHALL retry on retryable transport failures

The daemon REST client SHALL retry the `turn-advance` request when, and only when, the
reported status is a terminal one (`ended` or `interrupted`) and the failure is retryable.
A retryable failure is a network-level failure (no HTTP response), HTTP `429`, or any HTTP
`5xx`. Any HTTP `4xx` SHALL NOT be retried, because it is a server verdict that repeating
cannot change. The total attempt budget SHALL be 3, with delays of 500ms then 2000ms, and
the delay function SHALL be injectable so tests need not sleep in real time. Every failed
attempt SHALL be logged with its attempt ordinal, and the final failure SHALL still be
surfaced to the caller as the existing structured failure result — the client MUST NOT
throw and MUST NOT swallow the failure.

#### Scenario: Network error on the terminal edge succeeds on retry

- **WHEN** the daemon advances a turn to `ended` and the first request fails with a
  network-level error, and the second attempt returns `200`
- **THEN** the client SHALL report success to the caller, SHALL have issued exactly two
  requests, and SHALL have logged the first failure with its attempt ordinal

#### Scenario: 5xx and 429 are retried, 4xx is not

- **WHEN** the terminal turn-advance receives `503`, and separately `429`, and separately
  `400`
- **THEN** the `503` and `429` cases SHALL be retried up to the attempt budget, and the
  `400` case SHALL return its failure result immediately after a single request

#### Scenario: Attempt budget is bounded and the running edge never retries

- **WHEN** every attempt of a terminal turn-advance fails with a network-level error, and
  separately a `running` turn-advance fails the same way
- **THEN** the terminal case SHALL issue exactly 3 requests with injected delays of 500ms
  then 2000ms and return the failure result, and the `running` case SHALL issue exactly one
  request

#### Scenario: A retried terminal report has no duplicate effect

- **WHEN** the first terminal turn-advance actually reached the server but its response was
  lost, and the retry addresses the same turn
- **THEN** the turn SHALL end in exactly one terminal state with its usage rollup,
  timestamps and turn-status event applied exactly once

