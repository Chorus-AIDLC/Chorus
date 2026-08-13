## ADDED Requirements

### Requirement: Project overview cwd summary identifies each Agent
The project overview cwd summary SHALL make each configured Agent's cwd badge visually attributable to a specific Agent without hovering. Each badge SHALL show a colored Agent identity dot together with the visible Agent name as the primary label, and SHALL move the full cwd path into the badge's hover tooltip. The identity dot SHALL derive its color from the app's shared deterministic per-Agent color helper (a stable hash of the Agent name into a fixed palette chosen to read on both light and dark backgrounds) rather than introducing a new color scheme or reusing the status-colored presence dot, and SHALL render correctly in both themes. This change SHALL remain frontend-only over the existing `GET /api/projects/[uuid]/agent-cwds` data (which already returns the Agent name and host); it SHALL NOT change that API, its service, the database schema, add a migration, or add a new permission bit. Every user-facing string SHALL resolve from the locale catalog in both supported locales.

#### Scenario: Two Agents' badges are distinguishable at a glance
- **WHEN** a project has fixed cwd preferences for two different Agents whose cwds share a long common path prefix
- **THEN** each badge MUST display that Agent's identity color dot and visible name
- **AND** the two badges MUST be distinguishable without hovering either one

#### Scenario: The cwd path is available on hover
- **WHEN** a user hovers a cwd badge in the overview summary
- **THEN** the badge's tooltip MUST show the full cwd path for that Agent

#### Scenario: The identity dot uses the shared deterministic per-Agent color
- **WHEN** the overview summary renders an Agent's cwd badge
- **THEN** the badge's identity dot MUST take its color from the shared deterministic per-Agent color helper (same Agent → same color) rather than the status-colored presence dot
- **AND** the dot MUST render legibly in both the light and dark themes

#### Scenario: No backend change is introduced
- **WHEN** the badge change is implemented
- **THEN** it MUST read the existing `GET /api/projects/[uuid]/agent-cwds` response without modifying that API or its service
- **AND** it MUST NOT change the database schema, add a migration, or add a new permission bit
