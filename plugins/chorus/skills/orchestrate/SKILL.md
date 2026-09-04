---
name: orchestrate
description: Multi-agent orchestration playbook — coordinate OTHER agents and humans across the AI-DLC lifecycle by delegating ideas and tasks, running independent reviewers, and gatekeeping at the Reversed-Conversation gates. (Codex port)
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.17.2"
  category: project-management
  mcp_server: chorus
---

# Orchestrate Skill

This skill is for an **orchestrator** (typically an Admin-preset agent) that coordinates *other* agents and humans across the AI-DLC lifecycle instead of doing all the work itself. The orchestrator decomposes work, hands each piece to a chosen owner, runs independent reviewers as quality gates, and gatekeeps the human-owned approval/verify gates — but never ships on its own.

It complements the other skills rather than replacing them:

- `$yolo` — **one** agent drives the whole pipeline solo. Orchestration is the opposite: **many** agents, each owning a piece, coordinated by you.
- `$idea`, `$proposal`, `$develop`, `$review`, `$quick-dev` — a single stage you execute yourself. Orchestration is the layer *above* those: you decide who runs each stage.

---

## When to use this skill

Use it when **more than one agent (or agent + human) will touch the work** and someone has to keep them coherent:

- You own a **theme / epic / container idea** that decomposes into several independent child ideas, and you want to hand each child to a specific worker (the motivating case: a theme owner gives one child to Codex, another to a Claude dev agent, another to a human).
- An approved proposal has a **task DAG** and you want several developer agents working the unblocked tasks in parallel waves.
- You need an **independent adversarial review** of someone else's proposal / task / feature before it advances.
- You are the responsible owner and must keep **one accountable assignee per idea** while work fans out.

Prerequisite: delegating ideas needs `idea:admin`; delegating tasks needs `proposal:write`. Run `chorus_checkin()` first to confirm your permission set.

---

## Delegation primitives

### Assign an idea — `chorus_pm_assign_idea` (`idea:admin`)

Hand a whole idea to a chosen agent or user. Parameters:

| Param | Meaning |
|-------|---------|
| `ideaUuid` | The idea to delegate |
| `assigneeType` | `"agent"` or `"user"` |
| `assigneeUuid` | The chosen agent/user UUID (resolve names with `chorus_search_mentionables`) |
| `instanceUuid` | *(optional, agent targets only)* pin the work to one durable AgentInstance — the `(agent, host, cwd)` place — so wakes land where the code lives |

Behavior you must understand:

- **The assignee is woken and advances from the idea's *current* stage** — it does **NOT** re-claim. If the idea is `open` it moves to `elaborating`; any other status is preserved. The assignee picks up wherever the idea already is (elaboration, ready-for-proposal, etc.).
- **Agent targets must hold `idea:write`** (via a preset such as `pm_agent`/`admin_agent`, or an explicit permission) or the call is rejected. **User targets must be in your company.** `instanceUuid` is rejected for user targets.
- **Silent takeover.** Reassigning an already-owned idea simply moves ownership to the new assignee — there is one owner at a time, no confirmation prompt. Use this deliberately, not by accident.

### Assign a task — `chorus_pm_assign_task` (`proposal:write`)

Hand a single task to a developer agent. Parameters: `taskUuid`, `agentUuid` (must hold `task:write`), optional `instanceUuid`. The task must be `open` or `assigned`. The assignee is woken to execute it. Use this to distribute the tasks of an approved proposal.

### Derive child ideas and fan them out

The theme-decomposition case, end to end:

1. Read the container/theme idea and its context (`chorus_get_idea`, `chorus_get_documents`, `chorus_get_comments`).
2. For each independent slice, create a child idea with `chorus_pm_create_idea` (link it back to the parent in the body / via `references[]`).
3. Assign each child to a distinct owner with `chorus_pm_assign_idea` — e.g. one child to Codex, one to a Claude dev agent, one to a human. Each child now has its **own single owner** and advances independently.
4. @mention each assignee and the theme owner so the delegation is visible.

---

## Independent review as an adversarial gate

Chorus ships three read-only reviewer skills. As orchestrator you run them at the three gates and act on the verdict — this is your primary quality lever when you are not writing the code yourself.

| Reviewer | Run after | Reviews |
|----------|-----------|---------|
| `chorus-proposal-reviewer` | a proposal is submitted | proposal draft quality (VERDICT on the proposal) |
| `chorus-task-reviewer` | a task is submitted for verify | one task vs its acceptance criteria (VERDICT on the task) |
| `chorus-code-reviewer` | the idea's last task is verified | the idea's **aggregate** code change — the final ship gateway (VERDICT on the idea) |

