# Technical Design: Remove Redundant MCP Tools (0.9.0 Slice 1/N)

## Overview

Three MCP tools register `tools/list` entries that are pure aliases of other tools already on the wire. Removing them is a registration-only change: no service-layer code is touched, no schema changes, no permission semantics change. The agent-facing migration is a one-line API substitution per call site.

## Audited equivalence

| Tool | Registered at | Service called | 1:1 with |
|------|---------------|----------------|----------|
| `chorus_pm_create_tasks` | `src/mcp/tools/pm.ts:296-421` (already `[Deprecated]` in description, line 304) | `taskService.createTask` + `taskService.addTaskDependency` + `prisma.acceptanceCriterion.createMany` | `chorus_create_tasks` at `src/mcp/tools/public.ts:765-903` — line-for-line identical service calls |
| `chorus_add_task_dependency` | `src/mcp/tools/pm.ts:690-716` | `taskService.addTaskDependency(companyUuid, taskUuid, dependsOnTaskUuid)` | `chorus_update_task` (`src/mcp/tools/public.ts:906-1060`) `addDependsOn` branch (line 1006-1014) — same service call, same cycle detection at `src/services/task.service.ts:1036-1041` |
| `chorus_remove_task_dependency` | `src/mcp/tools/pm.ts:718-744` | `taskService.removeTaskDependency(companyUuid, taskUuid, dependsOnTaskUuid)` | `chorus_update_task` `removeDependsOn` branch (`src/mcp/tools/public.ts:1016-1025`) |

Equivalence was verified by code reading (not just description matching). For `chorus_update_task`, both `addDependsOn` and `removeDependsOn` accept arrays of task UUIDs, so a single call can replace what previously required N separate `add_task_dependency` calls — strictly an enhancement on the migration path, not a regression.

## Architecture

No architecture change. The change is purely descriptive: it removes the three `server.registerTool(...)` blocks in `pm.ts` and removes their entries from `permission-map.ts`. After this change:

- `chorus_create_tasks`, `chorus_update_task` continue to behave exactly as today.
- `tools/list` returns three fewer tools.
- `tools/call` for any of the three deleted names returns `Method not found` (standard MCP error path).

## Data Model

No schema changes. No migrations. Prisma client is not affected.

## API Design

No REST API changes. The MCP-only surface is what's contracting.

### Migration table (becomes the `MCP Tool Removal Plan` document)

| Old (deleted) | New (canonical) | Notes |
|---|---|---|
| `chorus_pm_create_tasks({ projectUuid, proposalUuid?, tasks: [...] })` | `chorus_create_tasks({ projectUuid, proposalUuid?, tasks: [...] })` | Identical input schema; permission requirement loosens from `proposal:write` to `task:write` (the public tool's gate). |
| `chorus_add_task_dependency({ taskUuid, dependsOnTaskUuid })` | `chorus_update_task({ taskUuid, addDependsOn: [dependsOnTaskUuid] })` | Wrap a single dependency in a one-element array. Multiple dependencies become one call, not N. |
| `chorus_remove_task_dependency({ taskUuid, dependsOnTaskUuid })` | `chorus_update_task({ taskUuid, removeDependsOn: [dependsOnTaskUuid] })` | Same shape. |

## Module Contracts

This change introduces no cross-module contracts. The constraint is: skill docs must be kept in sync across `public/skill/`, `public/chorus-plugin/skills/`, and `plugins/chorus/skills/` — every reference updated in one MUST be updated in the other two with byte-identical migration examples (modulo the Claude Code vs. Codex tonal differences documented in `plugin-maintenance` skill, which do not affect MCP example bodies).

## Implementation Plan

The work decomposes into modules along the deletion-target × surface axis. To keep PRs reviewable, group by surface (code vs. docs vs. skills) rather than by deleted tool, because all three deletions touch the same files.

1. **Code surface** — Remove 3 registrations in `pm.ts` and 3 entries in `permission-map.ts`. Run `npx tsc --noEmit` and `pnpm lint` to confirm no dangling references. Hand-search for the three tool name strings in `src/` to catch any residue.
2. **Internal docs** — Update `docs/MCP_TOOLS.md`: drop the three sections, fold the dependency-management examples into the `chorus_update_task` section.
3. **Skill docs ×3 surfaces** — Update `proposal*/SKILL.md` and `chorus/SKILL.md` in all three skill surfaces with identical example substitutions. The proposal-skill rewrite swaps a `chorus_pm_create_tasks(...)` example for `chorus_create_tasks(...)` and the dependency examples for `chorus_update_task({ ..., addDependsOn: [...] })`.
4. **MCP Tool Removal Plan document** — Author a single PRD-typed document that becomes the reusable template for the rest of the parent idea's sub-ideas. It carries the migration table above plus a "how to verify equivalence" checklist (search for tool name string in: openclaw-plugin proxies, all skill surfaces, internal docs, frontend hooks).
5. **Plugin version bumps** — Per `plugin-maintenance` checklist: bump `marketplace.json`, both `plugin.json` files, every `SKILL.md` `metadata.version`, and `chorus-mcp-call.sh` hardcoded `clientInfo.version`. Both Claude Code and Codex plugin packages bump together.
6. **Integration check** — Manual smoke: run `chorus_create_tasks` and `chorus_update_task` with a `addDependsOn`/`removeDependsOn` cycle in a dev project, confirm the dependency edges show up in the DAG view. Then attempt to call `chorus_pm_create_tasks` and confirm `Method not found`. This is the integration checkpoint task.

## Risks & Mitigations

- **Risk**: An external agent in production has the deleted tool name baked into a system prompt. **Mitigation**: 0.9.0 is a minor release with breaking-change notes; the migration is mechanical (1:1 substitution); the tool was already deprecated in code description. No prod telemetry on tool-call frequency exists, so we accept this risk as inherent to the parent idea's "direct break" decision.
- **Risk**: A skill doc in a private fork still references the old name. **Mitigation**: out of scope — only the three first-party surfaces are kept in sync.
- **Risk**: Forgetting to bump `chorus-mcp-call.sh` `clientInfo.version` results in stale plugin telemetry. **Mitigation**: include the file explicitly in the plugin-version-bump task AC.
- **Risk**: Removing a tool changes `tools/list` length, which can churn cached prompts. **Mitigation**: documented in the migration plan; release notes (drafted later for 0.9.0 collectively) call out the count delta.

## Verification

- Type check: `npx tsc --noEmit` passes after deletions.
- Lint: `pnpm lint` passes.
- Test: existing test suite stays green; no new tests required because no service layer changed (the deleted MCP entries are pure registration glue with no unique code path).
- Manual: `chorus_create_tasks` and `chorus_update_task addDependsOn/removeDependsOn` confirmed working end-to-end in a dev project.
- Cross-surface text search: `grep -rn "chorus_pm_create_tasks\|chorus_add_task_dependency\|chorus_remove_task_dependency" src/ docs/ public/skill/ public/chorus-plugin/ plugins/chorus/` returns zero results after the change (excluding `openspec/changes/remove-redundant-mcp-tools/` itself, which intentionally records the old names in its proposal/spec/migration template).
