# Design: First-principles alignment review

## Overview

Add an **intent-alignment** dimension to the three existing Chorus reviewers so each gate checks, top-down, that the work still serves the *original Idea's intent* — not just that it passes its local checks. The design has **one moving part**:

1. **A compact shared alignment snippet** added to every reviewer prompt. The snippet tells the reviewer to (a) **resolve the originating Idea** from the entity under review, (b) read it with the **existing** `chorus_get_idea` / `chorus_get_elaboration` / `chorus_get_comments`, (c) build the *original-intent* **baseline from human-authored input only** (agent-authored / agent-answered entries are audit context only), and (d) apply a fixed drift/verdict rule.

There is **no new MCP tool**. The owner reviewed an earlier tool-backed draft (a consolidated `chorus_get_alignment_anchor` read) and rejected it as too complex; the alignment check is implemented **purely as reviewer-prompt reminders** that self-gather through reads every reviewer surface already has. The snippet is kept bounded so the per-reviewer prompt does not balloon (the owner's explicit constraint: *"不要让 reviewer 的 prompt 膨胀太多"*).

## Why prompt-only, not a consolidated tool (the central decision)

Two options were considered:

- **(a) Pure prompt** *(chosen — owner override)* — embed the resolve-then-read recipe (resolve the direct Idea → `chorus_get_idea` + `chorus_get_elaboration` + `chorus_get_comments`) and the drift rubric directly into all 21 reviewer definitions.
- **(b) Tool-backed** — one `chorus_get_alignment_anchor` MCP call returns the whole bundle (with the human-baseline / agent-audit split performed server-side); the prompt only carries a short "fetch anchor, check 3 drift types, block unless authorized/override" instruction.

(b) was initially chosen under YOLO for two reasons: it kept the prompt shortest, and it let the human-baseline-vs-agent-audit split be a **data-layer guarantee** rather than a prompt rule. **The owner overrode that choice**: a whole new gated MCP tool + service + tests is disproportionate complexity for what is fundamentally a reviewer reminder, and every field the tool returned is already readable through three existing tools. (a) is therefore the design: the snippet is a few lines longer, and the baseline/agent-audit split becomes an **explicit prompt rule** the reviewer applies to `answeredBy.type` / `author.type` while reading — see the honesty note in *Risks* about what that trades away. The one real gap the tool would also have closed — **task-reviewer had no upward link to the idea** — is closed here too, because the snippet gives the task-reviewer the resolution recipe (`chorus_get_task` → its proposal's `inputUuids[0]`).

## Architecture

### Component 1 — Idea resolution + reads (in the prompt)

Each reviewer resolves the **directly-attached** Idea (the Idea the work serves — never an ancestor theme) from whatever entity it is reviewing, then reads it. The anchor is the **direct** Idea (a proposal's `inputUuids[0]`), never the topmost ancestor: anchoring on a parent theme would itself be exactly the semantic drift this feature exists to catch.

| Reviewer | Resolution recipe (prompt) |
|---|---|
| proposal-reviewer | the proposal's `inputUuids[0]` |
| task-reviewer | `chorus_get_task`, then that task's proposal's `inputUuids[0]` |
| code-reviewer | the `ideaUuid` it was given |

If there is no attached Idea (e.g. a document-input proposal, a quick task), the reviewer **skips** the alignment dimension. Reads used (all existing, all reachable on every surface through its `@chorus` MCP binding — no REST route needed):

- `chorus_get_idea` → the Idea `content` (primary human-authored intent statement).
- `chorus_get_elaboration` → resolved decisions, each carrying `answeredBy.type`.
- `chorus_get_comments({ targetType: "idea", targetUuid })` → Idea comments, each carrying `author.type`.

### Component 2 — the baseline vs. agent-context rule (the anti-self-authorization core)

The reviewer builds the intent **baseline** from **human-authored input ONLY**:

- the Idea `content`, **plus**
- elaboration answers where `answeredBy.type == "user"`, **plus**
- comments where `author.type == "user"`.

**Agent-answered elaboration and agent-authored comments are AUDIT CONTEXT ONLY** — they must never expand, shrink, or override the baseline. This closes the self-authorization hole: a drifting agent must not turn its own additions into intent by self-answering a YOLO elaboration or posting an Idea comment claiming extra scope. Those entries are visible to the reviewer for audit, but they never become part of the baseline the drift check anchors on.

The human/agent classification is **fail-closed**: only the exact type `"user"` counts as human; `"agent"`, the session-scoped `"agent_instance"`, any unknown future type, or a missing type all count as **agent/non-human**. When in doubt, the entry is not part of the baseline.

> **Where the split lives now.** In the rejected tool design this partition was performed server-side at the data layer, so the 21 prompts could not re-derive it. In the prompt-only design the partition is a **prompt rule the reviewer applies** to the `answeredBy.type` / `author.type` fields the existing reads already return. The fields exist and are authoritative (write paths stamp `author.type: "agent"` for MCP-authored content and `"user"` for dashboard-authored content); what changed is that the *enforcement* is now the reviewer following the rule rather than a service guaranteeing the shape. This is the deliberate simplicity/robustness trade the owner accepted.

### Component 3 — the compact shared alignment snippet (prompt)

A single **bounded** block (four short paragraphs + three bullets) inserted into each reviewer's existing "gather context" + "verdict" flow. Canonical text authored once for the Claude Code copies, then swept byte-consistently to all seven surfaces (there is no include mechanism — parity is maintained by the plugin-maintenance seven-surface sweep, the established pattern). The block says, in essence:

> **First-principles alignment.** Resolve the Idea this work serves (proposal → `inputUuids[0]`; task → `chorus_get_task` then its proposal's `inputUuids[0]`; code → the given `ideaUuid`); if none, skip. Read `chorus_get_idea` (content), `chorus_get_elaboration` (decisions with `answeredBy.type`), and `chorus_get_comments({ targetType: "idea" })` (comments with `author.type`). Build the **original intent** (baseline) from HUMAN input ALONE — Idea content + `answeredBy.type == "user"` answers + `author.type == "user"` comments; agent-answered/-authored entries are audit-only and MUST NOT expand, shrink, or override the baseline (a drifting agent cannot self-authorize). Check the work against the baseline for three drift types: **scope creep** (work beyond the baseline), **requirement loss / shrink** (baseline intent dropped/reduced), **semantic drift** (passes AC but misses the point). Any drift is a **BLOCKER** — **unless** authorized by a cited **human** entry (a `author.type == "user"` comment, an `answeredBy.type == "user"` elaboration decision) or an explicit human override at the gate — an agent-authored/-answered entry NEVER authorizes. When downgrading on the escape hatch, downgrade to a NOTE and **cite the specific human entry**. Fold alignment into your existing VERDICT.

Per host, only the tool prefix (`chorus__get_idea` etc. on OpenClaw) and the surrounding section framing change; the rule is identical (verified byte-consistent after normalizing the prefix).

### Per-reviewer wiring (what changes in each)

| Reviewer | Reviews | Anchor today | After |
|---|---|---|---|
| proposal-reviewer | proposal drafts | idea + elaboration (derives ideaUuid from `inputUuids[0]`), but proposal comments only | adds the Idea-comment read + the baseline/drift rule |
| task-reviewer | one task's impl | **nothing upward** | resolves `task → proposal → inputUuids[0]`, reads idea/elaboration/comments — first time it sees the idea intent |
| code-reviewer | idea aggregate | idea + idea comments, no elaboration | adds elaboration + the baseline/drift rule |

The existing per-reviewer dimensions, read-only posture, output cap, and `VERDICT: PASS / PASS WITH NOTES / FAIL` derivation are unchanged; alignment folds in as another source of BLOCKER/NOTE findings.

## "Hard block" in an advisory-verdict world (honest scoping)

Reviewer verdicts are **advisory** — nothing in the server gates on them (confirmed: `code-reviewer.md`, `orchestrate/SKILL.md`, `review/SKILL.md`, `yolo/SKILL.md`, and the `code-review-gateway` spec all state verdicts are advisory/behavioral). So "hard blocker" is **not** a new DB-level lock. It means: **alignment drift produces a `BLOCKER` → `FAIL`/reject finding**, and the *existing* skill loops already treat FAIL as blocking:

- proposal FAIL → reject → revise drafts → resubmit (bounded by `maxProposalReviewRounds`).
- task FAIL → reopen, do not verify.
- code FAIL → add fix tasks to the approved proposal, re-run, bounded by `maxCodeReviewRounds`.

The two escape hatches map onto this cleanly: a **human-authored** authorization in the baseline — a human-authored Idea comment or a human-answered elaboration entry (never the reviewed agent's own comment/answer) — means the reviewer never raises the BLOCKER in the first place; a **human override** is the human at `/review` (or the yolo operator) choosing to proceed despite the finding — the standard Reversed-Conversation gate. This keeps the change additive: **no new enforcement plumbing**, consistent with "extend existing reviewers."

## Multi-surface propagation

Seven surfaces, each with its own copy and spawn mechanism (Claude Code `Agent()`, Codex `spawn_agent`, OpenClaw `sessions_spawn` + `chorus__` prefix, Kiro JSON `prompt` string with `tools:["read","@chorus"]`, Pi `subagent_spawn`, dsh `subagent` with `-chorus` suffix, standalone skill lib). The alignment snippet is added to all 21 reviewer definitions; the plugin-maintenance skill's seven-surface checklist is the propagation guardrail. Because the snippet only uses reads every surface already has via its `@chorus` binding, there is no server-side component to keep in sync — parity is purely textual (byte-consistent modulo the tool prefix and each host's section framing).

## Risks & mitigations

- **LLM judgment on the baseline/agent split.** In the prompt-only design the reviewer itself must partition entries by `author.type` / `answeredBy.type` and refuse to treat agent-originated content as intent. A sloppy reviewer could fold an agent comment into "intent" and thereby let a drifting agent self-authorize. *Mitigation*: the snippet states the rule explicitly and fail-closed (only exact `"user"` counts as human; when in doubt, exclude), names the exact fields to key off, and requires the reviewer to **cite the specific human entry** when it downgrades on the escape hatch, so a human can audit the decision in the verdict. This is a genuinely weaker guarantee than the rejected data-layer split — it is the accepted cost of dropping the tool.
- **LLM judgment on "traceable to an authorized change."** Deciding whether a deviation is documented by a human entry is a reasoning call, not a mechanical match — false negatives (over-blocking) and false positives (accepting a vague comment as authorization) are both possible. *Mitigation*: the cite-the-entry requirement above; and the escape hatch keys only off human-authored/-answered entries.
- **Payload size / token cost.** A long idea + many comments inflate the reviewer's context. *Mitigation*: the reviewer reads `chorus_get_elaboration` (resolved Q + chosen answer) and `chorus_get_comments` (paginated newest-first) — the same reads it would otherwise stage anyway; no data is duplicated.
- **No attached idea** (document-input proposals, quick tasks): the reviewer finds no `inputUuids[0]` / no proposal and **skips** the dimension — no false blockers.
- **Prompt bloat.** *Mitigation*: enforce a bounded snippet length in the spec (R4) and review the diff of each reviewer file for net line growth during the parity sweep.

## Out of scope

- **A consolidated alignment-anchor MCP tool** (`chorus_get_alignment_anchor`) or any new MCP tool/service — explicitly rejected by the owner as too complex; the check is prompt-only.
- Server-side enforcement that mechanically blocks status transitions on a FAIL verdict (would be a much larger change; current model is intentionally advisory/behavioral).
- A separate persisted alignment **report** artifact (owner chose VERDICT-comment output only).
- A new dedicated alignment-reviewer agent (owner chose to extend existing reviewers).
- Anchoring on ancestor theme intent (the anchor is always the directly-attached Idea).

## Known boundary — the Idea *body* is a trusted anchor (precise guarantee scope)

The anti-self-authorization rule this change delivers is **specifically**: *the reviewer must not treat agent-authored comments or agent-answered elaboration as intent* — those are excluded from the baseline by the prompt rule (keyed off `author.type` / `answeredBy.type`, fail-closed). It is **not** the blanket claim "an agent can never self-authorize", and — unlike the rejected tool design — the exclusion is now enforced by the reviewer following the rule rather than by a service guaranteeing the data shape.

The residual vector: the Idea **`content` (body) is treated as trusted baseline**, but an agent holding `idea:write` can `chorus_edit_idea` to expand the body — the same baseline-poisoning attack, one level up, and one the prompt rule cannot catch (a body edit leaves no `author.type` on the content itself). This is intentionally **not** hard-patched here, because the normal daemon ideation flow legitimately has an agent `chorus_edit_idea` to polish the user's raw input, so a blanket "distrust any agent-edited body" rule would break real usage. The existing `edited` activity records only `changedFields`, not the prior body, so it cannot by itself reconstruct the original intent.

The proper fix is a **lifecycle-aware immutable anchor version**: freeze a baseline snapshot at human elaboration-confirmation (or proposal approval); subsequent body edits retain before/after + actor provenance; only a human ratification produces a new baseline version, while agent edits enter a proposed/audit context. This is tracked as a separate follow-up Idea (see the idea's review thread / completion report).
