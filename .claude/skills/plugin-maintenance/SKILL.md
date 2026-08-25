---
name: plugin-maintenance
description: Guide for modifying the Chorus plugin (Claude Code, Codex, OpenClaw, Kiro, Pi, and dsh ports), updating skill documentation, and releasing new plugin versions.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.5.0"
  category: development
---

# Chorus Plugin & Skill Maintenance

How to modify the Chorus plugin, update skill documentation, and release new versions. **Six plugin packages** are maintained in parallel — Claude Code, Codex, OpenClaw, Kiro, Pi, and dsh (DeepSeek Harness) — plus the standalone skill surface. That is **seven skill surfaces total**; when you change skill content, sweep all seven (see [Skill Content Changes — Seven Surfaces](#skill-content-changes--seven-surfaces)).

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

public/kiro-plugin/             ← Kiro CLI plugin (loose .kiro/ template tree + install script)
  .kiro/
    settings/mcp.json           ← Chorus remote MCP server (${env:CHORUS_API_KEY} bearer, disabled:false)
    skills/chorus-*/SKILL.md    ← the chorus-PREFIXED skills (no bare names — global-install distinctiveness)
    agents/chorus.json          ← main agent (.json — Kiro CLI, NOT .md); hosts all hooks via __CHORUS_BIN__ placeholder
    agents/chorus.md            ← main-agent system-prompt sidecar (file://./chorus.md)
    agents/chorus-*-reviewer.json  ← 3 read-only reviewer subagents (tools:["read","@chorus"])
    steering/chorus.md          ← platform overview + AI-DLC context (folds in the `chorus` overview skill)
  bin/                          ← Hook scripts (bash, 3.2-safe) + chorus-api.sh + test-syntax.sh
                                  installer copies these into <KIRO_DIR>/chorus-bin/ and resolves __CHORUS_BIN__
(public/install-kiro.sh)        ← deprecation stub → redirects to `chorus agents add`; the .kiro/ tree is installed by cli/init/file-template.mjs (asset list: public/kiro-plugin/manifest.txt)

packages/chorus-pi/             ← Pi coding agent package (TS extension + skills)
  package.json                  ← npm package + Pi manifest (version here)
  extensions/chorus.ts          ← Native Pi event handlers; auto checkin/session lifecycle/reviewer nudges
  lib/lib.ts                    ← Pure helpers used by the extension and unit tests
  bin/chorus-mcp-call.sh        ← MCP helper for byte-exact OpenSpec document mirroring
  skills/
    chorus/SKILL.md             ← Core skill; Pi `/skill:<name>` syntax
    develop/ idea/ proposal/ quick-dev/ review/ yolo/ openspec-aware/SKILL.md
  agents/                       ← 3 read-only reviewer agents copied to ~/.pi/agent/agents/
  test/                         ← Static, helper-unit, extension-event, and manual-session verification

packages/chorus-dsh/            ← DeepSeek Harness (dsh) plugin — published npm bundle @chorus-aidlc/chorus-dsh
  package.json                  ← npm package + dsh bundle patch (version here; tracks the APP version, e.g. 0.16.3)
  src/index.ts                  ← Cordis plugin apply(): injects skills/persona/MCP wrapper; daemon-backend gate
  cordis.patch.yml              ← dsh composition patch shipped in the bundle
  bin/chorus-mcp-call.mjs       ← Node MCP-over-HTTP helper (clientInfo.version auto-read from package.json — no manual bump)
  skills/
    chorus/SKILL.md             ← Core overview (dsh HAS a chorus/ overview, unlike Kiro)
    <stage>-chorus/SKILL.md     ← 13 stage/reviewer skills, `-chorus` SUFFIX (brainstorm/develop/idea/
                                  proposal/quick-dev/review/yolo/docs/orchestrate/openspec-aware/
                                  code-reviewer/proposal-reviewer/task-reviewer)

public/skill/                   ← Standalone skill (any MCP-compatible agent)
  chorus/SKILL.md               ← Same structure, softer language, IDE-agnostic
  proposal-chorus/SKILL.md
  quick-dev-chorus/SKILL.md
```

### Plugin key differences

| Aspect | Claude Code | Codex | OpenClaw | Kiro CLI | Pi |
|--------|-------------|-------|----------|----------|----|
| Skill invocation | `/chorus:develop` | `$develop` | `/develop` | `/chorus-develop` | `/skill:develop` |
| Tool names | `chorus_<tool>` | `chorus_<tool>` | `chorus__<tool>` | `chorus_<tool>` / `@chorus` matcher | MCP gateway may expose `chorus_chorus_<tool>`; extension uses native `chorus_<tool>` |
| MCP config | `.mcp.json` | `~/.codex/config.toml` | Plugin config | `~/.kiro/settings/mcp.json` | `.mcp.json` or `~/.pi/agent/mcp.json` via `pi-mcp-adapter` |
| Session lifecycle | SubagentStart/Stop hooks | Manual/stateless | Manual | `agentSpawn`/`stop` hooks | Automatic via mutable `subagent_spawn` and `subagent_manage` events |
| Reviewers | `agents/*.md` via Task | Skills mounted in `spawn_agent` | Reviewer skills via `sessions_spawn` | Native JSON subagents | `agents/chorus-*-reviewer.md` via `pi-subagents` |
| User interaction | `AskUserQuestion` | Plain text | Plain text | Plain text | Plain text |
| OpenSpec detection | SessionStart hook | SessionStart hook | Inline | `agentSpawn` hook | `session_start` extension event |
| Runtime/hooks | Stateful bash hooks | Stateless bash hooks | TypeScript SSE runtime | Bash 3.2 hooks in `chorus.json` | TypeScript native extension; shell only for OpenSpec mirroring |
| Task execution | Agent Teams waves | `spawn_agent` | Main-agent waves | Kiro subagents | `subagent_spawn` workers |
| Install | Marketplace | `install-codex.sh` | OpenClaw plugin manager | `install-kiro.sh` | GitHub checkout + `pi install <checkout>/packages/chorus-pi` |

When porting a change between plugins, preserve these intentional differences. Don't add state files to the Codex/OpenClaw plugins, don't use `$`-prefix outside Codex, keep OpenClaw's `chorus__` names and manual-session/inline-detection wording, and preserve Kiro's `chorus-` skill prefix, `@chorus/<tool>` matchers, and `__CHORUS_BIN__` placeholder. For Pi, use `/skill:<name>`, `subagent_spawn`, native extension events, and plain-text interaction; do not introduce Claude hooks or Codex session wording.

**dsh (DeepSeek Harness)** is a published npm bundle (`@chorus-aidlc/chorus-dsh`) added to a dsh profile via `dsh plugin --profile <name> add -w`. It is Cordis-based: `src/index.ts`'s `apply()` injects the `-chorus`-suffixed skills, persona, and a Node MCP wrapper. Skills use the `-chorus` **suffix** (like standalone) but it keeps a `chorus/SKILL.md` overview. Its version tracks the **app version** (0.16.3+), NOT the 0.9.x skill sequence. The dsh **daemon backend** (`cli/dsh-spawner.mjs` / `dsh-managed-config.mjs`) is currently **de-listed / offline** — kept dormant, not advertised; do NOT re-add it to the daemon install menu, CLI `--agent` help, or `DAEMON.md` / `MCP_TOOLS.md` without bringing the backend back online.

## When to Update What

"All six plugin skills" = Claude Code + Codex + OpenClaw + Kiro + Pi + dsh. "All seven surfaces" additionally includes standalone `public/skill/`. Note the Kiro surface has **no `chorus/SKILL.md`** — its overview lives in `steering/chorus.md`, and its stage skills are `chorus-`prefixed; dsh keeps a `chorus/SKILL.md` overview and uses `-chorus`-**suffixed** stage skills.

| Change | Files to update |
|--------|----------------|
| New MCP tool added | `src/mcp/tools/*.ts` + `docs/MCP_TOOLS.md` + all six plugin overviews (Kiro: `steering/chorus.md`) + standalone overview |
| MCP tool description changed | `src/mcp/tools/*.ts` only (skill docs reference tool names, not descriptions) |
| Skill content / wording (e.g. AC now required) | The matching stage skill in **all seven surfaces** |
| New workflow step | All six plugin stage skills + standalone equivalent |
| New Idea/Task status | All six plugin overviews + standalone overview + locale messages |
| New execution rule | All six plugin overviews + standalone overview (softer wording) |
| Permission model change | All six plugin overviews + affected stage skills + runtime checks where applicable |
| Hook script change (Claude Code) | `public/chorus-plugin/bin/*.sh` + `hooks.json` if new hook. **Never copy hook changes blindly into `plugins/chorus/hooks/`** — Codex hooks are intentionally stateless and lack subagent events. OpenClaw has no bash hooks at all. |
| Hook script change (Codex) | `plugins/chorus/hooks/*.sh` — rarely needed; session-start, post-submit-proposal, post-submit-for-verify are the only three. If bumping plugin version, also update the hardcoded `clientInfo.version` in `chorus-mcp-call.sh`. |
| OpenClaw runtime change | `packages/openclaw-plugin/src/*.ts` (TS SSE/MCP runtime) + `npm run typecheck` + `npm run test`. Not bash hooks — this is a compiled TypeScript extension. |
| Pi runtime change | `packages/chorus-pi/extensions/*.ts` + `lib/*.ts`; run `bash test/all.sh` from the package directory |
| Any plugin change | Bump version in every file for that package (see Version Bump Checklist) |

## Version Bump Checklist

Every time **any** plugin package changes, bump the version in **all** of that package's locations. There are two version sequences in play:

- **Skill-frontmatter sequence** — shared by corresponding `SKILL.md` files across the six plugin ports. When the same skill content ships to multiple plugins, bump them together.
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

### Kiro plugin — bump together
Kiro has **no plugin.json / marketplace registry** (it reads loose `.kiro/` files), so the only versioned files are the skill frontmatters.
10. Every skill under `public/kiro-plugin/.kiro/skills/chorus-*/SKILL.md` — `metadata.version: "X.Y.Z"` on the shared skill sequence (all `chorus-*` skills). The `agents/*.json` and `steering/chorus.md` carry **no** version field — nothing to edit there.
11. `public/kiro-plugin/bin/chorus-api.sh` — hardcoded `clientInfo.version` string in the JSON-RPC `initialize` payload (same as the Codex `chorus-mcp-call.sh` helper).

### Pi package — bump together
12. `packages/chorus-pi/package.json` — `"version": "X.Y.Z"`.
13. Every skill under `packages/chorus-pi/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"`, including `openspec-aware`.
14. `packages/chorus-pi/extensions/chorus.ts` — hardcoded MCP `clientInfo.version`.

### dsh (DeepSeek Harness) plugin — bump together
dsh tracks the **app version** (currently `0.16.3`), NOT the 0.9.x skill sequence.
16. `packages/chorus-dsh/package.json` — `"version": "X.Y.Z"` (the published `@chorus-aidlc/chorus-dsh` bundle).
17. Every skill under `packages/chorus-dsh/skills/*/SKILL.md` — `metadata.version: "X.Y.Z"` (the `chorus/` overview + all `-chorus`-suffixed stage/reviewer skills).
   - **Do NOT** hardcode a version in `bin/chorus-mcp-call.mjs` — its `clientInfo.version` is auto-read from `package.json`, so it never drifts.

### Standalone skills — independent versioning
15. `public/skill/*/SKILL.md` — bump only the standalone skills that changed, using their own version sequence.

Quick way to check all versions:
```bash
grep -rn '"version"\|^  version:\|^version:\|clientInfo' \
  .claude-plugin/marketplace.json \
  public/chorus-plugin/.claude-plugin/plugin.json \
  public/chorus-plugin/skills/*/SKILL.md \
  plugins/chorus/.codex-plugin/plugin.json \
  plugins/chorus/skills/*/SKILL.md \
  plugins/chorus/hooks/chorus-mcp-call.sh \
  packages/openclaw-plugin/package.json \
  packages/openclaw-plugin/skills/*/SKILL.md \
  public/kiro-plugin/.kiro/skills/*/SKILL.md \
  public/kiro-plugin/bin/chorus-api.sh \
  packages/chorus-pi/package.json \
  packages/chorus-pi/skills/*/SKILL.md \
  packages/chorus-pi/extensions/chorus.ts \
  packages/chorus-dsh/package.json \
  packages/chorus-dsh/skills/*/SKILL.md \
  public/skill/*/SKILL.md
```

Users update via:
```bash
/plugin update chorus@chorus-plugins           # Claude Code
codex plugin update chorus@chorus-plugins      # Codex
# OpenClaw: reinstall/update via the OpenClaw plugin manager (npm spec @chorus-aidlc/chorus-openclaw-plugin)
# Kiro: re-run `chorus agents add --agents kiro` (idempotent; installs the .kiro/ tree via the file-template installer)
# Pi: pull the Chorus checkout, then reinstall its packages/chorus-pi local path
```

Pi accepts GitHub sources such as `pi install git:github.com/user/repo@ref`, but it does not support selecting a package subdirectory. Do not point it at the Chorus monorepo root: Pi would inspect the root `package.json`, not `packages/chorus-pi/package.json`. Until Pi is published from a dedicated package-root repository or branch, clone/pull Chorus and install the package by local path.

## Skill Content Changes — Seven Surfaces

Chorus skill content lives in **seven parallel surfaces**. A content change must sweep all seven:

1. `public/chorus-plugin/skills/<skill>/SKILL.md` — Claude Code
2. `plugins/chorus/skills/<skill>/SKILL.md` — Codex
3. `packages/openclaw-plugin/skills/<skill>/SKILL.md` — OpenClaw
4. `public/kiro-plugin/.kiro/skills/chorus-<skill>/SKILL.md` — Kiro (note the `chorus-` **prefix**; the overview lives in `steering/chorus.md`, not a `chorus/SKILL.md`)
5. `packages/chorus-pi/skills/<skill>/SKILL.md` — Pi
6. `packages/chorus-dsh/skills/<skill>-chorus/SKILL.md` — dsh (note the `-chorus` **suffix**; keeps a `chorus/SKILL.md` overview)
7. `public/skill/<skill>-chorus/SKILL.md` — standalone (note the `-chorus` suffix and flatter set)

**Sweep command** — find every occurrence before editing so nothing is missed:
```bash
grep -rniE "<your-search-term>" \
  public/chorus-plugin/skills/ plugins/chorus/skills/ \
  packages/openclaw-plugin/skills/ public/kiro-plugin/.kiro/skills/ \
  packages/chorus-pi/skills/ packages/chorus-dsh/skills/ public/skill/
```

Then bump the relevant version sequences (shared skill frontmatter across plugin surfaces 1–5, independent standalone version for #6, and per-package versions as needed).

## Porting Changes Between Plugins

Whenever you change content in one plugin, mirror it into the other plugin surfaces unless the difference is intentional. Typical workflow:

1. Make the change in `public/chorus-plugin/skills/<skill>/SKILL.md`
2. Diff-check the counterparts:
   - `diff public/chorus-plugin/skills/<skill>/SKILL.md plugins/chorus/skills/<skill>/SKILL.md`
   - `diff public/chorus-plugin/skills/<skill>/SKILL.md packages/openclaw-plugin/skills/<skill>/SKILL.md`
   - `diff public/chorus-plugin/skills/<skill>/SKILL.md packages/chorus-pi/skills/<skill>/SKILL.md`
3. Apply the same semantic change to every port, but **preserve** intentional phrasing:
   - **Codex**: `.mcp.json` → `~/.codex/config.toml`, `Task tool` → `spawn_agent`, `/chorus:X` → `$X`, "sessions auto-managed" → "sessions are optional / stateless port"
   - **OpenClaw**: tool names `chorus_<tool>` → `chorus__<tool>`, `AskUserQuestion` → plain-text prompt, reviewers via `sessions_spawn`, OpenSpec detection is inline (no SessionStart hook), sessions are manual
   - **Kiro**: `chorus-` skill prefix, native JSON subagents, `@chorus` tools, and hook-driven context
   - **Pi**: `/skill:X`, `subagent_spawn`, plain-text prompts, reviewer `.md` agents, extension-managed worker sessions
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
3. Update permission tables and tool lists in all seven overview surfaces:
   - `public/chorus-plugin/skills/chorus/SKILL.md`
   - `plugins/chorus/skills/chorus/SKILL.md`
   - `packages/openclaw-plugin/skills/chorus/SKILL.md` (use the `chorus__<tool>` namespaced form)
   - `public/kiro-plugin/.kiro/steering/chorus.md` (Kiro has no `chorus/SKILL.md` — the overview is the steering doc)
   - `packages/chorus-pi/skills/chorus/SKILL.md`
   - `packages/chorus-dsh/skills/chorus/SKILL.md`
   - `public/skill/chorus/SKILL.md`
4. If it changes a stage workflow, update the matching stage skill in all seven locations.
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

### Kiro plugin hooks (`public/kiro-plugin/bin/`)

Kiro hooks are bash (Bash-3.2 rules apply) but declared **inside `agents/chorus.json`** (Kiro has no standalone `hooks.json`), and each hook's STDOUT is added to the agent context as **plain text** (there is no `additionalContext` JSON envelope like Claude Code). Scripts:

- `on-agent-spawn.sh` — `agentSpawn` hook: `chorus_checkin` → startup context (owner/permissions/idea-tracker). "Not configured" if Chorus env is unset; never aborts the spawn.
- `on-stop.sh` — `stop` hook: best-effort session heartbeat/checkout; never blocks the turn.
- `on-post-submit-proposal.sh` / `on-post-submit-for-verify.sh` / `on-post-verify-task.sh` — `postToolUse` hooks matched to `@chorus/chorus_pm_submit_proposal` / `@chorus/chorus_submit_for_verify` / `@chorus/chorus_admin_verify_task`; emit a nudge to spawn the matching reviewer subagent. Exit 0 with no output if no parseable UUID.
- `chorus-api.sh` — the reused MCP-over-HTTP wrapper (bump the hardcoded `clientInfo.version` on release, like Codex's `chorus-mcp-call.sh`). Hook scripts reference it via a path relative to their own location, never a hard-coded repo path.
- `test-syntax.sh` — Bash-3.2 parse + mock-event smoke test harness.

Hook `command` strings in the repo `chorus.json` use the `__CHORUS_BIN__` placeholder; `public/install-kiro.sh` copies `bin/*.sh` into `<KIRO_DIR>/chorus-bin/`, `chmod +x`, and substitutes `__CHORUS_BIN__` with that absolute path. **Never commit a concrete machine path in the repo copy** — only the installed copy is concretized.

### Pi extension (`packages/chorus-pi/extensions/`)

Pi uses a native TypeScript extension instead of lifecycle bash hooks:

- `session_start` performs checkin, OpenSpec detection, and startup notification.
- `before_agent_start` injects checkin context once.
- Mutable `tool_call` on `subagent_spawn` creates a session only for `worker` and injects its UUID/workflow.
- `tool_result` and `tool_execution_end` map spawned agent IDs, close sessions, and emit reviewer nudges.
- `session_shutdown` retries retained session closures.

Keep pure parsing/path/banner helpers in `lib/lib.ts`. Preserve failed-close mappings for shutdown retry, and do not create sessions for scout/planner/reviewer/custom agents. The OpenSpec shell wrapper must resolve both env and `.mcp.json` configuration, but it is not a lifecycle hook.

After modifying the Pi package, run `cd packages/chorus-pi && bash test/all.sh`. This covers static checks, pure helper tests, and extension-event tests; update `test/verify-pi-session.md` when behavior requires live Pi verification.

**CRITICAL: All hook scripts MUST be compatible with Bash 3.2.** macOS ships with `/bin/bash` 3.2 (due to GPL licensing) and Claude Code + Codex + Kiro all use it to execute hooks. Do NOT use Bash 4+ features:

| Bash 4+ (FORBIDDEN) | Bash 3.2 alternative |
|---------------------|---------------------|
| `${VAR,,}` (lowercase) | `$(printf '%s' "$VAR" \| tr '[:upper:]' '[:lower:]')` |
| `${VAR^^}` (uppercase) | `$(printf '%s' "$VAR" \| tr '[:lower:]' '[:upper:]')` |
| `declare -A` (associative arrays) | Use separate variables or `jq` |
| `readarray` / `mapfile` | `while IFS= read -r line` loop |
| `\|&` (pipe stderr) | `2>&1 \|` |
| `&>>` (append both) | `>> file 2>&1` |

After modifying:
1. Run `/bin/bash public/chorus-plugin/bin/test-syntax.sh` (Claude Code + Codex hooks) and `/bin/bash public/kiro-plugin/bin/test-syntax.sh` (Kiro hooks) on macOS to verify Bash 3.2 compatibility — OpenClaw and Pi lifecycle code are TypeScript
2. Test locally: `claude --plugin-dir public/chorus-plugin` (Claude Code), install via `codex plugin install` and reload (Codex), re-run `install-kiro.sh` (Kiro), or `pi install "$PWD/packages/chorus-pi"` from the Chorus checkout (Pi)
3. Bump plugin version for whichever packages changed (all affected packages)
4. Users must restart the affected agent after updating (Kiro: re-run the installer; Pi: reinstall the package)

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

# Kiro — dry-run the installer into a throwaway HOME, then assert the tree
HOME=$(mktemp -d) CHORUS_URL=https://example.com CHORUS_API_KEY=cho_test \
  bash public/install-kiro.sh < /dev/null
# verify hook scripts parse under Bash 3.2
bash public/kiro-plugin/bin/test-syntax.sh

# Pi — static checks + helper and extension-event tests
cd packages/chorus-pi && bash test/all.sh

# dsh — typecheck + lint + unit tests + published-bundle validation
cd packages/chorus-dsh && pnpm run typecheck && pnpm run lint && pnpm test && pnpm run check:package
```
