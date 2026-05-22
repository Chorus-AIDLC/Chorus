## ADDED Requirements

### Requirement: The Chorus MCP server SHALL NOT expose `chorus_pm_create_tasks`

The MCP tool registration `chorus_pm_create_tasks` MUST be removed from the server. Its functionality is fully covered by the public `chorus_create_tasks` tool (line-for-line identical service calls), and the redundant alias inflates the model's tool-selection surface for no operational benefit. The tool was previously labelled `[Deprecated]` in its description.

#### Scenario: Listing tools no longer surfaces `chorus_pm_create_tasks`

- **WHEN** an authenticated agent calls `tools/list` against `/api/mcp`
- **THEN** the response MUST NOT include any tool whose `name` field equals `chorus_pm_create_tasks`
- **AND** the response MUST still include `chorus_create_tasks` with its existing input schema unchanged

#### Scenario: Calling the removed tool returns a standard MCP error

- **WHEN** an authenticated agent calls `tools/call` with `name: "chorus_pm_create_tasks"` and any arguments
- **THEN** the server MUST return the standard MCP `Method not found` error path (the same path returned for any unknown tool name)
- **AND** the server MUST NOT create any tasks
- **AND** the server MUST NOT log a warning suggesting a replacement (the migration is documented out-of-band; the runtime does not auto-migrate)

#### Scenario: The permission map no longer references the removed tool

- **GIVEN** the permission gate file `src/mcp/tools/permission-map.ts`
- **WHEN** the file is read
- **THEN** it MUST NOT contain any entry whose key equals `chorus_pm_create_tasks`

### Requirement: The Chorus MCP server SHALL NOT expose `chorus_add_task_dependency`

The MCP tool registration `chorus_add_task_dependency` MUST be removed from the server. Its functionality is fully covered by `chorus_update_task` via the `addDependsOn` parameter, which calls the same `taskService.addTaskDependency` with the same cycle detection. Removing the alias reduces tool-selection ambiguity for dependency operations.

#### Scenario: Listing tools no longer surfaces `chorus_add_task_dependency`

- **WHEN** an authenticated agent calls `tools/list` against `/api/mcp`
- **THEN** the response MUST NOT include any tool whose `name` field equals `chorus_add_task_dependency`
- **AND** the response MUST still include `chorus_update_task` whose input schema continues to accept an `addDependsOn` array of task UUIDs

#### Scenario: Adding a dependency works via the canonical tool

- **GIVEN** two open tasks `A` and `B` in the same project, `B` having no dependencies
- **WHEN** the agent calls `chorus_update_task({ taskUuid: "<B-uuid>", addDependsOn: ["<A-uuid>"] })`
- **THEN** the call MUST succeed
- **AND** subsequent calls to `chorus_get_task({ taskUuid: "<B-uuid>" })` MUST report a dependency edge from `B` to `A`
- **AND** the cycle-detection logic MUST be unchanged from the previous standalone tool's behavior (i.e. attempting to add a back-edge that would create a cycle MUST be rejected with the existing error)

#### Scenario: Calling the removed tool returns a standard MCP error

- **WHEN** an authenticated agent calls `tools/call` with `name: "chorus_add_task_dependency"` and any arguments
- **THEN** the server MUST return the standard MCP `Method not found` error path
- **AND** the server MUST NOT modify any task-dependency edges

### Requirement: The Chorus MCP server SHALL NOT expose `chorus_remove_task_dependency`

The MCP tool registration `chorus_remove_task_dependency` MUST be removed from the server. Its functionality is fully covered by `chorus_update_task` via the `removeDependsOn` parameter, which calls the same `taskService.removeTaskDependency`.

#### Scenario: Listing tools no longer surfaces `chorus_remove_task_dependency`

- **WHEN** an authenticated agent calls `tools/list` against `/api/mcp`
- **THEN** the response MUST NOT include any tool whose `name` field equals `chorus_remove_task_dependency`
- **AND** the response MUST still include `chorus_update_task` whose input schema continues to accept a `removeDependsOn` array of task UUIDs

