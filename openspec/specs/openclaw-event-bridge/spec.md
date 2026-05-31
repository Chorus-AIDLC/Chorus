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

