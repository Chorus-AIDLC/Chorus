# Proposal: Add yolo + reviewer skills to the standalone `public/skill/` surface

## Why

Chorus ships its agent-facing skills through four distribution surfaces (see project memory "Four plugin surfaces"). One of them, `public/skill/`, is the **standalone** surface: it is served as static assets at `<BASE_URL>/skill/` and consumed by *any* agent framework that `curl`-downloads the `SKILL.md` files (Claude Code project install, Moltbot, or a bare MCP client). It carries no plugin runtime, no hooks, and no custom agent types.

Today that surface has two gaps:

1. **No `yolo` skill.** The Codex plugin (`plugins/chorus/skills/yolo/`) and the Claude Code plugin both document the full-auto AI-DLC pipeline, but a standalone consumer has no equivalent. They have to stitch `idea` → `proposal` → `develop` → `review` together by hand.

2. **No reviewer skills, and broken reviewer references.** The adversarial proposal/task reviewers are the project's core quality gate. The Codex plugin already models them *as skills* (`plugins/chorus/skills/chorus-proposal-reviewer/`, `chorus-task-reviewer/`) that a host agent mounts into a sub-agent. The Claude Code plugin models them as native subagents (`public/chorus-plugin/agents/*.md`, invoked via the `chorus:proposal-reviewer` / `chorus:task-reviewer` agent types). But `public/skill/develop-chorus` and `public/skill/review-chorus` reference `chorus:proposal-reviewer` / `chorus:task-reviewer` — a Claude-Code-plugin-specific agent type that **does not exist** for an agent that merely `curl`-downloaded the skill. The standalone experience is split: it points at machinery the consumer doesn't have.

The fix is to learn from the Codex plugin's approach — express the reviewers as standalone skills — and make every reviewer reference in the standalone surface **framework-neutral**: "spawn a read-only sub-agent and have it load the reviewer skill," with a note that the exact spawn mechanism is harness-specific and an inline-self-review fallback when sub-agents are unavailable.

## What Changes

Scope is strictly the `public/skill/` standalone surface. No changes to the Claude Code plugin, the Codex plugin, the OpenClaw plugin, backend, schema, or UI.

**New skills (3):**

- `public/skill/proposal-reviewer-chorus/SKILL.md` — read-only adversarial proposal reviewer. Body ported from the Codex `chorus-proposal-reviewer` skill (review procedure, finding classification, VERDICT contract, 800-char output budget), with frontmatter and any harness-specific phrasing adapted to the standalone surface.
- `public/skill/task-reviewer-chorus/SKILL.md` — read-only adversarial task reviewer. Body ported from the Codex `chorus-task-reviewer` skill (read-only Bash policy, per-AC verification, VERDICT contract).
- `public/skill/yolo-chorus/SKILL.md` — full-auto AI-DLC lifecycle doc (Prerequisites → Planning → Proposal Review loop → wave-based Execution → Verification loop → Report → mandatory Idea Completion Report), with **every** sub-agent / reviewer invocation written framework-neutrally.

**Naming convention:** all three follow the existing `<stage>-chorus` suffix used by every dir in `public/skill/` (`idea-chorus`, `develop-chorus`, `review-chorus`, `quick-dev-chorus`, `brainstorm-chorus`). Not the Codex `chorus-<x>` prefix form.

**Framework-neutral reviewer invocation** — a single canonical pattern introduced in `chorus/SKILL.md` and referenced everywhere else:

> Spawn a read-only sub-agent and have it load the reviewer skill (`proposal-reviewer-chorus` for proposals, `task-reviewer-chorus` for tasks). The sub-agent posts a `VERDICT:` comment on the target; read it with `chorus_get_comments` before acting. The exact spawn mechanism is harness-specific (e.g. Claude Code's Task/Agent tool, Codex's `spawn_agent`). If your harness cannot spawn sub-agents, load the reviewer skill inline and follow it yourself as a self-review.

