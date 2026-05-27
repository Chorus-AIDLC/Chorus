# report-realtime Specification

## ADDED Requirements

### Requirement: Creating a report-typed Document SHALL fan out a `document/created` `RealtimeEvent`

When `documentService.createDocument` persists a row with `type === "report"`, the service MUST publish exactly one `RealtimeEvent` on the `change` channel of the shared `eventBus`. The event MUST carry `entityType: "document"`, `action: "created"`, `entityUuid` equal to the new document's UUID, and `companyUuid` + `projectUuid` matching the document's company and project. The event MUST be published after the database insert succeeds and before the function returns. Failures of the publish step MUST NOT roll back the document insert; they MUST be logged at `warn` level with the document UUID.

#### Scenario: Report creation publishes a document `created` event

- **GIVEN** an approved Proposal `P` whose tasks have all reached a terminal state
- **WHEN** an authenticated agent calls `chorus_create_report` with `proposalUuid = P.uuid`, a non-empty `title`, and a non-empty Markdown `content`
- **THEN** the server MUST persist a `Document` row with `type = "report"` and `proposalUuid = P.uuid`
- **AND** the server MUST emit one `RealtimeEvent` with `entityType = "document"`, `action = "created"`, `entityUuid` equal to the new document's UUID, `projectUuid` equal to `P.projectUuid`, and `actorUuid` equal to the calling agent's UUID

#### Scenario: Non-report Document creation does not publish a document `created` event from this code path

- **WHEN** an authenticated PM agent calls `chorus_pm_create_document` with `type = "tech_design"` (or `prd`, `adr`, `spec`, `guide`)
- **THEN** the report-realtime emit branch in `documentService.createDocument` MUST NOT fire
- **AND** any unrelated `RealtimeEvent` emissions for non-report documents (added by future changes) are out of scope for this requirement

#### Scenario: A failure in the SSE publish does not undo the Document insert

- **GIVEN** an approved Proposal and a configured Redis publisher whose `publish()` rejects with an error
- **WHEN** an agent calls `chorus_create_report`
- **THEN** the `Document` row MUST be persisted in the database
- **AND** the tool MUST return a successful response with the new `documentUuid`
- **AND** the failure MUST be recorded in the application log at `warn` level

### Requirement: Creating an idea-rooted report SHALL also fan out an `idea/updated` `RealtimeEvent`

When the report-typed Document being created is linked to a Proposal whose `inputType === "idea"` (i.e. an idea-rooted Proposal), `documentService.createDocument` MUST publish a second `RealtimeEvent` on the `change` channel with `entityType: "idea"`, `action: "updated"`, and `entityUuid` set to the resolved Idea UUID (the first entry of `proposal.inputUuids`). When the Proposal is not idea-rooted, this second event MUST NOT be published.

#### Scenario: Report creation under an idea-rooted Proposal emits the idea event

- **GIVEN** an approved Proposal whose `inputType = "idea"` and `inputUuids = [I.uuid]`
- **WHEN** an agent calls `chorus_create_report` referencing that Proposal
- **THEN** the server MUST publish a second `RealtimeEvent` with `entityType = "idea"`, `action = "updated"`, `entityUuid = I.uuid`, and `projectUuid = I.projectUuid`
- **AND** this event MUST be published in addition to the `document/created` event from the previous Requirement

#### Scenario: Report creation under a non-idea-rooted Proposal does not emit an idea event

- **GIVEN** an approved Proposal whose `inputType = "document"` (no Idea ancestor)
- **WHEN** an agent calls `chorus_create_report` referencing that Proposal
- **THEN** the server MUST NOT publish any `entityType = "idea"` event from the report-realtime code path
- **AND** the `document/created` event from the previous Requirement MUST still be published

### Requirement: Creating an idea-rooted report SHALL produce a `report_created` `Notification` for the Idea creator and assignee

When a report is created under an idea-rooted Proposal, `documentService.createDocument` MUST emit an Activity event with `targetType: "idea"`, `targetUuid` equal to the resolved Idea UUID, and `action: "report_created"`. The `notification-listener` SHALL recognize `action: "report_created"` and produce one `Notification` row per (Idea creator, Idea assignee) recipient pair, deduplicated, excluding the actor themselves. The persisted `Notification.action` MUST equal the literal string `"report_created"`. Reports under non-idea-rooted Proposals MUST NOT produce notifications. No new `NotificationPreference` field is introduced; recipients always receive the notification subject only to the existing dedup + actor-exclusion logic.

#### Scenario: Notifications are sent to creator and assignee, dedup-aware

- **GIVEN** an Idea `I` whose `createdByUuid = U_creator` and whose `assigneeType = "agent"`, `assigneeUuid = A`
- **AND** an approved idea-rooted Proposal `P` referencing `I`
- **WHEN** an agent `A_actor` (where `A_actor != A`) calls `chorus_create_report` for `P`
- **THEN** exactly two `Notification` rows MUST be created — one with `recipientType = "user"`, `recipientUuid = U_creator`; the other with `recipientType = "agent"`, `recipientUuid = A`
- **AND** both rows MUST have `action = "report_created"`, `entityType = "idea"`, `entityUuid = I.uuid`, `actorUuid = A_actor.uuid`

