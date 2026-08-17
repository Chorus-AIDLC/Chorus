## ADDED Requirements

### Requirement: Agent avatars use locally-generated DiceBear Thumbs (animated)
The system SHALL render every agent's avatar as a DiceBear "Thumbs" style avatar, generated locally in-process (no external network request), deterministically seeded by the agent's name. The animated variant SHALL be used by default so the avatar loops its motion.

#### Scenario: Rendering an agent avatar
- **WHEN** any surface renders an avatar for an agent
- **THEN** it displays a DiceBear Thumbs avatar generated locally from the agent's name
- **AND** no request is made to an external avatar service (e.g. api.dicebear.com)

#### Scenario: Deterministic by name
- **WHEN** the same agent name is rendered in two different places (or re-rendered)
- **THEN** the produced avatar is identical (same seed → same image)
- **AND** the avatar's coloring stays consistent with the existing name-hashed agent color

#### Scenario: Animation on by default
- **WHEN** an agent avatar is rendered and the user has not requested reduced motion
- **THEN** the avatar plays its looping animation

### Requirement: Reduced-motion accessibility fallback
The system SHALL respect the operating system `prefers-reduced-motion` setting for agent avatars.

#### Scenario: Reduced motion requested
- **WHEN** the user's OS `prefers-reduced-motion: reduce` is set
- **THEN** the agent avatar renders as a static (non-animated) Thumbs avatar instead of the looping one

### Requirement: Shared component replaces all agent Bot-glyph surfaces
Agent avatars SHALL be rendered through a single shared `<AgentAvatar>` component, and every surface that previously rendered an agent as a generic `Bot` glyph SHALL use it. Human (user) identities are out of scope and SHALL be left unchanged.

#### Scenario: Existing agent surfaces are swept
- **WHEN** an agent's specific identity appears in the comment author area; an Idea or Task assignee display (detail panel, Kanban card, task view-toggle list, assignee section, task list); Task Active Workers or the Kanban blocker dialog; an assign flow (`assign-task-modal`, `assign-idea-modal`, the generic `assign-modal`); the @mention picker or the rendered @agent mention badge (and its popover); a proposal creator (kanban card and detail); the presence roster / identity blocks / bottom-right presence entry / connections rail; the live-edit presence indicator; the daemon-chat agent selector; the API-key list; or the project agent cwd settings
- **THEN** the agent is shown via the shared `<AgentAvatar>` component rather than a `Bot` glyph or a name-only text row

#### Scenario: Users are not changed
- **WHEN** a human user appears on a surface shared with agents (e.g. comment author, assignee, @mention picker)
- **THEN** the user continues to render with the existing initials / `User` icon, unchanged

#### Scenario: No un-migrated agent-identity site remains
- **WHEN** the integration pass greps the codebase for `Bot`, `getAgentColor`, `agentName`, `agent.name`, `createdByType === "agent"`, and `isAgentAssignee`
- **THEN** every hit is classified as either "specific agent identity → migrated to `<AgentAvatar>`" or "semantic/decorative icon or plain text → intentionally kept"
- **AND** no specific-agent-identity site is left rendering a `Bot` glyph outside `<AgentAvatar>`

### Requirement: Agent avatars added to surfaces that lacked them
The system SHALL show an agent avatar on the create-agent / onboarding flow (preview, test-connection, completion), the project cwd-pin hover card, the project agent cwd settings rows, and the daemon chat message header.

#### Scenario: Create/onboard live preview
- **WHEN** a user is creating an agent or onboarding and has entered an agent name
- **THEN** an avatar preview is shown that updates live from the typed name
- **AND** the same avatar is shown on the onboarding test-connection and completion steps for the created agent

#### Scenario: cwd pin hover shows the avatar
- **WHEN** a user hovers the project-top agent cwd pin
- **THEN** the hover card shows the agent's avatar in addition to the cwd

#### Scenario: Daemon chat shows the avatar
- **WHEN** a daemon chat message from an agent is displayed
- **THEN** the message shows the agent's avatar alongside its name

### Requirement: Agent avatars render correctly in light and dark themes
Agent avatar containers SHALL use semantic theme tokens and render correctly in both light and dark themes.

#### Scenario: Dark theme
- **WHEN** the app is in dark theme
- **THEN** the agent avatar and its container (ring/border/fallback background) are legible and correctly colored, with no hardcoded light-only colors
