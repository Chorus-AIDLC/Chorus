# comment-pagination Specification

## Purpose
TBD - created by archiving change add-comment-pagination. Update Purpose after archive.
## Requirements
### Requirement: Cursor-based comment page retrieval

The comment service SHALL provide a cursor-based retrieval mode for an entity's comments that returns a bounded page ordered newest-first, alongside a cursor for fetching the next-older page. This mode SHALL be additive: the existing offset (`skip`/`take`, oldest-first) retrieval mode used by the MCP `chorus_get_comments` tool MUST remain unchanged in behavior and ordering.

#### Scenario: First page returns newest comments

- **WHEN** the service is asked for comments of a target entity with a page `limit` and no cursor
- **THEN** it returns at most `limit` comments for that entity ordered newest-first (descending `createdAt`, breaking ties by descending insertion order)
- **AND** it returns `hasMore = true` with a non-null `nextCursor` when older comments remain, or `hasMore = false` with `nextCursor = null` when the page reaches the oldest comment

#### Scenario: Cursor page returns strictly older comments

- **WHEN** the service is asked for comments with a `cursor` equal to a previously returned `nextCursor` (a comment uuid) and a page `limit`
- **THEN** it returns at most `limit` comments strictly older than the cursor comment, ordered newest-first, without including the cursor comment itself

#### Scenario: Total count accompanies every cursor page

- **WHEN** any cursor-mode page is returned
- **THEN** the response includes the total number of comments for the target entity, independent of how many pages have been loaded

#### Scenario: Stale or unknown cursor degrades gracefully

- **WHEN** a cursor uuid is provided that does not resolve to a comment of the target entity
- **THEN** the service returns the newest page (as if no cursor was given) instead of raising an error

#### Scenario: Offset mode is preserved

- **WHEN** comments are retrieved in offset mode (`skip`/`take`, as the MCP tool does)
- **THEN** the comments are returned oldest-first with the pre-existing response shape, unaffected by the cursor-mode addition

### Requirement: Comment list HTTP and server-action pagination

The comment listing HTTP endpoint and the server action that the UI calls SHALL expose the cursor-based mode while preserving the existing offset response for callers that do not request cursor pagination.

#### Scenario: HTTP cursor request

- **WHEN** `GET /api/comments` is called with a `cursor` and/or `limit` query parameter for a valid target
- **THEN** the response body contains the comment page, the total count, a `nextCursor`, and a `hasMore` flag

#### Scenario: HTTP offset request unchanged

- **WHEN** `GET /api/comments` is called without `cursor` or `limit`
- **THEN** it responds with the pre-existing offset/paginated response shape

#### Scenario: Server action returns page plus continuation

- **WHEN** the comment server action is invoked with a target and optional cursor/limit
- **THEN** it returns the resolved comments (with agent-owner attribution), the total count, the `nextCursor`, and the `hasMore` flag

### Requirement: Universal comment component loads incrementally on scroll

The universal comment component SHALL load only the first page of comments on initial render and SHALL automatically load the next-older page as the user scrolls toward the end of the list, keeping newest comments at the top.

#### Scenario: First paint loads only the first page

- **WHEN** an entity detail surface containing the comment component is opened
- **THEN** the component requests and renders only the first page (10 comments) rather than all comments

#### Scenario: Scrolling near the end loads older comments

- **WHEN** the user scrolls the comment list near its end and more comments remain
- **THEN** the component automatically requests the next-older page using the current continuation cursor and appends those older comments below the existing ones, without resetting scroll position

#### Scenario: Loading and end-of-list affordances

- **WHEN** a page request is in flight
- **THEN** a loading indicator is shown
- **AND WHEN** the oldest comment has been reached
- **THEN** an end-of-list "no more comments" indication is shown and no further page requests are made

#### Scenario: Repeated triggers do not stack requests

- **WHEN** the load-more trigger fires while a page request is already in flight or while there are no more pages
- **THEN** no additional page request is started

### Requirement: Real-time comments merge without full reload

When a real-time comment event arrives for the displayed entity, the component SHALL incrementally merge new comments into the loaded list, de-duplicated by comment uuid, without discarding already-loaded older pages and without resetting scroll position. Optimistic insertion of the user's own newly posted comment SHALL likewise be de-duplicated against the real-time echo.

#### Scenario: Live comment from another author appears at the top

- **WHEN** a real-time event indicates the displayed entity changed and a new comment exists
- **THEN** the component merges the newest comments into the top of the list de-duplicated by uuid, preserving the already-loaded older pages and the current scroll position

#### Scenario: No duplicate when optimistic insert meets the live echo

- **WHEN** the current user posts a comment that is inserted optimistically and the same comment later arrives via a real-time refresh
- **THEN** the comment appears exactly once in the list

#### Scenario: Burst of new comments leaves no unreachable gap

- **WHEN** more new comments than one page size are created for the displayed entity between two real-time merges
- **THEN** the component fetches successive newest-to-older pages and merges them until it overlaps an already-loaded comment (de-duplicated by uuid), so every new comment becomes reachable in the loaded window with no permanent hole, bounded so a burst never forces an unbounded reload

### Requirement: Comment count reflects server total

Surfaces that display a comment count SHALL derive it from the server-reported total comment count rather than the number of currently loaded comments, so the count stays accurate while only a subset of comments is loaded.

#### Scenario: Count is accurate before all pages are loaded

- **WHEN** only the first page of comments is loaded for an entity that has more comments than one page
- **THEN** the displayed comment count equals the entity's total comment count, not the number of loaded comments

