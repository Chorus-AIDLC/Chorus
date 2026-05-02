---
name: plugin-maintenance
description: Guide for modifying the Chorus plugin (Claude Code + Codex ports), updating skill documentation, and releasing new plugin versions.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.2.0"
  category: development
---

# Chorus Plugin & Skill Maintenance

How to modify the Chorus plugin, update skill documentation, and release new versions. **Two plugin packages** are maintained in parallel — Claude Code and Codex — plus the standalone skill surface.

## File Structure

```
.claude-plugin/
  marketplace.json              ← Claude Code marketplace registry (version here)

public/chorus-plugin/           ← Claude Code plugin package
  .claude-plugin/
    plugin.json                 ← Plugin metadata (version here)
  hooks.json                    ← Hook definitions (SubagentStart, etc.)
  bin/                          ← Hook scripts (bash) — stateful via API state-get/set
  skills/
    chorus/SKILL.md             ← Core skill
    develop/ idea/ proposal/ quick-dev/ review/ yolo/SKILL.md
  agents/                       ← Reviewer agents as .md (Claude Code style)
    proposal-reviewer.md
    task-reviewer.md

plugins/chorus/                 ← Codex plugin package (separate from Claude Code)
  .codex-plugin/
    plugin.json                 ← Plugin metadata (version here)
  hooks.json
  hooks/                        ← Hook scripts (bash) — intentionally stateless
    on-session-start.sh
    on-post-submit-proposal.sh
    on-post-submit-for-verify.sh
    chorus-mcp-call.sh          ← MCP helper (has hardcoded clientInfo version)
    hook-output.sh
  skills/
    chorus/SKILL.md             ← Codex port — mentions $skill syntax, ~/.codex/config.toml
    develop/ idea/ proposal/ quick-dev/ review/ yolo/SKILL.md
    chorus-proposal-reviewer/SKILL.md  ← Reviewers as skills in Codex (no agents/)
    chorus-task-reviewer/SKILL.md

public/skill/                   ← Standalone skill (any MCP-compatible agent)
  chorus/SKILL.md               ← Same structure, softer language, IDE-agnostic
  proposal-chorus/SKILL.md
  quick-dev-chorus/SKILL.md
```

### Claude Code vs Codex plugin: key differences

| Aspect | `public/chorus-plugin/` (Claude Code) | `plugins/chorus/` (Codex) |
|--------|---------------------------------------|---------------------------|
| Skill invocation | `/chorus:develop` etc. | `$develop`, `$yolo` (no namespace) |
| MCP config | `.mcp.json` | `~/.codex/config.toml` with `[mcp_servers.chorus.http_headers]` |
| Session lifecycle | Auto-managed via SubagentStart/Stop hooks | **Stateless** — main agent manages sessions manually |
| Reviewers | `agents/*.md` + spawned via Task tool | Skills mounted into `agent_type="default"` via `spawn_agent` + `items` |
| Hook scripts | `bin/` — use `"$API" state-set` to persist data between hooks | `hooks/` — no persistence, each hook is self-contained |
| Role/permission state | `on-session-start.sh` caches `agent_permissions`, read by `on-subagent-stop.sh` | Not cached — Codex has no subagent events so there's nowhere to read it from |

When porting a Claude-Code change to Codex (or vice versa), preserve these intentional differences. Don't add state files to the Codex plugin and don't use `$`-prefix in Claude Code docs.

## When to Update What

| Change | Files to update |
|--------|----------------|
| New MCP tool added | `src/mcp/tools/*.ts` (implementation) + `docs/MCP_TOOLS.md` + both plugin `chorus/SKILL.md` files + standalone `public/skill/chorus/SKILL.md` |
| MCP tool description changed | `src/mcp/tools/*.ts` only (skill docs reference tool names, not descriptions) |
| New workflow step | Both plugin stage-specific `SKILL.md` (e.g. `develop/`, `proposal/`) + standalone equivalent |
| New Idea/Task status | Both plugin `chorus/SKILL.md` lifecycle diagrams + standalone `SKILL.md` + `messages/en.json` + `messages/zh.json` |
| New execution rule | Both plugin `chorus/SKILL.md` execution rules + standalone `SKILL.md` (softer wording) |
| Permission model change | Both plugin `chorus/SKILL.md` permission tables + `yolo/SKILL.md` prereq check + `quick-dev/SKILL.md` admin-verify check + all role-based checks in hook scripts (only Claude Code hooks need edits — Codex hooks are stateless) |
| Hook script change (Claude Code) | `public/chorus-plugin/bin/*.sh` + `hooks.json` if new hook. **Never copy hook changes blindly into `plugins/chorus/hooks/`** — Codex hooks are intentionally stateless and lack subagent events. |
| Hook script change (Codex) | `plugins/chorus/hooks/*.sh` — rarely needed; session-start, post-submit-proposal, post-submit-for-verify are the only three. If bumping plugin version, also update the hardcoded `clientInfo.version` in `chorus-mcp-call.sh`. |
| Any plugin change | Bump version in every file below |

## Version Bump Checklist

Every time **either** plugin package changes, bump the version in **all** of that package's locations. The Claude Code plugin and the Codex plugin share a version sequence (both bump together when they ship the same feature), but they're independent files — you must edit each one.