#### Scenario: The actor is excluded from their own notification

- **GIVEN** an Idea `I` whose `createdByUuid = U` and whose `assigneeType = "user"`, `assigneeUuid = U` (creator and assignee are the same human)
- **WHEN** that same user `U` calls `chorus_create_report` for an approved Proposal under `I`
- **THEN** zero `Notification` rows MUST be created (after dedup + actor-exclusion both recipients collapse to the actor)

#### Scenario: Reports under non-idea-rooted Proposals do not produce notifications

- **GIVEN** an approved Proposal `P` with `inputType = "document"`, no Idea ancestor
- **WHEN** an agent calls `chorus_create_report` for `P`
- **THEN** no `Notification` row MUST be created
- **AND** no `Activity` event with `action = "report_created"` MUST be emitted

### Requirement: Notification text for `report_created` SHALL be rendered client-side via the existing i18n key pattern

The `notification-listener.buildMessage` function MUST produce an English fallback string for `action: "report_created"` (used as the persisted `Notification.message` column). The bell-popup UI MUST render the row's primary label by calling `t('notifications.types.report_created')` against the i18n provider, identical to every other notification row. The two i18n catalogs MUST gain the new key.

#### Scenario: English catalog carries the new i18n key

- **GIVEN** the file `messages/en.json`
- **WHEN** the file is read and the path `notifications.types.report_created` is resolved
- **THEN** the resolved value MUST be a non-empty English string

#### Scenario: Chinese catalog carries the new i18n key

- **GIVEN** the file `messages/zh.json`
- **WHEN** the file is read and the path `notifications.types.report_created` is resolved
- **THEN** the resolved value MUST be a non-empty Chinese string

#### Scenario: The bell popup renders the i18n label, not the stored message

- **GIVEN** a `report_created` `Notification` row whose `message` column contains an English fallback
- **WHEN** the user opens the notification popup with the locale set to `zh`
- **THEN** the row's primary label MUST display the Chinese string from `messages/zh.json` under the path `notifications.types.report_created`
- **AND** the row MUST NOT display the raw English `message` column value

### Requirement: The bell-popup deep-link for a `report_created` row SHALL land on the Idea overview panel

When the user clicks a notification row whose `action === "report_created"`, the bell popup MUST navigate the browser to `/projects/<projectUuid>/dashboard?ideaUuid=<entityUuid>&panel=overview`, where `<projectUuid>` is the notification's `projectUuid`, `<entityUuid>` is the notification's `entityUuid` (i.e. the parent Idea's UUID), and `panel=overview` is the literal query-string token that drives the dashboard's `IdeaDetailPanel` to open the overview tab.

#### Scenario: Click on a `report_created` row opens the Idea overview

- **GIVEN** a `report_created` notification with `projectUuid = P` and `entityUuid = I`
- **WHEN** the user clicks the notification row
- **THEN** the application MUST navigate to the URL `/projects/P/dashboard?ideaUuid=I&panel=overview`
- **AND** on landing, the `IdeaDetailPanel` MUST render with the `overview` tab active and the Reports list visible inline below the timeline

### Requirement: The Idea Tracker page SHALL refresh report counts on idea events

The existing `IdeaTrackerList` component subscribes to `useRealtimeEntityTypeEvent("idea", ...)`. Because Requirement 2 emits an `entityType: "idea"`, `action: "updated"` event whenever a report is created under an idea-rooted Proposal, the list MUST refetch idea data and the per-Idea `reportCount` badge MUST reflect the new count without a manual page refresh. No new client-side subscription is added.

#### Scenario: Tracker badge updates after a report is created on an Idea

- **GIVEN** a user has the Idea Tracker page open for project `P` with Idea `I` showing `reportCount = 0`
- **AND** an agent (in another session) calls `chorus_create_report` for an approved Proposal under `I`
- **WHEN** the resulting `entityType = "idea"`, `action = "updated"` SSE event reaches the user's browser
- **THEN** the IdeaTrackerList MUST refetch the project's idea-tracker data
- **AND** the row for `I` MUST display `reportCount = 1` within the existing 300ms event-debounce window

#### Scenario: Tracker badge does NOT update after a non-report Document creation under the same Idea

- **GIVEN** the same Idea Tracker context
- **AND** an agent calls `chorus_pm_create_document` with `type = "tech_design"` referencing `I`'s approved Proposal
- **WHEN** the request completes
- **THEN** the report-realtime code path MUST NOT emit any `entityType = "idea"` event from this code path

### Requirement: Updating or deleting a report-typed Document SHALL NOT produce a notification under this change

This change is scoped to **creation** only. `chorus_pm_update_document` and any future delete path on `type === "report"` Documents MUST NOT trigger the `report_created` notification or activity event introduced by this change. The Reports list refetch on those paths is governed by whatever events those existing tools already emit, not by this requirement.

#### Scenario: Updating an existing report does not produce a `report_created` notification

- **GIVEN** an existing Document with `type = "report"`, UUID `D`
- **WHEN** an agent calls `chorus_pm_update_document` with `documentUuid = D` and a non-empty `content`
- **THEN** no new `Notification` row with `action = "report_created"` MUST be created
- **AND** no `Activity` event with `action = "report_created"` MUST be emitted from this code path