**Unify existing references:** rewrite the reviewer mentions in `develop-chorus` (Step 8 review-agent note) and `review-chorus` to point at this canonical pattern instead of the `chorus:proposal-reviewer` / `chorus:task-reviewer` agent types. Note the current baseline: `review-chorus` Workflow A already has an `A3.5: Independent Review` subsection (referencing `chorus:proposal-reviewer`) which is *rewritten*; Workflow B (task verification) has **no** Independent Review subsection today, so one must be **added** (e.g. `B2.5`) pointing at `task-reviewer-chorus`. `develop-chorus` Step 8 references `chorus:task-reviewer` and is rewritten.

**Manifest + routing.** Current baseline (verified against the repo): `public/skill/package.json` `version` is `0.3.1` and its `chorus.files` / `moltbot.files` maps register **only 5** skills — `chorus`, `idea-chorus`, `proposal-chorus`, `develop-chorus`, `review-chorus`. The two already-shipping dirs `quick-dev-chorus` and `brainstorm-chorus` exist on disk but are **not** registered in `package.json`; `chorus/SKILL.md` mentions `quick-dev-chorus` only in its Skill Routing table (absent from the Skill Files table and both install scripts) and never mentions `brainstorm-chorus`. So registration must cover **five** previously-unregistered-or-partially-registered skills, not just the three new ones:

- `public/skill/package.json` — add `quick-dev-chorus/SKILL.md`, `brainstorm-chorus/SKILL.md`, `proposal-reviewer-chorus/SKILL.md`, `task-reviewer-chorus/SKILL.md`, `yolo-chorus/SKILL.md` to both the `chorus.files` and `moltbot.files` maps (bringing the total to 10); add `triggers` (`yolo`, `review agent`, `verify`); bump `version` `0.3.1` → `0.9.3`.
- `public/skill/chorus/SKILL.md` — make the Skill Files table, both install scripts (Claude Code + Moltbot), and the Skill Routing table consistently list **all 10** skills (i.e. also fix the pre-existing `quick-dev-chorus` / `brainstorm-chorus` gaps while adding the three new ones); add a short canonical "Independent Review" subsection documenting the reviewer skills + the neutral pattern once.
- Bump the frontmatter version in every `public/skill/*/SKILL.md` to `0.9.3` (currently a `0.3.1` / `0.3.2` mix). Note `quick-dev-chorus/SKILL.md` uses a non-standard frontmatter shape (top-level `version: 0.3.2`, no `license`/`metadata` block); normalize it to the standard `metadata.version: "0.9.3"` block used by the others.

All skill docs are written in English (project rule).

## Capabilities

This change adds one new capability:

- **`public-skill-yolo-reviewers`** — the standalone `/skill/` distribution provides a yolo lifecycle skill and two reviewer skills, and references reviewers through a framework-neutral sub-agent pattern rather than a plugin-specific agent type.

## Impact

- **Affected code:** documentation only. 3 new `SKILL.md` files; modifications to `public/skill/chorus/SKILL.md`, `public/skill/develop-chorus/SKILL.md`, `public/skill/review-chorus/SKILL.md`, `public/skill/package.json`, plus a frontmatter version bump across the remaining `public/skill/*/SKILL.md` (`idea-chorus`, `proposal-chorus`, `brainstorm-chorus`, and a frontmatter-shape normalization of `quick-dev-chorus`). Zero TypeScript / Prisma / React / MCP-tool changes.
- **Affected workflows:** standalone-skill consumers (curl install, Moltbot) gain a working yolo + reviewer experience; the reviewer references stop pointing at machinery they don't have.
- **Affected runtime:** none. No migrations, no new dependencies, no MCP tool changes, no config flags. `public/skill/` is static assets.
- **Risk:** low. Markdown-only; the new skills are additive and the rewritten references degrade gracefully (inline self-review fallback) on any harness.
- **Out of scope (deferred):** propagating identical changes to the Claude Code plugin agents, the Codex plugin, or the OpenClaw plugin — the CC plugin already ships native reviewer subagents and the Codex plugin already has the reviewer skills, so cross-surface drift is a known but separate follow-up (owned by the `plugin-maintenance` doc). Any backend/schema/UI work. A CI check enforcing reviewer-body parity across surfaces.
