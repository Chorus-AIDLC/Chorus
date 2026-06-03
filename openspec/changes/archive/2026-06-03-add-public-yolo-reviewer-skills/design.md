# Design: Standalone yolo + reviewer skills

## Context

`public/skill/` is the framework-neutral skill surface. Each subdirectory holds a single `SKILL.md` with YAML frontmatter (`name`, `description`, `license`, `metadata.{author,version,category,mcp_server}`) followed by a Markdown body. `package.json` is the manifest: it maps logical skill paths to served URLs (`/skill/<dir>/SKILL.md`) under both a `chorus` and a `moltbot` key, and lists discovery `triggers`. `chorus/SKILL.md` is the entry point — it documents install commands, a Skill Files table, and a Skill Routing table that consumers read to decide which other skills to fetch.

The two reviewer agents already exist in two other forms:

- **Codex skill form** (`plugins/chorus/skills/chorus-{proposal,task}-reviewer/SKILL.md`): a self-contained read-only review procedure ending in a grep-able `VERDICT:` line, invoked by mounting the skill into a Codex `default` sub-agent via `spawn_agent`.
- **Claude Code native subagent form** (`public/chorus-plugin/agents/{proposal,task}-reviewer.md`): same procedure expressed as an agent definition with `disallowedTools` and a `criticalSystemReminder`, invoked via the `chorus:{proposal,task}-reviewer` agent type.

This change ports the **Codex skill form** into `public/skill/` (because the standalone surface is skill-shaped, not agent-definition-shaped) and renames per the local convention.

## Goals / Non-Goals

**Goals**
- A standalone consumer can run the full yolo pipeline from `public/skill/` alone.
- Reviewer invocation never assumes a specific agent type or harness API.
- The reviewer review procedure (the actual quality bar) matches the Codex/CC source semantically.
- `package.json` and `chorus/SKILL.md` stay the single source of truth for discovery.

**Non-Goals**
- Touching the other three surfaces (CC plugin, Codex plugin, OpenClaw).
- Any runtime/backend/schema/UI change.
- Byte-for-byte parity with the Codex reviewer bodies — semantic equivalence plus surface-appropriate phrasing is the bar (the Codex versions reference Codex-only mechanics like `spawn_agent`/`close_agent` thread slots that must not leak into the neutral surface).

## Key Decisions

### Decision 1 — Naming: `<stage>-chorus` suffix

The three new dirs are `proposal-reviewer-chorus/`, `task-reviewer-chorus/`, `yolo-chorus/`. Every existing `public/skill/` dir uses the `<stage>-chorus` suffix; matching it keeps the install scripts, routing table, and `package.json` file map uniform. The Codex `chorus-<x>` prefix form is rejected for this surface.

### Decision 2 — Framework-neutral reviewer invocation, documented once

The canonical pattern lives in `chorus/SKILL.md` under a new "Independent Review" subsection. Every other reference (yolo review loops, develop Step 8, review A3.5 / B2.5) states the intent and points back to it, rather than re-describing a spawn API. The pattern:

1. Spawn a **read-only** sub-agent.
2. Have it load the matching reviewer skill (`proposal-reviewer-chorus` or `task-reviewer-chorus`) and pass it the target UUID.
3. The reviewer posts a single `VERDICT:` comment (`PASS` / `PASS WITH NOTES` / `FAIL`).
4. The host reads the comment via `chorus_get_comments` and acts.
5. **Fallback:** if the harness cannot spawn sub-agents, load the reviewer skill inline and follow it as a self-review — the procedure is identical; only the isolation differs.

Harness-specific spawn mechanisms (Claude Code Task/Agent tool, Codex `spawn_agent`) are mentioned only as *examples* in that one subsection, never as required calls in workflow prose.

### Decision 3 — Reviewer skill bodies: ported, read-only, VERDICT contract preserved

Each reviewer skill keeps the load-bearing invariants from the source:
- READ-ONLY posture (proposal reviewer: no writes/Bash at all; task reviewer: read-only Bash limited to test/build/inspection commands, no git writes, no file mutation).
- Batch-gather-then-analyze efficiency rule and a turn-budget rule (post current findings before running out of turns).
- BLOCKER vs NOTE classification with the project's fixed rules (pseudocode/wording mismatches are always NOTE).
- Exactly one of three grep-able literals: `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, `VERDICT: FAIL`.
- Round-2+ awareness (only re-check previous BLOCKERs).
- Output budget ~800 chars, posted via `chorus_add_comment`.

Codex-only operational mechanics (`spawn_agent`/`wait_agent`/`close_agent`, thread-slot caps) are dropped — they belong to the *host*, not the reviewer, and the host pattern is now neutral.

### Decision 4 — yolo-chorus mirrors the Codex/CC structure, neutralized

Sections: Overview + pipeline diagram, Prerequisites (permission preflight: `idea:write`, `proposal:write+admin`, `task:write+admin`, `project:write`), Input, Phase 1 Planning (resolve project → create idea → self-elaboration → create proposal with docs+tasks), Phase 2 Proposal Review loop (neutral reviewer spawn, up to `maxProposalReviewRounds`, no-VERDICT respawn-once rule), Phase 3 wave-based Execution (neutral parallel sub-agents with a sequential main-agent fallback), Phase 4 Verification loop (neutral task-reviewer spawn, mark AC + verify or reopen, max rounds + escalation), Phase 5 Report, Phase 5b mandatory Idea Completion Report via `chorus_create_report`. `maxProposalReviewRounds` / `maxTaskReviewRounds` are described as "default 3" parameters the host may carry, not as plugin-config reads (the standalone surface has no plugin config).

### Decision 5 — Version alignment to 0.9.3 + close pre-existing registration gaps

`public/skill/package.json` `version` and every `public/skill/*/SKILL.md` frontmatter version are set to `0.9.3` to match the project version and end the current `0.3.1`/`0.3.2` drift. This is a docs-surface version, independent of the npm package version.

While registering the three new skills, the change also fixes two pre-existing gaps discovered during review: `package.json` registers only 5 of the 7 already-shipping skills (`quick-dev-chorus` and `brainstorm-chorus` are on disk but unregistered), and `chorus/SKILL.md` lists `quick-dev-chorus` only in its routing table (not the Skill Files table or install scripts) and omits `brainstorm-chorus` entirely. The post-change manifest registers all 10 skills consistently. `quick-dev-chorus/SKILL.md` additionally uses a non-standard frontmatter shape (bare top-level `version`, no `license`/`metadata`); it is normalized to the standard block.

## Risks / Trade-offs

- **Duplication across surfaces.** The reviewer procedure now exists in three places (Codex skill, CC agent, standalone skill). Mitigation: this is already the status quo for the brainstorm/idea skills; cross-surface parity enforcement is explicitly deferred and owned by `plugin-maintenance`.
- **Neutral prose is vaguer than a concrete API call.** Mitigation: the one canonical subsection gives concrete per-harness examples and a guaranteed inline fallback, so an agent always has a runnable path.

## Migration / Rollout

Pure additive docs. No migration. Consumers pick up the new skills on their next `curl` install or update check (`chorus/SKILL.md` documents the version-compare step).
