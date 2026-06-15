# cli-daemon Specification

## ADDED Requirements

### Requirement: The daemon SHALL self-report client metadata when opening the notification stream

The chorus CLI daemon SHALL append self-report query parameters when it opens its
SSE subscription to `/api/events/notifications`. The appended parameters SHALL be
`clientType=claude_code`, `clientVersion` set to the chorus CLI package version,
`host` set to the machine hostname, and `startedAt` set to the daemon process
start time in ISO-8601. The `clientType` SHALL be `claude_code`
(not a generic `daemon`) because the CLI drives a local Claude Code subprocess.
This SHALL NOT change the authentication mechanism (the Bearer `cho_` API key
header is unchanged) and SHALL NOT alter the daemon's reconnect or backfill
behavior.

#### Scenario: The daemon appends self-report params on connect

- **WHEN** the chorus CLI daemon opens its notification SSE subscription
- **THEN** the request URL MUST include `clientType=claude_code` together with the
  CLI's `clientVersion`, the machine `host`, and the process `startedAt`
- **AND** the `Authorization: Bearer <cho_ key>` header MUST be sent exactly as before

#### Scenario: Reconnect re-sends the self-report params

- **GIVEN** the daemon's SSE subscription drops and the backoff reconnect fires
- **WHEN** the daemon re-opens the notification stream
- **THEN** the reconnect request URL MUST again include the same self-report query parameters
