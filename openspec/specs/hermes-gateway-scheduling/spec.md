# hermes-gateway-scheduling Specification

## Purpose
TBD - created by archiving change add-hermes-plugin. Update Purpose after archive.

## Requirements

### Requirement: The plugin SHALL register a chorus gateway platform that holds a Chorus daemon connection

The plugin MUST call `ctx.register_platform("chorus", ...)` with an adapter subclassing `BasePlatformAdapter`. On `connect()` the adapter MUST open `GET <CHORUS_URL>/api/events/notifications` with `Authorization: Bearer <CHORUS_API_KEY>` and the query parameters `clientType=hermes`, `clientVersion`, `host`, `cwd` (the gateway's configured `terminal.cwd`, resolved to an absolute path; when that is unset or a placeholder `.`/`auto`/`cwd` and the terminal backend is local, `MESSAGING_CWD`, matching Hermes' own fallback order — the adapter MUST refuse to connect rather than report Hermes' last resort `$HOME` or a non-directory), `startedAt`, and `livenessAck=v1`. It MUST store the `connectionUuid` and `connectedAt` from `connection_registered`, and MUST answer every `: heartbeat` with `POST /api/daemon/connection-heartbeat {connectionUuid, connectedAt}`. If no bytes arrive for 75s, it MUST reconnect with exponential backoff (1s doubling to a 30s cap; the delay resets on success). On `connection_conflict` it MUST log the conflict and stop retrying until restarted. The adapter MUST authorise its own events without manual allowlist setup. Every `MessageEvent` it builds MUST carry the agent owner's uuid (from `chorus_checkin`) as `user_id`, and the adapter MUST seed the `chorus` platform's allowed-user set with that uuid at connect time (via the platform's `env_enablement_fn` / `PlatformConfig.extra`, or the mechanism Task 1 confirms). `CHORUS_ALLOWED_USERS` remains an optional override. The connect-time `chorus_checkin` marks up to 5 unread notifications as read. The adapter MUST therefore run its pending-turns sweep from server-side pending turns, not from unread notifications. On `disconnect()` it MUST close the stream and cancel in-flight turns, reporting `interrupted/shutdown`.

#### Scenario: Gateway start makes the agent online

- **GIVEN** the plugin is enabled, the `chorus` platform is enabled, and `CHORUS_URL` / `CHORUS_API_KEY` are set
- **WHEN** `hermes gateway` starts
- **THEN** Chorus MUST list a `hermes` connection for the agent with the gateway's host and cwd
- **AND** the Start Development and Yolo buttons for that agent's ideas MUST be enabled

#### Scenario: Wakes are authorised without manual configuration

- **GIVEN** `CHORUS_ALLOWED_USERS` is not set
- **WHEN** a wake is dispatched
- **THEN** the gateway MUST accept the event as coming from an allowed user

#### Scenario: Heartbeat ack keeps liveness

- **WHEN** the server sends `: heartbeat`
- **THEN** the adapter MUST POST `/api/daemon/connection-heartbeat` within 5s

#### Scenario: Stream drop reconnects

- **WHEN** the stream is silent for 75s or closes
- **THEN** the adapter MUST reconnect with capped backoff
- **AND** it MUST sweep `GET /api/daemon/pending-turns?connectionUuid=<uuid>` after reconnecting

### Requirement: The adapter SHALL apply the daemon's wake-routing rules

For each `new_notification` event, the adapter MUST dedup by `notificationUuid`, then re-read the notification through `chorus_get_notifications {status:"unread", limit:50, autoMarkRead:false}`. It MUST skip the wake when any of these hold: the action is not in the daemon's `WAKE_ACTIONS` set; the action is `human_instruction` or an operation action (these arrive only as pending turns); `suppressWake` is true; or `targetConnectionUuid` is set and differs from its own connection. For `control` events, it MUST ignore any whose `targetConnectionUuid` is not its own. It MUST handle `deliver_turn` (fetch that pending turn), `interrupt` (cancel the running turn for that entity), and `resume`. Dedup MUST distinguish a key that is in flight (dropping a concurrent duplicate) from one that was handled. A retryable failure (the notification re-read failed, a pending turn's notification was not found yet, or turn admission was unavailable) MUST release the key so a later sweep or `deliver_turn` recovers the turn.

#### Scenario: Directed wake for another instance is skipped

- **GIVEN** a `new_notification` whose `targetConnectionUuid` is a different connection
- **WHEN** the adapter receives it
- **THEN** no agent turn MUST start

#### Scenario: Suppressed wake is skipped

- **WHEN** a `new_notification` arrives with `suppressWake: true`
- **THEN** no agent turn MUST start

#### Scenario: A failed re-read does not lose the pending turn

- **GIVEN** a pending turn whose notification re-read fails once
- **WHEN** the next sweep runs
- **THEN** the adapter MUST re-read and dispatch that turn exactly once

### Requirement: Wakes SHALL run as per-Idea gateway sessions with daemon-equivalent prompts

