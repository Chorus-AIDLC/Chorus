## MODIFIED Requirements

### Requirement: The dashboard SHALL surface daemon connections through a single bottom-right floating entry
The dashboard SHALL surface the caller's visible daemon connections through a **single floating entry pinned to the bottom-right of the viewport**, present on every dashboard page, replacing BOTH the resident sidebar presence pill and the separate bottom-right pixel-canvas widget button. There SHALL be no presence pill in the sidebar rail or mobile drawer, and no second standalone bottom-right widget button; the floating entry is the one affordance for daemon presence and conversation.

The floating entry SHALL be driven by the single shell-level presence data source (the same source that backs the connection list and the chat modal), so it is company-wide and remains live across route changes without starting a second poll of the connection list.

The change SHALL preserve the standing guarantees established when the standalone `/agent-connections` page was retired: there SHALL be no standalone `/agent-connections` page route and no `RadioTower` global-navigation item for it, a request to the former `/agent-connections` path SHALL be redirected rather than returning a broken route, and no surface SHALL be labeled "Daemons".

The entry's trigger button SHALL display a glanceable status indicator that distinguishes, without silently conflating them, an idle state when the online count is zero (which MUST remain visible rather than disappearing), a loading state (a muted placeholder that does not flash a misleading count), and a request-failure state (a distinguished unavailable indicator that MUST NOT render as "0 online"). For a non-zero online count the button SHALL surface an online-count badge and a liveness dot that honors the user's reduced-motion preference (a static dot when reduced motion is preferred).

The online count surfaced by the entry SHALL be the number of **distinct online Agents** — an Agent online across multiple hosts or cwds SHALL count once — so the number matches the entry's "agents online" label. The count SHALL NOT be the number of daemon connections or `(agent, host, cwd)` instances, and it SHALL key on Agent identity (`agentUuid`), never on the nullable display name. The connection-oriented "View all" modal's own connection list and counts are out of scope of this rule and remain connection-based.

#### Scenario: A single floating entry appears bottom-right on every dashboard page

- **GIVEN** an authenticated user on any dashboard page (project or global)
- **WHEN** the shell renders
- **THEN** a single floating entry MUST be pinned to the bottom-right of the viewport
- **AND** there MUST be no presence pill in the sidebar rail or mobile drawer
- **AND** there MUST be no separate standalone bottom-right widget button beside it

#### Scenario: The zero state stays visible and is distinct from failure

- **GIVEN** an authenticated user with zero online Agents and a successful fetch
- **WHEN** the entry button renders
- **THEN** it MUST show a visible idle "0 online" state rather than disappearing
- **AND** when instead the fetch fails, the button MUST show a distinguished unavailable state that is NOT presented as "0 online"

#### Scenario: A non-zero online count shows distinct online Agents with reduced-motion-aware liveness

- **GIVEN** a user with at least one online Agent
- **WHEN** the entry button renders
- **THEN** it MUST surface an online-count badge reflecting the number of distinct online Agents
- **AND** the liveness dot MUST animate only when the user has not requested reduced motion (otherwise a static dot conveys online status)

#### Scenario: One Agent online in multiple cwds counts once

- **GIVEN** a single Agent that is online through three daemon connections on three different cwds and no other Agent is online
- **WHEN** the entry button renders its online-count badge
- **THEN** the badge MUST show a count of 1
- **AND** the count MUST NOT reflect the three underlying connections

#### Scenario: The entry uses the shared presence source with no duplicate polling

- **GIVEN** the dashboard shell is mounted
- **WHEN** the floating entry button, its popover, and the opened chat modal are showing connection data
- **THEN** they MUST be driven by one shared shell-level presence data source
- **AND** opening the popover or the chat modal MUST NOT start a second independent poll of the connection list

#### Scenario: The former standalone page stays removed and redirected

- **GIVEN** the change is implemented
- **WHEN** a request is made to the former `/agent-connections` path
- **THEN** there MUST be no standalone page route and no `RadioTower` global-nav item for it
- **AND** the request MUST be redirected rather than rendering a broken route
- **AND** no surface MUST be labeled "Daemons"
