# openclaw-event-bridge Specification

## ADDED Requirements

### Requirement: The OpenClaw plugin SHALL self-report client metadata when opening the notification stream

The OpenClaw plugin's SSE notification listener SHALL append self-report query
parameters when it opens its subscription to `/api/events/notifications`. The
appended parameters SHALL be `clientType=openclaw`, `clientVersion` set to the
plugin version, `host` set to the machine hostname, and `startedAt` set to the
plugin process start time in ISO-8601. The `clientType` SHALL be `openclaw` so the server's
connection registry can distinguish an OpenClaw daemon from a chorus CLI
(`claude_code`) daemon. This SHALL NOT change the authentication mechanism (the
Bearer `cho_` API key header is unchanged) and SHALL NOT alter the listener's
reconnect behavior.

#### Scenario: The OpenClaw listener appends self-report params on connect

- **WHEN** the OpenClaw plugin opens its notification SSE subscription
- **THEN** the request URL MUST include `clientType=openclaw` together with the
  plugin's `clientVersion`, the machine `host`, and the process `startedAt`
- **AND** the `Authorization: Bearer <cho_ key>` header MUST be sent exactly as before

#### Scenario: The server distinguishes OpenClaw from chorus CLI connections

- **GIVEN** one OpenClaw plugin and one chorus CLI daemon both connected for the same agent
- **WHEN** the server registers each connection
- **THEN** the OpenClaw connection MUST be recorded with `clientType = "openclaw"`
- **AND** the chorus CLI connection MUST be recorded with `clientType = "claude_code"`