Spawn a review sub-agent with `spawn_agent({items:[{type:"skill", path:"chorus:chorus-task-reviewer"}, {type:"text", text:"Review task <task-uuid> and post VERDICT."}]})`. Each posts exactly one `VERDICT: PASS` / `PASS WITH NOTES` / `FAIL` comment. Verdicts are **advisory** — they do not auto-approve, auto-verify, or hard-block; you read the BLOCKERs and decide. A `FAIL` means route the BLOCKERs back for a fix before advancing (for a code-review FAIL, add fix tasks to the *approved* proposal via `$quick-dev` and re-run once they are `done`). See `$review` for the full pattern and lifecycle rules.

---

## Choosing a collaboration mode

Pick the lightest mode that fits the shape of the work:

| Mode | Use when | How you run it |
|------|----------|----------------|
| **Single-owner drives one idea** | The work is one coherent feature | Assign the idea once (`chorus_pm_assign_idea`); that owner runs idea → proposal → tasks; you gatekeep the gates |
| **Fan-out children to N agents** | A theme decomposes into independent slices | Derive child ideas, assign each to a distinct owner; children run in parallel, each single-owner |
| **Parallel task waves** | One approved proposal with a task DAG | Assign the currently-unblocked tasks (`chorus_pm_assign_task`) to several dev agents; as tasks reach `done`, assign the next wave |
| **Review-only** | Work is already produced elsewhere | Spawn the relevant reviewer, read the VERDICT, and gatekeep — no new delegation |

Guidance: start narrow. If a single owner can hold the whole feature in their head, prefer **single-owner** — coordination overhead is not free. Reach for **fan-out** only when slices are genuinely independent (separate scope, separable elaboration). Use **parallel task waves** only after a proposal is approved and its DAG is real; respect dependencies — `to_verify` does **not** unblock downstream, only `done` does.

---

## Single-owner & concurrency discipline

- **One responsible assignee per idea at a time.** This mirrors the daemon's single-owner semantics: the idea is the authoritative pin root, and its owner's proposals/tasks/wakes inherit that identity. Don't leave an idea ambiguously "owned by the team."
- **Don't race duplicate sessions on the same work.** Two daemon sessions (or two agents) driving the same idea/task will collide on status transitions and produce conflicting wakes. Assign, then let one owner run.
- **Pin with `instanceUuid` when the work is tied to a place.** If a child idea's code lives on a specific host/cwd, pin the assignment to that AgentInstance so every downstream wake lands there instead of a random daemon.

---

## Reversed-Conversation gates (you never auto-ship)

Chorus is **AI proposes, humans verify**. As orchestrator you enforce that, you do not bypass it:

- **Elaboration gate (gateway resolve/skip).** When a child idea you assigned to another agent has its elaboration answered, you can close the elaboration gate yourself via `chorus_pm_validate_elaboration` (or `chorus_pm_skip_elaboration` for a trivially clear idea) even though you are not the assignee — holding `idea:admin` is enough. This is the MCP parity of the UI Verify-Elaborate: it wakes the **assignee** agent to write the proposal. You gatekeep the gate; the assignee still authors the proposal (Reversed-Conversation preserved).
- **Proposal gate.** When a delegated owner submits a proposal, STOP. Run the proposal reviewer, then hand the approve/reject decision to the human owner. Do not self-approve just because you *can* (`proposal:admin`).
- **Verify gate.** When a task reaches `to_verify`, STOP. Run the task reviewer, then let the human verify. Permission to verify is not authorization to rubber-stamp your own coordinated work.
- **Never merge or push.** The orchestrator drives work up to "PR ready" and hands it back to the human — it does not merge, push, or otherwise ship autonomously.

@mention the owner at each gate so the handoff is explicit and auditable.

---

## Derive a child idea vs add a task vs assign directly

| Do this | When |
|---------|------|
| **Derive a new child idea** (`chorus_pm_create_idea` + assign) | The slice is genuinely separate scope that deserves its own elaboration, proposal, and owner — a theme decomposition, or a parallelizable sub-feature. |
| **Add a task to an approved proposal** (`chorus_create_tasks` with `proposalUuid`) | The work is a discrete unit of the **same** feature that already has a proposal — e.g. code-review fix tasks, or a follow-up step in an existing DAG. |
| **Assign the existing idea/task directly** (`chorus_pm_assign_idea` / `chorus_pm_assign_task`) | The work is already scoped and just needs a (different) owner or executor — reassignment, taking over a stalled idea, or distributing existing tasks. |

Rule of thumb: **new scope → child idea; same-proposal unit → task; only the owner changes → assign.**
