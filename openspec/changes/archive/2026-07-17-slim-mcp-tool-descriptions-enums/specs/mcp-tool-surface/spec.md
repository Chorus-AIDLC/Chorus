## ADDED Requirements

### Requirement: Filter and type parameters SHALL be strictly enum-typed

The MCP filter/type parameters listed below SHALL be declared as `z.enum([...])` (rather than `z.string().describe(...)`), with the enum domain limited to the **currently valid stored values** — legacy, derived, or never-written values are excluded. Optional parameters MUST remain optional after the conversion (the enum narrows the value domain, not the required-ness).

The parameters and their exact enum domains are:

- `chorus_get_ideas.status` → `open`, `elaborating`, `elaborated`
- `chorus_list_tasks.status` → `open`, `assigned`, `in_progress`, `to_verify`, `done`, `closed`
- `chorus_list_tasks.priority` → `low`, `medium`, `high`
- `chorus_get_documents.type` → `prd`, `tech_design`, `adr`, `spec`, `guide`, `report`
- `chorus_get_proposals.status` → `draft`, `pending`, `approved`, `closed`
- `chorus_pm_add_document_draft.type` → `prd`, `tech_design`, `adr`, `spec`, `guide`, `report`
- `chorus_pm_update_document_draft.type` → `prd`, `tech_design`, `adr`, `spec`, `guide`, `report`

#### Scenario: An out-of-domain filter value is rejected at the schema layer

- **GIVEN** the `chorus_get_proposals` tool's input schema
- **WHEN** it is asked to parse arguments where `status` is `"revised"` (a value never written to `Proposal.status`)
- **THEN** schema validation MUST fail
- **AND** the failure MUST occur before any service call (no query is executed)

#### Scenario: Every advertised enum value is accepted

- **GIVEN** each converted parameter above
- **WHEN** its input schema parses an argument object whose value equals any single member of that parameter's enum domain
- **THEN** validation MUST succeed

#### Scenario: Stale filter values are absent from the enum domains

- **GIVEN** the converted parameters
- **WHEN** their enum members are enumerated
- **THEN** `chorus_get_ideas.status` MUST NOT include `proposal_created`, `completed`, or `closed`
- **AND** `chorus_get_proposals.status` MUST NOT include `rejected` or `revised`

#### Scenario: Optional filter parameters remain optional

- **GIVEN** each converted parameter that was optional before this change (`chorus_get_ideas.status`, `chorus_list_tasks.status`, `chorus_list_tasks.priority`, `chorus_get_documents.type`, `chorus_get_proposals.status`, `chorus_pm_update_document_draft.type`)
- **WHEN** its tool's input schema parses an argument object that omits the parameter
- **THEN** validation MUST succeed

### Requirement: Over-long tool descriptions SHALL be compressed to what/when text

The top-level `description` string of each of these seven MCP tools SHALL state only what the tool is and when to pick it, in at most two sentences: `chorus_create_report`, `chorus_get_proposal`, `chorus_pm_start_elaboration`, `chorus_create_tasks`, `chorus_update_task`, `chorus_pm_assign_task`, `chorus_add_reference`. Multi-step usage procedures and section-by-section field contracts MUST NOT remain in the top-level description; they MUST be relocated to parameter-level `.describe()` text and/or the skill documentation.

#### Scenario: Each targeted description is concise

- **GIVEN** the registered input metadata for each of the seven tools
- **WHEN** its top-level `description` is measured
- **THEN** the description MUST contain at most two sentences
- **AND** it MUST NOT contain a multi-step numbered or bulleted usage procedure

#### Scenario: Parameter detail moves to parameter describe text

- **GIVEN** `chorus_create_report` after this change
- **WHEN** its schema is inspected
- **THEN** the `## Summary` / `## Decisions` / `## Follow-ups` section contract MUST appear in the `content` parameter's `.describe()` text rather than in the top-level description

### Requirement: Agent behavior red-lines SHALL survive description slimming

When an over-long description is compressed, any behavior rule that must hold even for an agent that has not loaded the corresponding skill SHALL be preserved. A rule that applies to the whole call MUST remain as a short clause in the top-level description; a rule bound to a specific parameter MUST move into that parameter's `.describe()` text. No such red-line may be dropped entirely.

#### Scenario: The "no Other option" rule stays attached to the options parameter

- **GIVEN** `chorus_pm_start_elaboration` after this change
- **WHEN** its schema is inspected
- **THEN** the instruction not to add an "Other" option MUST appear in the `.describe()` text of the `questions` (or nested `options`) parameter
- **AND** the instruction to record decisions even when requirements were discussed outside the tool MUST remain present in the top-level description

### Requirement: First-party documentation SHALL absorb the relocated procedural content

The behavior rules and usage procedures removed from the seven tool descriptions SHALL be present in the first-party skill documentation so that no guidance is lost. The skill-documentation surfaces in scope are `public/skill/**/SKILL.md` and `public/chorus-plugin/skills/chorus/SKILL.md`, and the internal reference `docs/MCP_TOOLS.md`.

#### Scenario: Relocated elaboration guidance is present in both skill roots

- **GIVEN** the elaboration usage guidance removed from `chorus_pm_start_elaboration`'s description
- **WHEN** `public/skill/idea-chorus/SKILL.md` and `public/chorus-plugin/skills/chorus/SKILL.md` are read
- **THEN** the interactive-presentation and record-outside-conversation guidance MUST be present in the skill documentation

#### Scenario: The internal MCP reference reflects the trimmed descriptions

- **WHEN** `docs/MCP_TOOLS.md` is read for the seven affected tools
- **THEN** its entries MUST be consistent with the trimmed tool descriptions (no contradicting stale procedure that was removed from the schema without a documented home)
