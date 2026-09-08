## Why

Chorus reviewers today verify **bottom-up**: the proposal-reviewer checks decomposition quality and AC alignment, the task-reviewer checks a task's implementation against its own AC, and the code-reviewer checks the aggregate change for correctness and convention drift. Nothing checks **top-down** whether the delivered work still serves the *original Idea's intent*.

Across the Idea → Proposal → Task → execution chain, every local step can look reasonable while the aggregate silently drifts from what the user actually asked for: scope creep (extra work never requested), requirement loss (something the Idea explicitly asked for is quietly dropped or shrunk), or semantic drift (the code passes its AC but misses the point). By the time drift is visible it is already cemented. We want a **first-principles alignment check** that pins every review gate back to the original intent and catches drift before it hardens.

## What Changes

- Add a **first-principles intent-alignment** dimension to the **three existing reviewers** (proposal-reviewer, task-reviewer, code-reviewer) — **no new reviewer agent**.
- Define the **anchor** (authoritative statement of original intent) as: the **directly-attached Idea's content** (`directIdeaUuid` — the Idea the work serves, never an ancestor theme) + its **resolved elaboration decisions** + the **comments on that Idea**. This anchor doubles as the ledger of *authorized* scope evolution.
- Each reviewer **resolves the anchor** from whatever entity it is reviewing (proposal → idea, task → proposal → idea, idea directly) and compares the artifact under review against it for **three drift types**: scope creep, requirement loss / shrink, and semantic drift.
- Detected drift is a **hard blocker** (contributes a `BLOCKER` → `FAIL` / reject), **except** when the deviation is traceable to a **human-originated** authorized scope change recorded in the anchor (a **human-authored** Idea comment or a **human-answered** elaboration entry), or a **human explicitly overrides** at the gate — an agent's own comment never authorizes, so a drifting agent cannot self-clear. Authorized, human-documented evolution is *not* drift.
- Output stays a **VERDICT comment** on the reviewed entity (no separate report artifact) — the alignment result is one clearly-labeled section of the existing verdict, not a new deliverable.
- Implemented as **one compact, shared alignment-check snippet** reused by all three reviewers across every plugin surface, so three separate prompts do not each balloon.

## Capabilities

### New Capabilities

- `first-principles-alignment-review`: the shared intent-alignment review dimension — anchor resolution, the three-way drift taxonomy, hard-block-with-escape-hatch verdict semantics, the compact shared snippet, and multi-surface parity — layered onto the proposal-, task-, and code-reviewer.

### Modified Capabilities

- (none) — the alignment dimension is **additive**. Existing reviewer capabilities (`code-review-gateway`, the bundled proposal-/task-reviewer agents) are referenced, not respecified; their existing PASS / PASS WITH NOTES / FAIL contract is preserved and the alignment finding folds into it.

## Impact

- **Reviewer definitions across all plugin surfaces**: Claude Code plugin agents, the standalone skill library (`public/skill/`), and the Codex, OpenClaw, Kiro, Pi, and dsh ports — each adapted to its host's spawn mechanism and tool-name prefix while sharing the same alignment contract.
- **Canonical Independent Review guidance** and the lifecycle skills (yolo / develop / review) that enumerate reviewer dimensions.
- **Anchor resolution reuses existing read APIs** (`chorus_get_idea` for content, `chorus_get_elaboration` for decisions, `chorus_get_comments` for the Idea ledger, plus existing root-idea resolution to walk proposal/task → idea). No database schema change. No new MCP tool unless anchor resolution proves not reachable with the current surface — decided in `design.md`.
- **No change to enforcement plumbing**: "hard block" reuses the existing verdict → FAIL / reject path each reviewer already feeds; nothing new gates the workflow mechanically beyond what the reviewer verdict already drives.
