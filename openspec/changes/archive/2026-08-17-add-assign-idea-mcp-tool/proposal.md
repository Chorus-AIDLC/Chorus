# Add `chorus_pm_assign_idea` MCP tool + `chorus:orchestrate` skill

## Why

In the container idea `caf66e8d` (tech-sharing orchestration) a mechanism gap surfaced.
The theme owner's intent was: *Admin Claude controls the theme and directly assigns each
child idea to a specified agent (e.g. Codex) as its owner; the agent receives it and
advances it on the board; the owner verifies.* Today the platform cannot express "assign
an idea to another agent" **from an agent/MCP surface**:

- Idea ownership over MCP is only self-claim (`chorus_claim_idea`, caller-only,
  `open → elaborating`). A theme/PM owner agent cannot hand an idea to a *different* agent —
  it can only post a comment `@`-ing them and ask them to claim it themselves.
- The task side already has `chorus_pm_assign_task` (target agent + optional instance pin +
  wake). The idea side has no equivalent MCP tool.
- As a result child ideas stall in `open` with no assignee, the board shows no progress, and
  the actual work is carried by comments + git commits — contrary to the AI-DLC principle of
  *advancing on the board*.

Crucially, **the underlying capability already exists** — it is only missing an MCP surface.
The human UI's assign flow (`claimIdeaToAgentAction`) already calls the reassign-safe
`assignIdea()` service primitive and writes an `assigned` Activity that flows through the
`idea_claimed → task_assigned` autonomous wake to the assigned agent (resolving an
`agent_instance` to its owning agent, with the idea-session cwd upgrade). The
`idea-lifecycle-assignment` capability already specifies UI reassignment across any lifecycle
stage. This change exposes that same, already-governed path over MCP and adds one new
behavior the agent-initiated path needs: **the woken agent must be able to tell who assigned
it** (a human, or which agent).

## What Changes

1. **New MCP tool `chorus_pm_assign_idea`** — `(ideaUuid, assigneeType: "agent"|"user",
   assigneeUuid, instanceUuid?)`.
   - Gated at **`idea:admin`** (assigning ownership is a governance act; a `pm_agent`-preset
     agent must hand off to an `admin_agent`).
   - Supports an **agent** target (with optional `instanceUuid` pin) **and** a **user**
     target, mirroring the UI's `claimIdeaToAgentAction` / `claimIdeaToUserAction`.
   - **Reuses** the existing `assignIdea()` service primitive and the `assigned`-Activity wake
     path — no new status logic. Status side-effect is exactly today's: `open → elaborating`,
     any other status preserved (so an `elaborated`/completed idea can be assigned to backfill
     its owner without regressing its stage).
   - **Silently takes over** an existing assignment (single responsible owner converges).
   - Target-agent must hold `idea:write` (reuse the existing eligibility check); user target
     must be in the same company.
   - **Best-effort wake**: an agent target that is offline still gets the assignment persisted;
     the wake is a no-op until it reconnects (recoverable-trigger backfill applies). A user
     target gets the assignment + a notification, with no daemon wake.

2. **Rework the assignment wake — provenance + stage-correct guidance** — the woken agent's turn
   context conveys **who** assigned it (a human, or which agent) via the assignment Activity's
   `actorType`/`actorUuid`. The same wake body is also corrected: it currently tells the agent to
   `chorus_claim_idea`, which throws on an already-assigned idea and hard-fails on the
   elaborated-backfill case in scope here; the reworded prose instead tells the agent (already the
   assignee) to review and advance from the idea's current stage — continue elaboration while
   `elaborating`, author the proposal once `elaborated` — stopping at the human proposal / verify
   gates and never merging automatically.

3. **Docs** — add `chorus_pm_assign_idea` to `docs/MCP_TOOLS.md` and to the skill docs in the
   required plugin surfaces.

4. **New `chorus:orchestrate` skill** — a standalone multi-agent collaboration / orchestration
   playbook, referenced from the `/chorus` entry skill. It covers the several ways Chorus
   supports multi-agent collaboration — assigning ideas, assigning tasks, independent review
   (proposal / task / code reviewer subagents) — and how to pick a collaboration mode by
   scenario, keeping single-owner/concurrency discipline and the Reversed-Conversation gates
   (the owner still gatekeeps at proposal / verify, and never merges automatically).

## Capabilities

- **`idea-lifecycle-assignment`** (extended): add the MCP assign path and the assigner-provenance wake requirement.
- **`multi-agent-orchestration`** (new): the `chorus:orchestrate` skill exists, covers the collaboration modes, and is reachable from the entry skill.

## Impact

- **No database schema change** — reuses the polymorphic `assigneeType`/`assigneeUuid` pair
  and the existing wake pipeline.
- **Permission surface**: one new `idea:admin`-gated MCP tool; only admin-preset agents see or
  call it. Tool-visibility is driven by the effective permission set as usual.
- **Behavioral parity with the UI**: the MCP path reuses the same service primitive and wake,
  so the two surfaces stay consistent (the `idea-lifecycle-assignment` spec continues to hold).
- **Docs + skills**: `docs/MCP_TOOLS.md` and the skill surfaces gain the new tool; a new
  `orchestrate` skill and one entry-skill reference are added.
- **Out of scope**: no bulk "assign all children of a theme" API (per elaboration q7 — the
  orchestrate skill loops the primitive per child); no change to `chorus_claim_idea`.
