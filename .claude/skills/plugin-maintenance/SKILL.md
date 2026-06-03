---
name: plugin-maintenance
description: Guide for modifying the Chorus plugin (Claude Code + Codex + OpenClaw ports), updating skill documentation, and releasing new plugin versions.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.3.0"
  category: development
---

# Chorus Plugin & Skill Maintenance

How to modify the Chorus plugin, update skill documentation, and release new versions. **Three plugin packages** are maintained in parallel — Claude Code, Codex, and OpenClaw — plus the standalone skill surface. That is **four skill surfaces total**; when you change skill content, sweep all four (see [Skill Content Changes — Four Surfaces](#skill-content-changes--four-surfaces)).

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

packages/openclaw-plugin/       ← OpenClaw plugin package (TS runtime + skills)
  openclaw.plugin.json          ← Plugin manifest (id, skills dir, activation, configSchema) — NO version field
  package.json                  ← npm package (version here; `openclaw` block: extensions, runtimeExtensions, install/compat)
  src/                          ← TypeScript runtime (index.ts, mcp-client.ts, sse-listener.ts, event-router.ts, wake.ts)
                                  — real-time SSE event bridge + MCP registration; NOT bash hooks
  dist/                         ← Compiled JS (npm install loads this; linked install loads src/ via jiti)
  skills/
    chorus/SKILL.md             ← OpenClaw port — tools namespaced `chorus__<tool>`, inline OpenSpec detection
    develop/ idea/ proposal/ quick-dev/ review/ yolo/ brainstorm/ openspec-aware/SKILL.md
    proposal-reviewer/SKILL.md  ← Reviewers as skills (like Codex, no agents/)
    task-reviewer/SKILL.md

public/skill/                   ← Standalone skill (any MCP-compatible agent)
  chorus/SKILL.md               ← Same structure, softer language, IDE-agnostic
  proposal-chorus/SKILL.md
  quick-dev-chorus/SKILL.md
```

### Claude Code vs Codex vs OpenClaw plugin: key differences

| Aspect | `public/chorus-plugin/` (Claude Code) | `plugins/chorus/` (Codex) | `packages/openclaw-plugin/` (OpenClaw) |
|--------|---------------------------------------|---------------------------|----------------------------------------|
| Skill invocation | `/chorus:develop` etc. | `$develop`, `$yolo` (no namespace) | `/develop` etc. |
| Tool names | `chorus_<tool>` | `chorus_<tool>` | **`chorus__<tool>`** (double-underscore prefix from the MCP server registration) |
| MCP config | `.mcp.json` | `~/.codex/config.toml` with `[mcp_servers.chorus.http_headers]` | Plugin config (`chorusUrl` + `apiKey` via `configSchema`); the TS runtime registers MCP itself |
| Session lifecycle | Auto-managed via SubagentStart/Stop hooks | **Stateless** — main agent manages sessions manually | **Manual** — no SubagentStart hook; main agent manages sessions |
| Reviewers | `agents/*.md` + spawned via Task tool | Skills mounted into `agent_type="default"` via `spawn_agent` + `items` | `proposal-reviewer/` & `task-reviewer/` skills, spawned via `sessions_spawn` (read-only self-review fallback) |
| User interaction | `AskUserQuestion` (MUST use) | plain-text prompt | **plain-text prompt** — no `AskUserQuestion` primitive |
| OpenSpec detection | `CHORUS_OPENSPEC_ACTIVE` precomputed by SessionStart hook | precomputed by SessionStart hook | **inline** — run the §1 three-check detection yourself every time (no SessionStart hook) |
| "Hooks" | `bin/*.sh` (bash, stateful) | `hooks/*.sh` (bash, stateless) | **No bash hooks** — real-time behavior is a **TypeScript SSE runtime** in `src/` (`sse-listener.ts`, `event-router.ts`, `wake.ts`) |
| Task execution (yolo) | Wave-based Agent Teams (`TeamCreate`) | Sequential / `spawn_agent` | Sequential main-agent waves (no Agent Teams primitive) |

When porting a change between plugins, preserve these intentional differences. Don't add state files to the Codex/OpenClaw plugins, don't use `$`-prefix in Claude Code/OpenClaw docs, and in OpenClaw docs keep the `chorus__` tool-name note and the "sessions are manual / detection is inline / prompts are plain-text" phrasing.

## When to Update What

"All three plugin `chorus/SKILL.md`" = Claude Code + Codex + OpenClaw. "All four surfaces" additionally includes standalone `public/skill/`.

| Change | Files to update |
|--------|----------------|
| New MCP tool added | `src/mcp/tools/*.ts` (implementation) + `docs/MCP_TOOLS.md` + all three plugin `chorus/SKILL.md` files + standalone `public/skill/chorus/SKILL.md` |
| MCP tool description changed | `src/mcp/tools/*.ts` only (skill docs reference tool names, not descriptions) |
| Skill content / wording (e.g. AC now required) | The matching stage skill in **all four surfaces** (see [Skill Content Changes — Four Surfaces](#skill-content-changes--four-surfaces)) |
| New workflow step | All three plugin stage-specific `SKILL.md` (e.g. `develop/`, `proposal/`) + standalone equivalent |
| New Idea/Task status | All three plugin `chorus/SKILL.md` lifecycle diagrams + standalone `SKILL.md` + `messages/en.json` + `messages/zh.json` |
| New execution rule | All three plugin `chorus/SKILL.md` execution rules + standalone `SKILL.md` (softer wording) |
| Permission model change | All three plugin `chorus/SKILL.md` permission tables + `yolo/SKILL.md` prereq check + `quick-dev/SKILL.md` admin-verify check + role-based checks in Claude Code hook scripts (Codex hooks stateless; OpenClaw has no bash hooks) |
| Hook script change (Claude Code) | `public/chorus-plugin/bin/*.sh` + `hooks.json` if new hook. **Never copy hook changes blindly into `plugins/chorus/hooks/`** — Codex hooks are intentionally stateless and lack subagent events. OpenClaw has no bash hooks at all. |
| Hook script change (Codex) | `plugins/chorus/hooks/*.sh` — rarely needed; session-start, post-submit-proposal, post-submit-for-verify are the only three. If bumping plugin version, also update the hardcoded `clientInfo.version` in `chorus-mcp-call.sh`. |
| OpenClaw runtime change | `packages/openclaw-plugin/src/*.ts` (TS SSE/MCP runtime) + `npm run typecheck` + `npm run test`. Not bash hooks — this is a compiled TypeScript extension. |
| Any plugin change | Bump version in every file for that package (see Version Bump Checklist) |

## Version Bump Checklist

Every time **any** plugin package changes, bump the version in **all** of that package's locations. There are two version sequences in play:

- **Skill-frontmatter sequence** (currently `0.9.x`) — shared by the skill `SKILL.md` files across **all three** plugins. When the same skill content ships to multiple plugins, bump them together.
- **Per-package plugin sequences** — Claude Code + Codex share one (`marketplace.json` / both `plugin.json`, currently `0.9.x`); OpenClaw's `package.json` has its **own** sequence (currently `0.5.x`). These are independent files — edit each.

### Claude Code plugin — bump together
1. `.claude-plugin/marketplace.json` — `"version": "X.Y.Z"`
2. `public/chorus-plugin/.claude-plugin/plugin.json` — `"version": "X.Y.Z"`
3. Every skill under `public/chorus-plugin/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` (all skills, including `quick-dev/`, now use the standard nested `metadata:` block)

### Codex plugin — bump together
4. `plugins/chorus/.codex-plugin/plugin.json` — `"version": "X.Y.Z"`
5. Every skill under `plugins/chorus/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` (all skills, including `quick-dev/`, now use the standard nested `metadata:` block). **Don't forget the two reviewer skills**: `chorus-proposal-reviewer/SKILL.md` and `chorus-task-reviewer/SKILL.md`.
6. `plugins/chorus/hooks/chorus-mcp-call.sh` — hardcoded `clientInfo.version` string in the JSON-RPC `initialize` payload

### OpenClaw plugin — bump together
7. `packages/openclaw-plugin/package.json` — `"version": "X.Y.Z"` using OpenClaw's **own** sequence (`0.5.x`), NOT the skill sequence. `openclaw.plugin.json` has **no** version field — nothing to edit there.
8. Every skill under `packages/openclaw-plugin/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` on the **skill sequence** (`0.9.x`, matching the other plugins' skills). Includes the two reviewer skills `proposal-reviewer/SKILL.md` and `task-reviewer/SKILL.md`.
   - **Do NOT** touch `src/mcp-client.ts`'s `clientInfo.version` (`0.1.0`) — it is a static MCP client identifier, not the plugin version.

### Standalone skills — independent versioning
9. `public/skill/*/SKILL.md` — bump only the standalone skills that changed, using their own version sequence (`0.3.x`; do NOT sync to the plugin version)

Quick way to check all versions:
```bash
grep -rn '"version"\|^  version:\|^version:' \
  .claude-plugin/marketplace.json \
  public/chorus-plugin/.claude-plugin/plugin.json \
  public/chorus-plugin/skills/*/SKILL.md \
  plugins/chorus/.codex-plugin/plugin.json \
  plugins/chorus/skills/*/SKILL.md \
  plugins/chorus/hooks/chorus-mcp-call.sh \
  packages/openclaw-plugin/package.json \
  packages/openclaw-plugin/skills/*/SKILL.md \
  public/skill/*/SKILL.md
```

Users update via:
```bash
/plugin update chorus@chorus-plugins           # Claude Code
codex plugin update chorus@chorus-plugins      # Codex
# OpenClaw: reinstall/update via the OpenClaw plugin manager (npm spec @chorus-aidlc/chorus-openclaw-plugin)
```

## Skill Content Changes — Four Surfaces

Chorus skill content (workflow steps, tool guidance, wording like "AC is required") lives in **four parallel surfaces**. A content change must sweep all four — missing one ships inconsistent docs, and the Codex/OpenClaw `proposal` skill historically still carried a legacy example that a behavior change can silently break (e.g. the old `acceptanceCriteria` Markdown-string draft example, which now fails the required-AC enforcement and MUST become a structured `acceptanceCriteriaItems` array).

1. `public/chorus-plugin/skills/<skill>/SKILL.md` — Claude Code
2. `plugins/chorus/skills/<skill>/SKILL.md` — Codex
3. `packages/openclaw-plugin/skills/<skill>/SKILL.md` — OpenClaw
4. `public/skill/<skill>-chorus/SKILL.md` — standalone (note the `-chorus` suffix and flatter set)

**Sweep command** — find every occurrence before editing so nothing is missed:
```bash
grep -rniE "<your-search-term>" \
  public/chorus-plugin/skills/ plugins/chorus/skills/ \
  packages/openclaw-plugin/skills/ public/skill/
```

Then bump the relevant version sequences (skill frontmatter `0.9.x` across plugins 1–3; standalone `0.3.x` for #4; per-package plugin versions as needed).

## Porting Changes Between Plugins

Whenever you change content in one plugin, mirror it into the other two unless the difference is intentional (see the differences table above). Typical workflow:

1. Make the change in `public/chorus-plugin/skills/<skill>/SKILL.md`
2. Diff-check the counterparts:
   - `diff public/chorus-plugin/skills/<skill>/SKILL.md plugins/chorus/skills/<skill>/SKILL.md`
   - `diff public/chorus-plugin/skills/<skill>/SKILL.md packages/openclaw-plugin/skills/<skill>/SKILL.md`
3. Apply the same content change to the Codex and OpenClaw copies, but **preserve** their intentional phrasing:
   - **Codex**: `.mcp.json` → `~/.codex/config.toml`, `Task tool` → `spawn_agent`, `/chorus:X` → `$X`, "sessions auto-managed" → "sessions are optional / stateless port"
   - **OpenClaw**: tool names `chorus_<tool>` → `chorus__<tool>`, `AskUserQuestion` → plain-text prompt, reviewers via `sessions_spawn`, OpenSpec detection is inline (no SessionStart hook), sessions are manual
4. Bump all affected plugins' versions (all files in the Version Bump Checklist)
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
3. Update permission tables and tool lists in all four `chorus/SKILL.md`:
   - `public/chorus-plugin/skills/chorus/SKILL.md`
   - `plugins/chorus/skills/chorus/SKILL.md`
   - `packages/openclaw-plugin/skills/chorus/SKILL.md` (use the `chorus__<tool>` namespaced form)
   - `public/skill/chorus/SKILL.md`
4. If it changes a stage workflow, update the matching stage skill in all four locations (`develop/`, `idea/`, `proposal/`, `quick-dev/`, `review/`, `yolo/`)
5. Bump every affected plugin's versions (see Version Bump Checklist)
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

### OpenClaw plugin — TypeScript runtime, not bash hooks (`packages/openclaw-plugin/src/`)

OpenClaw has **no bash hooks at all**. Its real-time behavior is a compiled TypeScript extension declared in `package.json`'s `openclaw` block (`extensions: ["./src/index.ts"]`, `runtimeExtensions: ["./dist/index.js"]`):

- `index.ts` — entry point / activation (`activation.onStartup` in `openclaw.plugin.json`)
- `mcp-client.ts`, `mcp-registration.ts` — registers Chorus MCP tools (namespaced `chorus__<tool>`)
- `sse-listener.ts`, `event-router.ts`, `wake.ts` — SSE event stream → agent wake (the OpenClaw analogue of the other plugins' notification hooks)
- `config.ts`, `commands.ts` — config schema handling and slash commands

After modifying the runtime: `cd packages/openclaw-plugin && npm run typecheck && npm run test`. A **linked** install loads `src/` directly via jiti; an **npm** install requires the compiled `dist/` (`npm run build`). Bash 3.2 rules do **not** apply here (it's TypeScript, not shell). Two known runtime gotchas: a linked install loads TS via jiti (no `dist`) while an npm install needs compiled `dist` + `runtimeExtensions`; and SSE→agent wake requires `activation.onStartup` + `runEmbeddedAgent` with an explicit provider/model.

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
1. Run `/bin/bash public/chorus-plugin/bin/test-syntax.sh` on macOS to verify Bash 3.2 compatibility (Claude Code + Codex hooks only — OpenClaw has no bash hooks)
2. Test locally: `claude --plugin-dir public/chorus-plugin` (Claude Code) or install the plugin via `codex plugin install` and reload (Codex)
3. Bump plugin version for whichever packages changed (all affected packages)
4. Users must restart Claude Code / Codex and run the plugin update command

## Testing Plugin Changes

```bash
# Claude Code — load plugin locally (no install needed)
claude --plugin-dir public/chorus-plugin
# Or update installed plugin
/plugin update chorus@chorus-plugins
# Verify plugin loaded
/plugin list

# OpenClaw — typecheck + test the TypeScript runtime
cd packages/openclaw-plugin && npm run typecheck && npm run test
```
