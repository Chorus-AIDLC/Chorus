## ADDED Requirements

### Requirement: The daemon chat conversation list SHALL show a loading state while it loads, distinct from its empty state

The daemon session chat conversation list (the left pane of the "View all" chat modal) SHALL render a loading affordance — a set of skeleton placeholder rows — while its session data is still being fetched, and SHALL render its "no conversations" empty state ONLY after the fetch has completed and genuinely returned no conversations for the selected agent. The loading state and the empty state SHALL be visually distinct so a user can never mistake an in-flight load for an empty list.

The loading affordance SHALL be gated on the conversation list's OWN fetch status alone, not on the independently-settling presence/connections status, so the empty state is never shown during the window where connections have loaded but the session list has not. The loading affordance SHALL appear on the first load (and any load where the list has no data yet), and SHALL NOT re-appear on the periodic background refresh once a first load has succeeded — the background refresh updates the list silently without flashing the loading state.

A load failure with no cached conversations SHALL continue to show the distinct error card, never the empty state and never an indefinite loading state.

#### Scenario: Loading state shows while the list is still fetching

- **GIVEN** the daemon chat modal is open and the conversation list fetch has not yet completed
- **WHEN** the connections/presence status has already settled to loaded but the session list is still loading
- **THEN** the conversation list MUST render the loading affordance (skeleton placeholder rows)
- **AND** it MUST NOT render the "no conversations" empty state

#### Scenario: Empty state shows only after a settled empty load

- **GIVEN** the conversation list fetch has completed successfully
- **WHEN** the selected agent has zero conversations
- **THEN** the conversation list MUST render the "no conversations" empty state
- **AND** it MUST NOT render the loading affordance

#### Scenario: Rows show after a settled non-empty load

- **GIVEN** the conversation list fetch has completed successfully
- **WHEN** the selected agent has one or more conversations
- **THEN** the conversation list MUST render the conversation rows
- **AND** it MUST NOT render either the loading affordance or the empty state

#### Scenario: Background refresh does not flash the loading state

- **GIVEN** the conversation list has completed its first successful load and is showing rows or the empty state
- **WHEN** the periodic background refresh re-fetches the session list
- **THEN** the conversation list MUST continue showing its settled content without re-rendering the loading affordance

#### Scenario: A load failure shows the error card, not the empty or loading state

- **GIVEN** the conversation list fetch fails and there are no cached conversations
- **WHEN** the chat body decides what to render
- **THEN** it MUST render the distinct load-error card
- **AND** it MUST NOT render the "no conversations" empty state or the loading affordance
