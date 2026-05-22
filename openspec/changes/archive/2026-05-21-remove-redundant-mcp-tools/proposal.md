## Why

Chorus currently exposes ~80 MCP tools to agents. Tool count directly hurts model tool-selection accuracy, especially when several tools cover the same semantic territory. As a first slice of a multi-part convergence effort tracked under parent idea `bc4af937` ("收敛 MCP 工具表面：80 → ~35"), this change deletes three tools that already have line-for-line equivalents in the public tool surface and contribute zero unique capability:

1. `chorus_pm_create_tasks` — already marked `[Deprecated]` in code; identical implementation to public `chorus_create_tasks`.
2. `chorus_add_task_dependency` — calls the same `taskService.addTaskDependency` that `chorus_update_task` already exposes via `addDependsOn`.
3. `chorus_remove_task_dependency` — same situation, mirrored to `removeDependsOn`.

The fourth originally-suspect tool (`chorus_search_mentionables`) is **explicitly out of scope**: it has no equivalent in `chorus_search` and is proxied by `packages/openclaw-plugin/src/tools/common-tools.ts`, so deleting it would break the downstream OpenClaw plugin. It will be revisited in a later "merge" sub-idea.

## What Changes

- **BREAKING**: Remove MCP tool registration for `chorus_pm_create_tasks`. Callers migrate to `chorus_create_tasks` (public tool, already available to all roles with `task:write`).
- **BREAKING**: Remove MCP tool registration for `chorus_add_task_dependency`. Callers migrate to `chorus_update_task({ taskUuid, addDependsOn: [...] })`.
- **BREAKING**: Remove MCP tool registration for `chorus_remove_task_dependency`. Callers migrate to `chorus_update_task({ taskUuid, removeDependsOn: [...] })`.
- Remove the three tools from `src/mcp/tools/permission-map.ts`.
- Remove the three tools from `docs/MCP_TOOLS.md`; rewrite the dependency-management examples to use `chorus_update_task`.
- Update three skill surfaces in lockstep (no version drift): `public/skill/`, `public/chorus-plugin/skills/`, `plugins/chorus/skills/`. Specifically the `proposal*/SKILL.md` and `chorus/SKILL.md` files in each surface.
- Bump both plugin packages (Claude Code + Codex) per `plugin-maintenance` checklist.

**Out of scope (split to other sub-ideas of the parent):**

- `chorus_search_mentionables` removal/merge.
- `get_X` / `get_Xs` collapse for idea/document/proposal/project/project_group.
- Session-tool table reduction.
- Draft-tool 6→1/2 collapse.
- Triple-action collapse for elaboration/admin_delete/project_group_admin.
- Task list-entry collapse (`get_available_*`, `get_unblocked_tasks`, `get_my_assignments`).

**Retire strategy (inherited from parent idea elaboration):** direct break in 0.9.0, no deprecation step.

## Capabilities

### New Capabilities

- `mcp-tool-surface`: Defines what MCP tools the Chorus server SHALL expose, and the rule that no tool may exist when an existing tool covers the same input space with the same downstream service call. This change introduces the capability with the three deletions as its initial requirements.

### Modified Capabilities

_(none — `mcp-tool-surface` is being introduced fresh; no existing capability spec changes.)_

## Impact

- **Breaking for**: Any agent or external tool that calls `chorus_pm_create_tasks`, `chorus_add_task_dependency`, or `chorus_remove_task_dependency` directly. Verified: the OpenClaw plugin (`packages/openclaw-plugin/`) does **not** proxy any of the three.
- **Code**: `src/mcp/tools/pm.ts` registrations + `src/mcp/tools/permission-map.ts` entries.
- **Docs**: `docs/MCP_TOOLS.md`.
- **Skills (3 surfaces, 6 files total)**:
  - `public/skill/proposal-chorus/SKILL.md`, `public/skill/chorus/SKILL.md`
  - `public/chorus-plugin/skills/proposal/SKILL.md`, `public/chorus-plugin/skills/chorus/SKILL.md`
  - `plugins/chorus/skills/proposal/SKILL.md`, `plugins/chorus/skills/chorus/SKILL.md`
- **Plugin versions**: Both Claude Code and Codex plugin manifests + `chorus-mcp-call.sh` `clientInfo.version`.
- **Release notes**: deferred — to be drafted jointly with the other 0.9.0 convergence sub-ideas at release time.
- **Backward compatibility**: 0.6.x compatibility note for `chorus_pm_create_tasks` is intentionally dropped; the deprecated description has been in place for ≥1 minor release and OpenClaw never adopted the pm-prefixed variant.
