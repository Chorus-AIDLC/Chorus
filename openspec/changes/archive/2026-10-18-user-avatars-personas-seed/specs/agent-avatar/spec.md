## MODIFIED Requirements

### Requirement: Shared component replaces all agent Bot-glyph surfaces
Agent avatars SHALL be rendered through a single shared `<AgentAvatar>` component, and every surface that previously rendered an agent as a generic `Bot` glyph SHALL use it. Human user avatars SHALL follow the separate user-avatar capability; human customization SHALL NOT alter Agent avatar rendering.

#### Scenario: Existing agent surfaces are swept
- **WHEN** an agent's specific identity appears in the comment author area; an Idea or Task assignee display (detail panel, Kanban card, task view-toggle list, assignee section, task list); Task Active Workers or the Kanban blocker dialog; an assign flow (`assign-task-modal`, `assign-idea-modal`, the generic `assign-modal`); the @mention picker or the rendered @agent mention badge (and its popover); a proposal creator (kanban card and detail); the presence roster / identity blocks / bottom-right presence entry / connections rail; the live-edit presence indicator; the daemon-chat agent selector; the API-key list; or the project agent cwd settings
- **THEN** the agent is shown via the shared `<AgentAvatar>` component rather than a `Bot` glyph or a name-only text row

#### Scenario: Human and agent rendering stay independent
- **WHEN** a human user appears on a surface shared with agents or changes their avatar seed
- **THEN** the human avatar follows the user-avatar capability
- **AND** the Agent avatar's seed, style and animation behavior remain unchanged

#### Scenario: Users are not changed
- **WHEN** an Agent avatar is rendered or updated on a surface shared with human users
- **THEN** the user's persisted avatar seed is not changed by Agent rendering
- **AND** the human avatar follows the user-avatar capability rather than inheriting the Agent style

#### Scenario: No un-migrated agent-identity site remains
- **WHEN** the integration pass greps the codebase for `Bot`, `getAgentColor`, `agentName`, `agent.name`, `createdByType === "agent"`, and `isAgentAssignee`
- **THEN** every hit is classified as either "specific agent identity → migrated to `<AgentAvatar>`" or "semantic/decorative icon or plain text → intentionally kept"
- **AND** no specific-agent-identity site is left rendering a `Bot` glyph outside `<AgentAvatar>`