#### Scenario: Removing a dependency works via the canonical tool

- **GIVEN** two open tasks `A` and `B` in the same project, with `B` currently depending on `A`
- **WHEN** the agent calls `chorus_update_task({ taskUuid: "<B-uuid>", removeDependsOn: ["<A-uuid>"] })`
- **THEN** the call MUST succeed
- **AND** subsequent calls to `chorus_get_task({ taskUuid: "<B-uuid>" })` MUST report no dependency edge from `B` to `A`

#### Scenario: Calling the removed tool returns a standard MCP error

- **WHEN** an authenticated agent calls `tools/call` with `name: "chorus_remove_task_dependency"` and any arguments
- **THEN** the server MUST return the standard MCP `Method not found` error path
- **AND** the server MUST NOT modify any task-dependency edges

### Requirement: First-party documentation surfaces SHALL contain no references to the removed tool names

After this change, the three deleted tool names MUST NOT appear in any first-party Chorus documentation surface. The constraint covers both prose references and example code blocks, and is enforced across the three skill surfaces and the internal MCP reference.

The first-party surfaces in scope are:

- `docs/MCP_TOOLS.md`
- `public/skill/**/SKILL.md`
- `public/chorus-plugin/skills/**/SKILL.md`
- `plugins/chorus/skills/**/SKILL.md`

The `openspec/changes/remove-redundant-mcp-tools/` folder is **explicitly out of scope** — it is the source of truth for what was removed and the migration recipe, and intentionally records the old names.

#### Scenario: A repository-wide grep for the removed tool names finds zero matches in scope surfaces

- **WHEN** a reviewer runs `grep -rn "chorus_pm_create_tasks\|chorus_add_task_dependency\|chorus_remove_task_dependency" docs/ public/skill/ public/chorus-plugin/ plugins/chorus/`
- **THEN** the grep MUST return zero matches
- **AND** the same grep limited to `src/` MUST also return zero matches

#### Scenario: Migration examples have replaced the removed names with canonical equivalents

- **GIVEN** the proposal-stage skill files (`public/skill/proposal-chorus/SKILL.md`, `public/chorus-plugin/skills/proposal/SKILL.md`, `plugins/chorus/skills/proposal/SKILL.md`)
- **WHEN** any of these files is read
- **THEN** every example that previously demonstrated batch task creation MUST use `chorus_create_tasks` (no `pm_` prefix)
- **AND** every example that previously demonstrated dependency add/remove MUST use `chorus_update_task` with `addDependsOn` / `removeDependsOn` array parameters

### Requirement: The plugin packages SHALL bump their version when shipping these removals

Both first-party plugin packages (Claude Code at `public/chorus-plugin/` and Codex at `plugins/chorus/`) MUST bump their version strings when this change ships, per the `plugin-maintenance` skill checklist. The version bump MUST be applied uniformly to every version-bearing file in each package; partial bumps are forbidden because they cause client/server version mismatch warnings.

#### Scenario: Every version-bearing file in the Claude Code plugin matches

- **WHEN** a reviewer reads `.claude-plugin/marketplace.json`, `public/chorus-plugin/.claude-plugin/plugin.json`, and every `public/chorus-plugin/skills/*/SKILL.md` `metadata.version` (or flat `version:` for `quick-dev/`)
- **THEN** all of these version strings MUST be equal to the same `X.Y.Z` value (the new 0.9.0-track plugin version)

#### Scenario: Every version-bearing file in the Codex plugin matches

- **WHEN** a reviewer reads `plugins/chorus/.codex-plugin/plugin.json`, every `plugins/chorus/skills/*/SKILL.md` `metadata.version`, and the hardcoded `clientInfo.version` string in `plugins/chorus/hooks/chorus-mcp-call.sh`
- **THEN** all of these version strings MUST be equal to the same `X.Y.Z` value
- **AND** that value MUST equal the Claude Code plugin's bumped version (the two plugins ship a shared version sequence)