Each accepted wake MUST be dispatched with `handle_message` as a `MessageEvent` whose `chat_id` is `idea:<directIdeaUuid>`, falling back to `<entityType>:<entityUuid>`. Successive wakes for the same Idea therefore resume the same Hermes session. The message text MUST be produced by a Python port of `cli/prompts.mjs` (`HEADLESS_PREAMBLE` + `buildPromptBody` per action + orchestrator guidance). A parity test MUST render a fixture set through both `cli/prompts.mjs` and the Python port and require identical output. Pending turns MUST use `promptText` (`human_instruction`) or the rebuilt notification prompt. A pending turn MUST run in its own `sessionId`. Its notification MUST be one of that session (its entity is the session anchor, or the entity's direct Idea is the session's Idea), searched page by page; a notification of another session or Idea MUST NOT be used. When none is found, the turn MUST stay pending and recoverable. The adapter MUST serialise wakes per chat itself: a wake for a chat whose turn is still running MUST wait in an adapter-side FIFO, and MUST be reported as `queued` in execution-state until it starts. Chorus wakes MUST NOT be handed to the gateway's `busy_input_mode` handling, because `interrupt` mode would cancel the running turn.

#### Scenario: Two wakes for one Idea share a session

- **GIVEN** two `task_assigned` notifications for tasks of the same Idea
- **WHEN** both are routed
- **THEN** both turns MUST run in the Hermes session keyed `idea:<ideaUuid>`, one after the other

#### Scenario: Prompt parity with the CLI daemon

- **WHEN** the parity test renders the fixture notifications
- **THEN** the Python output MUST equal the `cli/prompts.mjs` output for every action

### Requirement: The adapter SHALL report turn lifecycle, transcripts and execution state

For every turn, the adapter MUST call these endpoints, in this order:
1. `POST /api/daemon/turn-advance {status:"running"}`, keeping the returned `turn.uuid`. A pending turn sends its own `turnUuid`. This is the server's admission: unless it returns a turn uuid (the requested one, for a pending turn), the adapter MUST NOT mark the execution running, write a transcript, call `handle_message`, or send any terminal report. A refusal (4xx, e.g. 404/409) drops the wake. An unavailable server (network error or 5xx) leaves the wake retryable.
2. `POST /api/daemon/execution-state` with the full snapshot of running and queued executions, sent on every change.
3. `POST /api/daemon/transcript` for the wake text and each finalized assistant message. The chat-panel copy of an autonomous wake MAY omit `HEADLESS_PREAMBLE`, since Hermes still receives the full prompt. A `human_instruction` turn MUST NOT add a user message, because Chorus already shows that text.
4. A terminal `turn-advance` once the turn ends. It is `ended` on success, and `interrupted` with `interruptedReason` of `user` (cancelled), `crash` (raised error, with a strict `wakeError {kind, source, message≤500}`), or `shutdown` (gateway stop). Token `usage` is included when Hermes exposes it.
5. `POST /api/daemon/report-interrupt` after an interrupted turn.

All REST failures MUST be logged and MUST NOT crash the gateway.

#### Scenario: Failed turn surfaces in chat

- **GIVEN** a woken turn that ends in `FAILURE` (handler exception or failed delivery), or a provider error that Hermes renders as reply text (observed via the `api_request_error` hook for that session)
- **WHEN** it ends
- **THEN** the adapter MUST send `turn-advance` `interrupted/crash` with a `wakeError` whose message is ≤500 characters
- **AND** the Chorus chat panel MUST show the failure

#### Scenario: Refused admission does not run the model

- **GIVEN** a wake whose `turn-advance running` returns 404 or 409, or fails with a network error or 5xx
- **WHEN** the adapter starts it
- **THEN** `handle_message` MUST NOT be called and no transcript or running execution MUST be reported

#### Scenario: Interrupt from Chorus

- **WHEN** a `control` `interrupt` arrives for the entity of a running turn
- **THEN** the adapter MUST cancel that Hermes turn
- **AND** report `interrupted/user`

#### Scenario: Resume after an interrupt

- **GIVEN** a turn was interrupted and the owner clicks Resume
- **WHEN** `POST /api/daemon/resume` targets a connection whose client type admits every run by turn (`hermes`)
- **THEN** the server MUST settle any older still-pending `resume` turn of the session as `merged`, create one pending `resume` turn linked to the resumed execution, and carry its `turnUuid` on the `resume` control event, while the daemon's resume stays unchanged (no turn created, none dispatched)
- **AND** the adapter MUST admit exactly that turn before running the model

#### Scenario: Resume continuation cannot be prepared

- **GIVEN** a Resume for a `hermes` connection whose session cannot be found or whose resume turn cannot be created
- **WHEN** the route handles it
- **THEN** it MUST put the execution back to `interrupted` with its prior reason, dispatch nothing, and return an error, so the run stays resumable
- **AND** the adapter MUST refuse any `resume` control event without a `turnUuid` rather than run it, because a turn-less admission would take another pending turn of the session

#### Scenario: A resume turn is recoverable

- **GIVEN** a pending `resume` turn whose control event was lost or whose first admission was unavailable (network error or 5xx)
- **WHEN** a pending-turn sweep or `deliver_turn` runs
- **THEN** `pending-turns` MUST return the turn with `resume: {entityType, entityUuid, resumedFrom}`, and the adapter MUST re-dispatch it as that entity's `resource_resumed` wake and admit the same turn

### Requirement: Outbound gateway replies SHALL NOT post to Chorus implicitly

The adapter's `send()` MUST record the agent's final reply as a transcript message only. It MUST NOT create Chorus comments. All Chorus writes MUST happen through explicit MCP tool calls made by the agent.

#### Scenario: Agent final text is not a comment

- **WHEN** a woken turn ends with final text
- **THEN** no Chorus comment MUST be created by the adapter itself
