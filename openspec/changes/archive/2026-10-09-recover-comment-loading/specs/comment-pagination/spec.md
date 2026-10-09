## MODIFIED Requirements

### Requirement: Comment list HTTP and server-action pagination

The comment listing HTTP endpoint and server action SHALL expose cursor-based mode while preserving the existing offset response for callers that do not request cursor pagination. The browser comment component SHALL use authenticated, non-cached HTTP reads independently of the Server Action queue.

#### Scenario: HTTP cursor request

- **WHEN** an authorized viewer requests GET `/api/comments` with cursor and/or a valid limit
- **THEN** the response contains comments with agent-owner attribution, total, nextCursor and hasMore
- **AND** it is not cached

#### Scenario: Invalid cursor limit

- **WHEN** a provided cursor-mode limit is not an integer from 1 through 100
- **THEN** the endpoint returns a validation error without querying comments

#### Scenario: HTTP offset request unchanged

- **WHEN** GET `/api/comments` omits cursor and limit
- **THEN** it preserves the existing offset response and ordering

#### Scenario: Server action returns page plus continuation

- **WHEN** an existing caller uses the comment server action
- **THEN** it still receives attributed comments and cursor continuation metadata

#### Scenario: Access remains enforced

- **WHEN** a requester lacks viewer access to the target
- **THEN** comment and owner data are not returned and hidden targets retain the existing non-disclosing denial

## ADDED Requirements

### Requirement: Bounded recoverable comment reads

The comment UI SHALL bound each read including response parsing to 15 seconds, SHALL handle rejected and malformed reads, and SHALL support retry without closing the panel. Obsolete reads SHALL be cancelled or ignored.

#### Scenario: First-page failure or deadline

- **WHEN** the initial read rejects, returns an invalid response, or exceeds its deadline
- **THEN** the initial spinner exits and a localized error with retry is shown
- **AND WHEN** retry succeeds
- **THEN** the comment page and accurate count are rendered

#### Scenario: Older-page recovery

- **WHEN** an older-page read fails
- **THEN** existing comments and the continuation cursor remain intact and an explicit retry is available
- **AND** repeated scroll notifications cannot stack requests

#### Scenario: Obsolete response

- **WHEN** the target changes, the component unmounts, or a new initial attempt supersedes an old one
- **THEN** old responses cannot alter current comments, counters, pagination, errors, or loading state

#### Scenario: Realtime refresh resilience

- **WHEN** realtime events overlap or a background read fails
- **THEN** refreshes are coalesced and visible comments remain usable without unhandled rejection
- **AND** stale refresh results cannot undo successful local comment mutations
