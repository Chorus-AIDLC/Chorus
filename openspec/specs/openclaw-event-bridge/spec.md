# openclaw-event-bridge Specification

## Purpose
TBD - created by archiving change refactor-openclaw-plugin. Update Purpose after archive.
## Requirements
### Requirement: The plugin SHALL run the SSE notification listener as a registered background service

The plugin MUST register a background service via `api.registerService({ id, start, stop })` that opens the Chorus SSE notification stream (`<chorusUrl>/api/events/notifications`, Bearer auth) on `start` and closes it on `stop`. The listener MUST reconnect with exponential backoff (initial 1s, capped at 30s) and MUST back-fill unread notifications on reconnect.

#### Scenario: Service starts and stops the SSE stream

- **WHEN** the registered service's `start` is invoked
- **THEN** the plugin MUST open the SSE connection to `<chorusUrl>/api/events/notifications` with an `Authorization: Bearer <apiKey>` header
- **AND** when `stop` is invoked, the plugin MUST abort the stream and disconnect the slim MCP client

#### Scenario: Dropped stream reconnects with capped backoff

- **GIVEN** an established SSE connection that drops unexpectedly
- **WHEN** the listener detects the drop
- **THEN** it MUST schedule a reconnect with delay that doubles from 1s up to a 30s cap
- **AND** on successful reconnect it MUST reset the backoff delay
- **AND** on reconnect it MUST query unread notifications so events missed during the gap are not lost

### Requirement: The plugin SHALL wake the agent in-process via enqueueSystemEvent, not via the HTTP hooks endpoint

When an actionable notification arrives, the event router MUST wake the agent by calling `api.runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey })`. The legacy HTTP POST to the gateway `/hooks/wake` endpoint MUST be removed. The `contextKey` MUST be derived from the notification so duplicate notifications collapse to a single wake.

#### Scenario: No /hooks/wake HTTP call remains

- **WHEN** `packages/openclaw-plugin/src/` is grepped for `/hooks/wake`
- **THEN** there MUST be zero matches
- **AND** there MUST be no `fetch` call whose purpose is to wake the agent

#### Scenario: Actionable notification enqueues a system event

- **GIVEN** an incoming `new_notification` SSE event whose underlying notification action is one the router handles (e.g. `task_assigned`)
- **WHEN** the router dispatches it
- **THEN** it MUST call `api.runtime.system.enqueueSystemEvent` with a human-readable message containing the entity title and UUID
- **AND** it MUST pass a `contextKey` derived from the notification action and entity UUID

#### Scenario: Duplicate notifications collapse via contextKey

- **GIVEN** two SSE events that resolve to the same notification action and entity
- **WHEN** both are dispatched before the agent consumes the first
- **THEN** the two enqueue calls MUST share the same `contextKey`
- **AND** the queue's deduplication MUST prevent a second identical system event from being delivered

#### Scenario: No resolvable session is handled gracefully

- **GIVEN** a runtime where no agent session key can be resolved (e.g. headless with no active agent)
- **WHEN** the router attempts to wake the agent
- **THEN** it MUST log that the wake was dropped for lack of a session
- **AND** it MUST NOT throw, MUST NOT crash the service, and MUST NOT fabricate a session

### Requirement: The autoStart behavior SHALL be preserved under the new wake mechanism

When `autoStart` is enabled and a `task_assigned` notification arrives, the plugin MUST claim the task via the slim MCP client before enqueuing the wake, matching the pre-refactor behavior.

#### Scenario: autoStart claims the task before waking

- **GIVEN** `autoStart` is `true` and a `task_assigned` notification for an open task
- **WHEN** the router handles it
- **THEN** it MUST call `chorus_claim_task` for that task UUID via the slim MCP client
- **AND** it MUST then enqueue the wake system event referencing the same task
- **AND** if the claim fails, it MUST still enqueue the wake (so the agent can handle the task manually) and log the claim failure

#### Scenario: autoStart disabled does not claim

- **GIVEN** `autoStart` is `false` and a `task_assigned` notification
- **WHEN** the router handles it
- **THEN** it MUST NOT call `chorus_claim_task`
- **AND** it MUST still enqueue a wake informing the agent the task is available to review

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

### Requirement: The plugin SHALL capture its own connectionUuid from the connection_registered event

The OpenClaw plugin's SSE listener SHALL expose an `onConnectionId` callback and the server's post-handshake `connection_registered` event (carrying `connectionUuid`) SHALL be routed to it and stored as the connection's identity, rather than being discarded as an unhandled event. The stored `connectionUuid` SHALL be made available to the daemon reporting client and the control handler. On reconnect, the listener SHALL refresh the stored `connectionUuid` from the new `connection_registered` event. The `connection_registered` event SHALL NOT enter the wake path.

#### Scenario: connection_registered populates the stored connectionUuid

- **WHEN** the server sends a `connection_registered` event after the SSE handshake
- **THEN** the plugin MUST store the supplied `connectionUuid` as its connection identity
- **AND** that value MUST be readable by the daemon reporting client and the control handler

#### Scenario: connection_registered is not treated as a wake

- **WHEN** the `connection_registered` event is dispatched
- **THEN** it MUST NOT enqueue a wake or spawn an agent run
- **AND** it MUST NOT be logged as an ignored/unhandled event

#### Scenario: Reconnect refreshes the connectionUuid

- **GIVEN** an established connection whose stream drops and reconnects
- **WHEN** the server sends a new `connection_registered` on reconnect
- **THEN** the plugin MUST replace its stored `connectionUuid` with the new value

### Requirement: The plugin SHALL subscribe and route the reverse control channel without entering the wake path

The OpenClaw plugin's SSE listener SHALL expose an `onControl` callback and SHALL fork SSE events whose `type` is `control` to a control handler, distinct from the `new_notification` wake path. The control handler SHALL act on a command only when the event's `targetConnectionUuid` equals the plugin's stored `connectionUuid` (and, for `interrupt`, only when the plugin currently holds a running entity matching the command), and SHALL otherwise log and ignore the command. A control event SHALL NEVER enqueue a wake or spawn a new agent run for the control event itself. The handler SHALL route `interrupt`, `resume`, and `deliver_turn` to their respective behaviors (defined by the `openclaw-daemon-client` capability).

#### Scenario: A control event is forked to the control handler, not the wake path

- **WHEN** the plugin receives an SSE event with `type = "control"`
- **THEN** it MUST route the event to the control handler via `onControl`
- **AND** it MUST NOT enqueue a wake or spawn an agent run for the control event

#### Scenario: A control command for another connection is ignored

- **GIVEN** the plugin's stored `connectionUuid` is C
- **WHEN** it receives a control command whose `targetConnectionUuid` is not C
- **THEN** it MUST log and ignore the command and MUST NOT abort, resume, or deliver anything

#### Scenario: The three control commands are routed

- **WHEN** the control handler receives a verified `interrupt`, `resume`, or `deliver_turn` command for its own connection
- **THEN** it MUST route `interrupt` to abort the matching in-flight run, `resume` to re-dispatch the entity's wake, and `deliver_turn` to the connection-scoped pending-turns sweep

