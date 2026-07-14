# Design: Kiro CLI plugin (agents / steering / skill-doc port)

## Context

Plugin-surface child (`97ccd334`) of the Kiro-integration theme (`a1e25b50`). Scope is fixed by a two-round elaboration + one follow-up human instruction; those answers are the binding contract:

- **`packaging=a`** — install script + `.kiro/` template under a new repo root (`public/kiro-plugin/`), mirroring the Codex install-script surface. (Not a Kiro Power; that's deferred.)
- **`daemon_boundary=a`** — this child owns ALL static `.kiro/` templates; the daemon child `dc53a459` reuses them for headless wake. Single source of truth.
- **`kiro_agents_set=b`** — ship 3 reviewer subagents **+ 1 `chorus` main agent** that pre-wires skills + MCP + hooks.
- **`hooks_depth=a`** — full parity: lifecycle hooks (checkin / heartbeat / checkout) **and** reviewer-nudge `postToolUse` hooks.
- **Follow-up human instruction** — because the install is **global** (`~/.kiro/`), all skills and agents MUST carry a `chorus` prefix for distinctiveness against the user's own global skills. This reverses round-1's bare-`/idea` pick.

Kiro conventions were verified against current docs (references on the idea): the agent-config reference, MCP configuration, skills, subagents, and hooks pages. Facts load-bearing here:

- Kiro reads `.kiro/{agents,steering,skills,settings/mcp.json}` at workspace (`<cwd>/.kiro/`, wins) or global (`~/.kiro/`) scope. There is no "plugin" layer.
- Remote HTTP MCP: `{"type":"http","url":...,"headers":{"Authorization":"Bearer ${env:CHORUS_API_KEY}"},"disabled":false}`. Kiro-CLI env interpolation uses the `${env:VAR}` prefix (differs from Kiro-IDE's bare `${VAR}` — Kiro#3909).
- Skills: `.kiro/skills/<name>/SKILL.md`, YAML frontmatter `name` (lowercase+hyphens ≤64) + `description` (≤1024, the activation matcher). Activated by description-match AND `/name` slash command. Args via `$ARGUMENTS`/`${N}`. Default agent auto-loads skills; **custom agents must list `skill://` in `resources`**.
- Agent file: **Kiro CLI uses `.json`** (`~/.kiro/agents/<name>.json`) — a full JSON config object; Kiro **IDE** uses `.md`+frontmatter (a confirmed CLI/IDE split, Kiro#8040). This plugin targets Kiro **CLI**, so agents are `.json`. Fields: `name description prompt`(inline OR `file://./<name>.md` for a long system-prompt body)` mcpServers tools`(`['read','shell','@server','@server/tool','*','@builtin','subagent']`)` allowedTools toolsSettings resources hooks includeMcpJson model`. Filename = agent name; workspace wins over global. (Skills and steering remain `.md` — that is correct for both CLI and IDE.)
- Subagents: main agent needs `subagent` in `tools`; Kiro auto-selects by the subagent's `description`; each subagent also appears as `/name`; a subagent inherits ONLY its own file's tool scope (so `tools:["read","@chorus"]` = read-only).
- Hooks: `agentSpawn userPromptSubmit preToolUse postToolUse stop`, each `{command, matcher?, timeout_ms?}`. Matcher accepts built-in names (`fs_read/fs_write/execute_bash/use_aws` + aliases) AND MCP tools (`@server/tool`, `@server`, `*`, `@builtin`) — **no regex/glob**. Hooks live only inside an agent file (no standalone `hooks.json`). `agentSpawn` STDOUT is added to context; `stop` can return `{"decision":"block"}`.

## Goal

Deliver a 4th plugin surface so a Kiro CLI user runs one `curl … install-kiro.sh | bash`, then in any directory has `/chorus-idea … /chorus-yolo`, the Chorus MCP server, read-only reviewer subagents, and (via `kiro --agent chorus`) full session automation — parity with the CC/Codex/OpenClaw surfaces, adapted to Kiro's native conventions.

## Decisions

### D1 — Deliverable = template tree + install script, global by default

`public/kiro-plugin/.kiro/` is the source-of-truth template. `public/install-kiro.sh` **merges** it into `~/.kiro/` (global; default) or `<cwd>/.kiro/` (`--workspace`). Global is the default because Kiro's default agent auto-loads global `~/.kiro/{skills,steering,settings/mcp.json}` — so one install works in every directory; the only per-need item is the `CHORUS_URL`/`CHORUS_API_KEY` env (set once in shell; direnv to vary the key per project). This mirrors `install-codex.sh` (writes `~/.codex/`) and the CC marketplace (install-once). Rationale for merge-not-overwrite: a user may already have a `~/.kiro/settings/mcp.json` with their own servers; the installer adds/updates only the `chorus` key and backs up first (`.chorus-bak`), exactly as `install-codex.sh` does for `config.toml`.

### D2 — `chorus-` prefix on ALL skills and agents (prefix, not suffix)

Global install → bare `/idea` would collide with or be indistinguishable from the user's own global skills. Chosen **prefix** over suffix so `/chorus`+Tab lists the whole family as a group (suffix `/idea-chorus` would scatter under `/idea`, `/proposal`, … and require knowing the base name first). Precedent in-repo: the standalone skill root uses the `-chorus` suffix, Codex reviewers use the `chorus-` prefix — Kiro is a new surface, so we standardize on prefix. Concretely:

- skills: `chorus-idea chorus-proposal chorus-develop chorus-yolo chorus-review chorus-quick-dev chorus-brainstorm chorus-openspec-aware`
- agents: `chorus` (main) + `chorus-code-reviewer` `chorus-proposal-reviewer` `chorus-task-reviewer`
- All intra-skill cross-references (e.g. the idea skill's "use `/proposal`") are rewritten to the `/chorus-`-prefixed command so the ported docs stay self-consistent.

### D3 — Overview `chorus` skill folds into steering, not a skill

The existing overview `chorus` skill would produce a `/chorus` slash command that collides with the `chorus` **main agent**'s slash command. Resolution: the overview content becomes `~/.kiro/steering/chorus.md` (a global steering doc, auto-loaded by the default agent and referenced by every `chorus*` agent's `resources`). Net effect: `/chorus` unambiguously activates the main agent; the platform-overview context is always-on via steering. So the ported skill set is 8 `chorus-*` skills (no `chorus` skill), and steering carries the overview + AI-DLC + role/permission context.

### D4 — One `chorus` main agent hosts all hooks; reviewers are read-only subagents

Because Kiro hooks live only inside an agent file, full-parity automation requires a custom main agent. `agents/chorus.json`:
- `resources`: `skill://.kiro/skills/chorus-*/SKILL.md` (all 8) + `file://.kiro/steering/chorus.md`.
- `prompt`: `file://./chorus.md` — the long system-prompt body lives beside the JSON as a `.md` sidecar (Kiro `file://` prompt paths resolve relative to the config file's dir).
- `includeMcpJson: true` (pulls the shared `chorus` server) — chosen over a per-agent inline `mcpServers` block so auth is written once (DRY; matches the CC single-`.mcp.json` shape).
- `tools`: `@chorus` (all Chorus MCP tools) + `read`/`write`/`shell` (a developer needs to edit/run code) + `subagent` (so it can spawn reviewers). Left broad because Chorus permissions are still enforced **server-side** by the API key's preset — the client-side tool scope is not the security boundary for MCP calls.
- `hooks` per D5.

The three reviewer agents port from the CC reviewer files (same VERDICT protocol, same read-only posture) as `agents/chorus-code-reviewer.json` / `chorus-proposal-reviewer.json` / `chorus-task-reviewer.json`, each with `tools:["read","@chorus"]` and no `write`/`shell`. Kiro auto-selects them by `description` and exposes each as `/chorus-*-reviewer`. Their prompt bodies carry the CC reviewers' critical read-only reminder + VERDICT format (inline in the JSON `prompt`, or a `file://./<name>.md` sidecar). Kiro CLI has no `disallowedTools` frontmatter key; read-only is enforced by omitting write/shell from `tools`.

### D5 — Hook set (full parity), Bash-3.2-safe

On `agents/chorus.json`, hosted as `{command, matcher?}` entries. Hook scripts are authored in the repo at `public/kiro-plugin/bin/` (`chorus-api.sh` is copied in from the CC plugin bin so the Kiro template is self-contained):

| Trigger | matcher | Script action |
|---|---|---|
| `agentSpawn` | — | `chorus_checkin` via `chorus-api.sh`; STDOUT → agent context (owner/permissions/idea-tracker), same as CC `on-session-start.sh` |
| `stop` | — | session heartbeat + checkout (best-effort; never blocks) |
| `postToolUse` | `@chorus/chorus_pm_submit_proposal` | emit "spawn `chorus-proposal-reviewer`" nudge (respects a max-rounds env, like CC) |
| `postToolUse` | `@chorus/chorus_submit_for_verify` | emit "spawn `chorus-task-reviewer`" nudge |
| `postToolUse` | `@chorus/chorus_admin_verify_task` | emit "spawn `chorus-code-reviewer` if last task of the idea" nudge |

Matchers use the exact `@chorus/<tool>` form (Kiro supports no regex, but these are exact tool names — sufficient). Scripts are Bash-3.2-compatible (no `${VAR,,}`, `declare -A`, `readarray`, etc. — CLAUDE.md pitfall #10) and validated by a ported `test-syntax.sh`. They reuse `chorus-api.sh` for MCP calls where a call is needed; nudge-only hooks just print `additionalContext`-style text to STDOUT.

### D5a — Hook scripts must be installed AND the hook `command` paths resolved at install time (fixes review BLOCKER)

The scripts under `public/kiro-plugin/bin/` are a **sibling** of `.kiro/`, so copying only the `.kiro/` template would leave the hooks with no scripts to run — the automation would be dead on arrival. Two coupled installer responsibilities close this:

1. **Copy the scripts into the Kiro dir.** The installer copies `bin/*.sh` + `chorus-api.sh` to `<KIRO_DIR>/chorus-bin/` (where `<KIRO_DIR>` is `~/.kiro` global or `<cwd>/.kiro` for `--workspace`) and `chmod +x` them. Living inside the Kiro dir keeps a Chorus install self-contained and removable.
2. **Resolve the hook `command` paths at install time.** A Kiro hook `command` is a shell string with no documented `${CLAUDE_PLUGIN_ROOT}`-style variable, and the same static `chorus.json` must work under both global and workspace scope. So the repo template ships `chorus.json` with a **placeholder token** (`__CHORUS_BIN__`) in every hook `command`, and the installer substitutes the resolved **absolute** path to the installed `chorus-bin/` when it writes the file into `<KIRO_DIR>/agents/chorus.json`. Absolute paths are scope-independent and survive Kiro being launched from any cwd. (The repo copy keeps the placeholder so it never carries a machine-specific path; only the installed copy is concretized.)

This makes the hook-script install path a first-class installer + integration-checkpoint concern, with AC on both.

### D6 — Skill content ports ~1:1; adapt per Kiro conventions, not blind copy

The skill bodies are ported from an existing root (CC plugin skills are closest — same Agent-Skills `SKILL.md` shape). Adaptations: frontmatter `name:` becomes the `chorus-`-prefixed name; slash-command references rewritten to `/chorus-*`; any Claude-Code-specific mechanics (e.g. `AskUserQuestion`, `Agent(subagent_type:"chorus:*")`) rewritten to Kiro equivalents (Kiro subagent spawn by name / `/chorus-*-reviewer`). Semantic parity across surfaces is preserved (each root teaches the same workflow); textual identity is not a goal. `chorus-openspec-aware` is ported but its wrapper contract (`chorus-api.sh`) already works unchanged since the wrapper is runtime-agnostic.

### D7 — Boundary with the daemon child (`dc53a459`)

This child is the **single source of truth** for the `.kiro/` artifacts. The daemon child does NOT re-author agents/mcp.json; it consumes `public/kiro-plugin/.kiro/` templates when it drives `kiro-cli chat --no-interactive`. The headless MCP-load risk (Kiro#5958) is validated in the daemon child, not here — this child only exercises the **interactive** path (static config already confirmed reachable via the docs). If the daemon child later needs a headless-specific agent variant, it derives it from this child's templates rather than forking a divergent copy.

## Risks & Mitigations

- **R1 — `kiro` CLI not installed / no local Kiro to test interactively.** The install script's job is file placement + `mcp.json` merge, which is verifiable without a running Kiro (JSON validity, backup, idempotent re-run). AC for the install task assert file/JSON outcomes; a note flags that live `/chorus-idea` activation is a manual human check (documented in `CONNECT_KIRO.md`), not gated by automated AC — consistent with how headless work hands browser/live checks to a human.
- **R2 — Kiro schema drift.** Kiro CLI 2.0 is recent; field names could change. Mitigation: every authored agent JSON/skill frontmatter is validated against the referenced config docs at build time, and the install script fails loudly (not silently) if `kiro`/`kiro-cli` reports an incompatible version. Tasks note "verify field names against current Kiro docs" per the hallucination-aware guideline.
- **R3 — clobbering a user's `~/.kiro`.** Mitigation: merge-not-overwrite for `mcp.json` (only the `chorus` server key), always back up before write (`.chorus-bak`), and never touch a user's own skills/agents — only add `chorus`-prefixed files. `--workspace` gives full project-local isolation for the cautious.
- **R4 — hook matcher can't fire.** If a future Kiro drops MCP-tool matchers, the reviewer nudges silently no-op; lifecycle hooks (no matcher) still work, and the skill docs also instruct reviewer spawning as a fallback. Degradation is graceful, not a hard failure.

## Module Contracts (shared across tasks)

- **Template layout is authoritative.** Task 1 (templates) fixes the exact paths/names in `public/kiro-plugin/.kiro/` (agents are `.json`; skills/steering `.md`) and the sibling `public/kiro-plugin/bin/` scripts. Task 2 (installer) and Task 3 (hooks) reference those paths literally — no path may diverge from what Task 1 lays down.
- **MCP server key = `chorus`** everywhere (mcp.json key, `@chorus` tool sigil in agents/hooks, `Authorization: Bearer ${env:CHORUS_API_KEY}`). The installer merges this exact key.
- **Hook script install path + placeholder.** Hook scripts install to `<KIRO_DIR>/chorus-bin/`; the repo `chorus.json` carries the `__CHORUS_BIN__` placeholder in every hook `command`, and the installer substitutes the absolute installed path (D5a). Task 1 writes the placeholder; Task 2 substitutes it; Task 4 asserts resolution under both scopes.
- **Hook output shape** matches the CC hooks' `additionalContext` convention (STDOUT text the agent reads) so the ported reviewer-nudge wording stays recognizable.
- **Install script env contract** = `CHORUS_URL` + `CHORUS_API_KEY` (env or TTY), `--workspace` flag, `CHORUS_URL` normalized to end in `/api/mcp` (same normalization as `install-codex.sh`).

## Implementation Plan

1. **Templates** (`kiro-plugin-templates`) — author `public/kiro-plugin/.kiro/`: `settings/mcp.json`, 8 `chorus-*` skills, `chorus.json` main agent + 3 reviewer `.json` agents (with `.md` prompt sidecars), `steering/chorus.md` (with folded-in overview). The `chorus.json` hook `command`s carry the `__CHORUS_BIN__` placeholder. Validate JSON + skill frontmatter.
2. **Installer** (`kiro-plugin-installer`) — `public/install-kiro.sh` (global + `--workspace`, merge mcp.json, copy `bin/`→`chorus-bin/` + `chmod +x`, substitute `__CHORUS_BIN__`→absolute path, backup, idempotent) + `docs/CONNECT_KIRO.md` + surface-count doc/skill bookkeeping.
3. **Session automation** (`kiro-session-automation`) — `public/kiro-plugin/bin/*.sh` hook scripts + copied-in `chorus-api.sh` (Bash-3.2-safe) wired into `agents/chorus.json` via `__CHORUS_BIN__`, + `test-syntax.sh`.
4. **Integration checkpoint** — end-to-end dry-run: run `install-kiro.sh` into a throwaway `HOME`, assert the merged `~/.kiro/` tree is valid and idempotent on re-run, that `chorus.json` references every shipped skill, and that every hook `command` resolves to an executable script under `chorus-bin/` (placeholder fully substituted) under both global and `--workspace` scope.
