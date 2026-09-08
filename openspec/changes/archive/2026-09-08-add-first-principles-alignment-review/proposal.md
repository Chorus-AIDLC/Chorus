## Why

Chorus reviewers today verify **bottom-up**: the proposal-reviewer checks decomposition quality and AC alignment, the task-reviewer checks a task's implementation against its own AC, and the code-reviewer checks the aggregate change for correctness and convention drift. Nothing checks **top-down** whether the delivered work still serves the *original Idea's intent*.

Across the Idea → Proposal → Task → execution chain, every local step can look reasonable while the aggregate silently drifts from what the user actually asked for: scope creep (extra work never requested), requirement loss (something the Idea explicitly asked for is quietly dropped or shrunk), or semantic drift (the code passes its AC but misses the point). By the time drift is visible it is already cemented. We want a **first-principles alignment check** that pins every review gate back to the original intent and catches drift before it hardens.

## What Changes

- Add a **first-principles intent-alignment** dimension to the **three existing reviewers** (proposal-reviewer, task-reviewer, code-reviewer) — **no new reviewer agent, and no new MCP tool**.
- Define the intent **baseline** (authoritative statement of original intent) as **human-authored input ONLY**: the **directly-attached Idea's content** (the Idea the work serves, never an ancestor theme) + elaboration decisions **answered by a human** (`answeredBy.type == "user"`) + Idea comments **authored by a human** (`author.type == "user"`). The baseline doubles as the ledger of *human-authorized* scope evolution.
- **Agent-answered elaboration and agent-authored comments are AUDIT CONTEXT ONLY** — they can never expand, shrink, or override the baseline. This is the anti-self-authorization rule: a drifting agent must not turn its own additions into intent by self-answering a YOLO elaboration or posting its own Idea comment.
- Each reviewer **resolves the originating Idea** from whatever entity it is reviewing (proposal → its input Idea, task → its proposal's input Idea, code → the Idea directly) using **existing reads**, builds the baseline, and compares the artifact under review against it for **three drift types**: scope creep, requirement loss / shrink, and semantic drift.
- Detected drift is a **hard blocker** (contributes a `BLOCKER` → `FAIL` / reject), **except** when the deviation is traceable to a **human** authorized scope change in the baseline (a **human-authored** Idea comment or a **human-answered** elaboration entry), or a **human explicitly overrides** at the gate — an agent's own comment/answer never authorizes, so a drifting agent cannot self-clear. Authorized, human-documented evolution is *not* drift.
- Output stays a **VERDICT comment** on the reviewed entity (no separate report artifact) — the alignment result is one clearly-labeled section of the existing verdict, not a new deliverable.
- Implemented as **one compact, shared alignment-check snippet** — a reviewer-prompt reminder that self-gathers via existing reads — reused by all three reviewers across every plugin surface, so three separate prompts do not each balloon.

## Capabilities

### New Capabilities

- `first-principles-alignment-review`: the shared intent-alignment review dimension — Idea resolution + baseline construction (human-authored input only; agent input is audit-only), the three-way drift taxonomy, hard-block-with-escape-hatch verdict semantics, the compact shared prompt snippet, and multi-surface parity — layered onto the proposal-, task-, and code-reviewer.

### Modified Capabilities

- (none) — the alignment dimension is **additive**. Existing reviewer capabilities (`code-review-gateway`, the bundled proposal-/task-reviewer agents) are referenced, not respecified; their existing PASS / PASS WITH NOTES / FAIL contract is preserved and the alignment finding folds into it.

## Impact

- **Reviewer definitions across all plugin surfaces**: Claude Code plugin agents, the standalone skill library (`public/skill/`), and the Codex, OpenClaw, Kiro, Pi, and dsh ports — each adapted to its host's spawn mechanism and tool-name prefix while sharing the same alignment contract.
- **Canonical Independent Review guidance** and the lifecycle skills (yolo / develop / review) that enumerate reviewer dimensions.
- **Baseline resolution reuses existing read APIs, entirely from the prompt** (`chorus_get_idea` for content, `chorus_get_elaboration` for decisions with `answeredBy.type`, `chorus_get_comments` for the Idea comment ledger with `author.type`). Each reviewer resolves the Idea from the entity under review: proposal → its `inputUuids[0]`; task → `chorus_get_task`, then its proposal's `inputUuids[0]`; code → the given `ideaUuid`. **No new MCP tool** and no database schema change — the human-baseline-vs-agent-audit split is enforced by the prompt rule, not by a service.
- **No change to enforcement plumbing**: "hard block" reuses the existing verdict → FAIL / reject path each reviewer already feeds; nothing new gates the workflow mechanically beyond what the reviewer verdict already drives.
