## ADDED Requirements

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
