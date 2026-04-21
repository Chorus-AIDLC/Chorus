---
name: plugin-maintenance
description: Guide for modifying the Chorus plugin, updating skill documentation, and releasing new plugin versions.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: development
---

# Chorus Plugin & Skill Maintenance

How to modify the Chorus plugin, update skill documentation, and release new versions.

## File Structure

```
.claude-plugin/
  marketplace.json              ← Marketplace registry (version here)

public/chorus-plugin/           ← The plugin package
  .claude-plugin/
    plugin.json                 ← Plugin metadata (version here)
  hooks.json                    ← Hook definitions (SubagentStart, etc.)
  bin/                          ← Hook scripts (bash)
  skills/chorus/
    SKILL.md                    ← Main skill file (execution rules, lifecycle)
    references/
      00-common-tools.md        ← Public MCP tools shared by all roles
      01-setup.md               ← MCP configuration guide
      02-pm-workflow.md          ← PM Agent complete workflow
      03-developer-workflow.md   ← Developer Agent complete workflow
      04-admin-workflow.md       ← Admin Agent complete workflow
      05-session-sub-agent.md    ← Session & observability guide
      06-claude-code-agent-teams.md ← Agent Teams integration

public/skill/                   ← Standalone skill (non-CC agents)
  SKILL.md                      ← Same structure, softer language
  references/                   ← Same files, IDE-agnostic wording
```

## When to Update What

| Change | Files to update |
|--------|----------------|
| New MCP tool added | `src/mcp/tools/*.ts` (implementation) + `docs/MCP_TOOLS.md` + plugin `00-common-tools.md` or `02-pm-workflow.md` + standalone equivalents |
| MCP tool description changed | `src/mcp/tools/*.ts` only (skill docs reference tool names, not descriptions) |
| New workflow step | Plugin `02-pm-workflow.md` (or 03/04) + standalone equivalent |
| New Idea/Task status | Plugin `SKILL.md` lifecycle diagram + standalone `SKILL.md` + `messages/en.json` + `messages/zh.json` |
| New execution rule | Plugin `SKILL.md` execution rules + standalone `SKILL.md` (softer wording) |
| Hook script change | `public/chorus-plugin/bin/*.sh` + `hooks.json` if new hook |
| Any plugin change | Bump version in BOTH files (see below) |

## Version Bump Checklist

Every time the plugin content changes, bump the version in **all** of these locations:

1. `public/chorus-plugin/.claude-plugin/plugin.json` — `"version": "X.Y.Z"`
2. `.claude-plugin/marketplace.json` — `"version": "X.Y.Z"`
3. Every plugin skill's YAML frontmatter `metadata.version` field — `public/chorus-plugin/skills/*/SKILL.md`
4. Every standalone skill's YAML frontmatter `metadata.version` field — `public/skill/*/SKILL.md` (only if the standalone skill was modified)

Items 1-3 must always match the same plugin version. Item 4 is independent — bump only the standalone skills that changed, using their own version sequence.

Quick way to check all versions:
```bash
grep -r 'version' public/chorus-plugin/.claude-plugin/plugin.json public/chorus-plugin/skills/*/SKILL.md public/skill/*/SKILL.md | grep -v '^--'
```

Users update via:
```bash
/plugin update chorus@chorus-plugins
```

## Plugin vs Standalone Skill: Tone Differences

The plugin skill targets Claude Code specifically. The standalone skill targets any MCP-compatible agent (Cursor, Kiro, etc.).

| Aspect | Plugin (`public/chorus-plugin/skills/`) | Standalone (`public/skill/`) |
|--------|----------------------------------------|------------------------------|
| AskUserQuestion | "ALWAYS use... NEVER display as text" | "prefer your IDE's interactive prompt if available" |
| Session management | "Do NOT create sessions — plugin handles it" | "Create or reopen a session before starting work" |
| Skip elaboration | "you MUST ask the user for permission first" | "confirm with the user first" |
| Hook references | References specific hooks (SubagentStart, etc.) | No hook references |

**Rule of thumb**: Plugin version uses MUST/NEVER/ALWAYS. Standalone version uses "prefer", "confirm", "consider".

## Adding a New MCP Tool — Full Checklist

1. Implement in `src/mcp/tools/*.ts` (pm.ts, public.ts, etc.)
2. Add to `docs/MCP_TOOLS.md`
3. If public tool: add to plugin `00-common-tools.md` + standalone `00-common-tools.md` + both `SKILL.md` shared tools tables
4. If PM tool: add to plugin `02-pm-workflow.md` tool list + standalone equivalent
5. If it changes the workflow: update the relevant workflow steps
6. Bump plugin version
7. Run `npx tsc --noEmit` to verify

## Modifying Hook Scripts

Hook scripts are in `public/chorus-plugin/bin/`:
- `on-session-start.sh` — SessionStart hook
- `on-user-prompt.sh` — UserPromptSubmit hook
- `on-subagent-start.sh` — SubagentStart hook
- `on-subagent-stop.sh` — SubagentStop hook
- `on-teammate-idle.sh` — TeammateIdle hook

**CRITICAL: All hook scripts MUST be compatible with Bash 3.2.** macOS ships with `/bin/bash` 3.2 (due to GPL licensing) and Claude Code uses it to execute hooks. Do NOT use Bash 4+ features:

| Bash 4+ (FORBIDDEN) | Bash 3.2 alternative |
|---------------------|---------------------|
| `${VAR,,}` (lowercase) | `$(printf '%s' "$VAR" \| tr '[:upper:]' '[:lower:]')` |
| `${VAR^^}` (uppercase) | `$(printf '%s' "$VAR" \| tr '[:lower:]' '[:upper:]')` |
| `declare -A` (associative arrays) | Use separate variables or `jq` |
| `readarray` / `mapfile` | `while IFS= read -r line` loop |
| `\|&` (pipe stderr) | `2>&1 \|` |
| `&>>` (append both) | `>> file 2>&1` |

After modifying:
1. Run `/bin/bash public/chorus-plugin/bin/test-syntax.sh` on macOS to verify Bash 3.2 compatibility
2. Test locally: `claude --plugin-dir public/chorus-plugin`
3. Bump plugin version
4. Users must restart CC and run `/plugin update` to get changes

## Testing Plugin Changes

```bash
# Load plugin locally (no install needed)
claude --plugin-dir public/chorus-plugin

# Or update installed plugin
/plugin update chorus@chorus-plugins

# Verify plugin loaded
/plugin list
```
