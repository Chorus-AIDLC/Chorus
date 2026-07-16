## ADDED Requirements

### Requirement: MCP notes parameter docs nudge concise summaries
The MCP tool documentation for a reference's `notes` parameter SHALL instruct agents to keep the summary to a single concise sentence (about 200 characters, at most two lines), noting that the UI clamps the displayed text to two lines. This wording SHALL appear in every place the `notes` parameter is described: the shared inline `referenceInlineItemSchema` (reused by `chorus_pm_create_idea`, `chorus_pm_create_proposal`, and — via `public.ts` — `chorus_create_tasks`), the `chorus_add_reference` tool, and the `chorus_update_reference` tool. The nudge SHALL be documentation-only: `notes` remains an unconstrained string with no server-side length cap or validation. The `docs/MCP_TOOLS.md` reference rows for `notes` SHALL be updated to match.

#### Scenario: Inline references[] notes describe carries the concise nudge
- **WHEN** the `notes` field of the shared inline reference schema is inspected (`.describe(...)`)
- **THEN** its text asks for one concise sentence and states a ~200-character / two-line target

#### Scenario: add_reference and update_reference notes describe carry the nudge
- **WHEN** the `notes` parameter description of `chorus_add_reference` and of `chorus_update_reference` is inspected
- **THEN** each asks for a concise one-sentence summary with the ~200-character / two-line target, and `chorus_update_reference` still documents that `null` clears and omission leaves it unchanged

#### Scenario: No length validation is introduced
- **WHEN** an over-long `notes` value is submitted to any reference create/update tool
- **THEN** it is accepted and stored verbatim (no `.max()` rejection); the length guidance is advisory only

#### Scenario: MCP tool reference doc matches
- **WHEN** `docs/MCP_TOOLS.md` `notes` rows are read
- **THEN** they carry the same concise-summary guidance as the tool `.describe()` strings