### Claude Code plugin — bump together
1. `.claude-plugin/marketplace.json` — `"version": "X.Y.Z"`
2. `public/chorus-plugin/.claude-plugin/plugin.json` — `"version": "X.Y.Z"`
3. Every skill under `public/chorus-plugin/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` (or `version: X.Y.Z` for `quick-dev/` which uses a flat frontmatter)

### Codex plugin — bump together
4. `plugins/chorus/.codex-plugin/plugin.json` — `"version": "X.Y.Z"`
5. Every skill under `plugins/chorus/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` (or flat `version:` for `quick-dev/`). **Don't forget the two reviewer skills**: `chorus-proposal-reviewer/SKILL.md` and `chorus-task-reviewer/SKILL.md`.
6. `plugins/chorus/hooks/chorus-mcp-call.sh` — hardcoded `clientInfo.version` string in the JSON-RPC `initialize` payload

### Standalone skills — independent versioning
7. `public/skill/*/SKILL.md` — bump only the standalone skills that changed, using their own version sequence (do NOT sync to the plugin version)

Quick way to check all versions:
```bash
grep -rn '"version"\|^  version:\|^version:' \
  .claude-plugin/marketplace.json \
  public/chorus-plugin/.claude-plugin/plugin.json \
  public/chorus-plugin/skills/*/SKILL.md \
  plugins/chorus/.codex-plugin/plugin.json \
  plugins/chorus/skills/*/SKILL.md \
  plugins/chorus/hooks/chorus-mcp-call.sh \
  public/skill/*/SKILL.md
```

Users update via:
```bash
/plugin update chorus@chorus-plugins           # Claude Code
codex plugin update chorus@chorus-plugins      # Codex
```

## Porting Changes Between Plugins

Whenever you change content in one plugin, mirror it into the other unless the difference is intentional (see the table above). Typical workflow:

1. Make the change in `public/chorus-plugin/skills/<skill>/SKILL.md`
2. Diff-check the counterpart: `diff public/chorus-plugin/skills/<skill>/SKILL.md plugins/chorus/skills/<skill>/SKILL.md`
3. Apply the same content change to `plugins/chorus/skills/<skill>/SKILL.md`, but **preserve** Codex-specific phrasing: `.mcp.json` → `~/.codex/config.toml`, `Task tool` → `spawn_agent`, `/chorus:X` → `$X`, "sessions auto-managed" → "sessions are optional / stateless port"
4. Bump both plugins' versions (all files above)
5. For the Codex plugin, also verify `chorus-mcp-call.sh` `clientInfo.version` matches

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
3. Update permission tables and tool lists in:
   - `public/chorus-plugin/skills/chorus/SKILL.md`
   - `plugins/chorus/skills/chorus/SKILL.md`
   - `public/skill/chorus/SKILL.md`
4. If it changes a stage workflow, update the matching stage skill in all three locations (`develop/`, `idea/`, `proposal/`, `quick-dev/`, `review/`, `yolo/`)
5. Bump both plugins' versions (see Version Bump Checklist)
6. Run `npx tsc --noEmit` to verify

## Modifying Hook Scripts

### Claude Code plugin hooks (`public/chorus-plugin/bin/`)
- `on-session-start.sh` — SessionStart hook (caches `agent_permissions` via `"$API" state-set`)
- `on-user-prompt.sh` — UserPromptSubmit hook
- `on-subagent-start.sh` — SubagentStart hook
- `on-subagent-stop.sh` — SubagentStop hook (reads `agent_permissions` via `state-get`)
- `on-teammate-idle.sh` — TeammateIdle hook
- `on-pre-enter-plan.sh`, `on-pre-exit-plan.sh` — Plan mode hooks
- `on-task-completed.sh` — TaskCompleted hook
- `on-post-submit-proposal.sh`, `on-post-submit-for-verify.sh` — PostToolUse reviewer reminders

### Codex plugin hooks (`plugins/chorus/hooks/`)
- `on-session-start.sh` — SessionStart hook (stateless; no caching)
- `on-post-submit-proposal.sh` — PostToolUse for `chorus_pm_submit_proposal`
- `on-post-submit-for-verify.sh` — PostToolUse for `chorus_submit_for_verify`
- `chorus-mcp-call.sh` — shared MCP-over-HTTP helper (bump `clientInfo.version` on release)
- `hook-output.sh` — stdout-formatting helper

**Codex has no SubagentStart/Stop events** — do not try to port lifecycle hooks from the Claude Code plugin. Instead, session management is documented as a main-agent responsibility in `plugins/chorus/skills/develop/SKILL.md` and `$yolo`.

**CRITICAL: All hook scripts MUST be compatible with Bash 3.2.** macOS ships with `/bin/bash` 3.2 (due to GPL licensing) and Claude Code + Codex both use it to execute hooks. Do NOT use Bash 4+ features:

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
2. Test locally: `claude --plugin-dir public/chorus-plugin` (Claude Code) or install the plugin via `codex plugin install` and reload (Codex)
3. Bump plugin version for whichever packages changed (both packages if the change applies to both)
4. Users must restart Claude Code / Codex and run the plugin update command

## Testing Plugin Changes

```bash
# Load plugin locally (no install needed)
claude --plugin-dir public/chorus-plugin

# Or update installed plugin
/plugin update chorus@chorus-plugins

# Verify plugin loaded
/plugin list
```
