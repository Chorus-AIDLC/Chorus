# idea-panel-url-sync Specification

## ADDED Requirements

### Requirement: Dashboard idea panel reflects the URL on soft navigation

The Dashboard idea detail panel selection SHALL be derived from the browser URL query parameter `panel` as its source of truth. When the URL changes to `?panel=<ideaUuid>` via App Router soft navigation (`router.push`, `router.replace`, or `<Link>`) while the Dashboard is already mounted, the panel SHALL open or switch to that idea without requiring a full page reload or a `popstate` event.

#### Scenario: Clicking a notification idea link switches the panel in place

- **WHEN** a user is already on `/projects/{projectUuid}/dashboard` and opens a notification whose target is an idea, then clicks it
- **THEN** the URL becomes `/projects/{projectUuid}/dashboard?panel={ideaUuid}`
- **AND** the right-hand idea detail panel opens (or switches) to `{ideaUuid}` without a full page reload

#### Scenario: Switching between two ideas while the panel is open

- **WHEN** the panel is open for idea A and the user soft-navigates to `?panel={ideaB}` (e.g. from search, the SSE toast, or an agent-presence row)
- **THEN** the panel switches to idea B

#### Scenario: Closing the panel clears the selection

- **WHEN** the URL transitions from `?panel={ideaUuid}` to a URL with no `panel` parameter
- **THEN** the idea detail panel closes

### Requirement: All soft-navigation idea entry points open the panel

Every in-app navigation that targets an idea by building a `?panel={ideaUuid}` Dashboard URL SHALL result in the panel opening when the user is already on the Dashboard. This applies uniformly to the notification popup, the real-time notification toast, global search, and agent-presence execution rows / chat turn-band links.

#### Scenario: Global search opens the panel in place

- **WHEN** a user already on the Dashboard selects an idea result in global search
- **THEN** the panel opens to that idea (the URL change alone is not sufficient — the panel must visibly switch)

#### Scenario: Agent-presence idea link opens the panel in place

- **WHEN** a user already on the Dashboard clicks an idea-anchored agent-presence execution row or chat turn-band "Open idea" link
- **THEN** the panel opens to that idea

### Requirement: Panel navigation preserves tracker state and back/forward

Synchronizing the panel to the URL SHALL NOT remount the Idea Tracker subtree, and SHALL keep browser back/forward and the `tab` parameter working.

#### Scenario: Switching the panel does not reset the tracker view

- **WHEN** the user has selected a tracker view (ideas / lineage / stats) or scrolled the list, then soft-navigates to a different `?panel={ideaUuid}`
- **THEN** the selected view and list state are preserved (the tracker subtree is not remounted)

#### Scenario: The tab parameter continues to work alongside panel

- **WHEN** the URL is `?panel={ideaUuid}&tab=overview`
- **THEN** the panel opens to that idea with the `overview` tab selected

#### Scenario: Browser back and forward update the panel

- **WHEN** the user navigates between panel states and then presses the browser Back or Forward button
- **THEN** the panel selection updates to match the restored URL
