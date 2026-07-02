# project-resource-graph Specification (delta)

## ADDED Requirements

### Requirement: Node search with highlight, dim, and auto-expand to matches

The resource-graph view SHALL provide a search input that filters nodes by a case-insensitive substring match on the node title only (not on type or status text, and not fuzzy). As the query changes, the graph SHALL keep every matching node at full opacity, SHALL dim every non-matching node using the same dim treatment the hover lineage-highlight uses, and SHALL automatically expand the ancestor hubs (the matching node's idea and, where applicable, its proposal) so that every match becomes visible even when it was hidden under a collapsed hub. Matching SHALL be restricted to entity types currently visible under the type filter, so a filtered-out type produces no matches, and search SHALL NOT change the type-filter selections. The title used for matching SHALL come from data already present in the graph payload, so search SHALL NOT issue any per-entity or backend search request. When the query is empty or blank the graph SHALL behave as if no search is active (all nodes at normal opacity, no forced expansion). All user-facing search text SHALL be localized in both supported locales.

#### Scenario: Typing a query highlights matches and dims the rest

- **WHEN** a user types a query that matches one or more node titles
- **THEN** the matching nodes stay at full opacity, every other node is dimmed, and the ancestor hubs of each match are expanded so the matches are visible

#### Scenario: Match is case-insensitive substring on title only

- **WHEN** a user types a query in any letter case
- **THEN** a node matches when its title contains the query as a case-insensitive substring, and a node does not match merely because the query appears in its type or status text

#### Scenario: Search does not query the backend

- **WHEN** a user types or edits the query
- **THEN** matching is computed from the already-loaded graph payload and no per-entity detail request or backend search request is issued

#### Scenario: Search respects the type filter

- **WHEN** a type is toggled off in the filter and the query would match a node of that type
- **THEN** that node does not count as a match and the type-filter checkboxes are left unchanged by the search

#### Scenario: Clearing the query returns to the unsearched view

- **WHEN** the query becomes empty or blank
- **THEN** all nodes return to normal opacity and no node is dimmed by search

### Requirement: Hover lineage-highlight takes over during an active search

While a search is active, the hover (and selection) lineage-highlight SHALL take precedence over the search highlight. When the user hovers a node during an active search, the graph SHALL light that node's full upstream-and-downstream lineage and dim everything else — including other search matches — exactly as it does without a search; the search match set SHALL drive node opacity only when no node is hovered or selected. The current-match navigation cursor SHALL NOT trigger the lineage-highlight, so stepping through matches does not light up a match's ancestors and descendants.

#### Scenario: Hovering during search lights only the hovered node's lineage

- **WHEN** a search is active and the user hovers a node
- **THEN** only that node's upstream and downstream lineage is highlighted and everything else is dimmed, including other matches

#### Scenario: Matches drive opacity only when nothing is hovered

- **WHEN** a search is active and the pointer is not over any node
- **THEN** the matching nodes are highlighted and non-matching nodes are dimmed

#### Scenario: Stepping to a match does not light its lineage

- **WHEN** the user navigates to a match via the previous/next controls
- **THEN** the current match is indicated and centered but its ancestors and descendants are not lineage-highlighted

### Requirement: Match count and previous/next navigation centered on each match

The search controls SHALL display a match count and SHALL support stepping through matches. The controls SHALL show the current position and total number of matches (for example `3 / 12`), and SHALL provide previous and next actions that move a current-match cursor through the matches in their top-to-bottom reading order, wrapping around from the last match to the first and from the first to the last. Pressing Enter in the search input SHALL step to the next match and pressing Shift+Enter SHALL step to the previous match, using the same wrap-around cursor as the previous/next actions; this key handling SHALL be suppressed while an IME composition is in progress so confirming a candidate word does not advance the match. Activating a match as current SHALL bring it into view — on the desktop canvas by centering the camera on that node, and on the mobile vertical outline by scrolling that row into view. The current match SHALL receive a distinct visual indication separate from the plain-match highlight and from the selection indication. Recentering the camera in response to query edits SHALL be debounced so the view does not jump on every keystroke.

#### Scenario: Count shows current position and total

- **WHEN** a search has one or more matches
- **THEN** the controls show the current match position and the total match count, and a current match is indicated distinctly

#### Scenario: Next and previous step with wrap-around

- **WHEN** the user activates next on the last match, or previous on the first match
- **THEN** the cursor wraps to the first match (for next) or the last match (for previous), and the newly current match is brought into view and centered

#### Scenario: Enter and Shift+Enter step through matches

- **WHEN** the user presses Enter (or Shift+Enter) in the search input while not composing with an IME
- **THEN** the current-match cursor advances to the next match (or the previous match for Shift+Enter) with the same wrap-around and brings the new current match into view

#### Scenario: Enter during IME composition does not advance

- **WHEN** the user presses Enter to confirm an IME candidate word in the search input
- **THEN** the match cursor does not advance (the key handling is suppressed while composing)

#### Scenario: Current match is centered in both renderings

- **WHEN** a match becomes the current match
- **THEN** the desktop canvas centers the camera on that node and the mobile outline scrolls that row into view

#### Scenario: Empty result shows a no-matches hint and disables stepping

- **WHEN** a query matches no nodes
- **THEN** the controls show a localized no-matches hint, the count shows zero, the previous/next actions are disabled, and all nodes remain at normal opacity (the tree is not dimmed)

### Requirement: Search restores the pre-search expand state on exit

The graph SHALL restore the user's expand/collapse layout when a search ends. When a search begins (the query goes from blank to non-blank), the graph SHALL snapshot the current set of expanded ideas and proposals; when the search ends (the query is cleared via the clear control, the Escape key, or by becoming blank), the graph SHALL restore that snapshot, so any hubs expanded solely to reveal matches are collapsed again and the user's manual expansion is preserved. While the search is active, auto-expansion SHALL only add expanded hubs and SHALL NOT collapse a hub the user had expanded.

#### Scenario: Exiting search collapses search-forced expansion

- **WHEN** a search expanded hubs to reveal matches and the user then clears the query
- **THEN** those search-forced expansions are collapsed and the expand/collapse layout returns to what it was before the search began

#### Scenario: Manual expansion is preserved during search

- **WHEN** the user had a hub expanded before searching
- **THEN** that hub remains expanded throughout the search and after the query is cleared

### Requirement: Node search is available in both the canvas and the outline renderings

Node search SHALL be available in both the desktop canvas and the mobile vertical outline renderings, operating on the same shared search and expand state. Both renderings SHALL apply the match highlight and non-match dim, SHALL bring the current match into view when it changes (camera centering on the canvas, scroll-into-view on the outline), and SHALL present the same match count and previous/next controls. Because both renderings read the same shared state, changing the viewport size SHALL preserve the active query, the match set, and the current-match position.

#### Scenario: Search works in the mobile outline

- **WHEN** a user searches on a narrow viewport
- **THEN** the vertical outline highlights matching rows, dims non-matching rows, scrolls the current match into view, and shows the same count and previous/next controls

#### Scenario: Search state is shared across viewport sizes

- **WHEN** a user has an active search and the viewport changes between wide and narrow
- **THEN** the query, the matches, and the current-match position carry over because both renderings render from the same shared search state
