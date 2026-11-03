---
name: orchestrate
description: Multi-agent orchestration playbook — coordinate OTHER agents and humans across the AI-DLC lifecycle by delegating ideas and tasks, running independent reviewers, and gatekeeping at the Reversed-Conversation gates.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.3"
  category: project-management
  mcp_server: chorus
---

# Orchestrate Skill

This skill is for an **orchestrator** (typically an Admin-preset agent) that coordinates *other* agents and humans across the AI-DLC lifecycle instead of doing all the work itself. The orchestrator decomposes work, hands each piece to a chosen owner, runs independent reviewers as quality gates, and gatekeeps the human-owned approval/verify gates — but never ships on its own.

It complements the other skills rather than replacing them:

- `/yolo` — **one** agent drives the whole pipeline solo. (On a Team-managed Idea, yolo still routes product/development/review work to the Team — see below.) Orchestration is the opposite: **many** agents, each owning a piece, coordinated by you.
- `/idea`, `/proposal`, `/develop`, `/review`, `/quick-dev` — a single stage you execute yourself. Orchestration is the layer *above* those: you decide who runs each stage.

---

## Session scope for CLI daemon wakes

These rules apply only to wakes handled by an updated Chorus CLI daemon that honors the server-delivered SSE `sessionId`. They do not upgrade OpenClaw, Hermes, or dsh-native session routing; those native runtimes retain their existing behavior. Older daemons may fall back to legacy entity/Idea routing, so do not assume task/review isolation there.

- **Task work:** `task:<uuid>` is a task-scoped session with no Idea-session memory. Fetch the current task, its proposal and documents, and its direct Idea from Chorus before starting work; do not rely on the orchestrator's conversation. Sibling tasks of the same Idea can run concurrently for one agent and may share the working directory. Before editing when siblings share the cwd, work in your own git worktree; the daemon does not create one for you.
- **Review work:** a Team review request uses `review:<type>:<uuid>`, where type is `proposal`, `task`, or `idea` (a code review targets the Idea). It is a read-only review-scoped session with no development-session memory. Fetch the target and current reviewer protocol/context before reviewing; do not implement fixes or perform lifecycle writes. A re-review by the same reviewer of the same target resumes the same review session, preserving review history rather than development memory.
- **Orchestration:** elaboration, proposal work, Start Development, Yolo, and orchestration stay in the bare direct-Idea UUID session (`<directIdeaUuid>`, not `idea:<uuid>`). An orchestrator also assigned a task uses `task:<uuid>` for task-start/reopen work, but orchestration replies and handoffs stay in the Idea session.

These are backend conversation and wake-queue anchors, not the Chorus Agent Session `sessionUuid` used by session check-in tools. Session separation does not isolate files or change the host's existing session check-in lifecycle.

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

## Routing work through your Team (Team-managed Ideas)

If `chorus_get_idea_team_context({ideaUuid})` shows `managed: true` and you are the `orchestrator`, the Team decides **who does each step**; you do the routing:

- **Product work** — `chorus_recommend_team_agent({ideaUuid, role: "product"})`, then `chorus_delegate_team_product({ideaUuid, agentUuid})`. The delegate elaborates and creates/submits the proposal; you stay the Idea's assignee. If the recommendation is **yourself** (offline fallback), do the product work yourself — don't delegate to yourself.
- **Development** — for each ready task, `chorus_recommend_team_agent({ideaUuid, role: "development", taskUuid})`, follow its `decision` (`recommended` → assign; `lead_decision` → you choose among `candidates`; `manual` / `paused` → ask a human), then assign the task normally. If the recommendation is **yourself**, claim and start the task in the same turn — self-assignment sends no wake.
- **Reviews** — follow [Team review routing](#team-review-routing), including review-role recommendations and same-turn self-review dispatch.
- **Handoffs** — you are woken when a proposal is submitted or approved and when a task is submitted for verification; re-read the Team context, then route the next step.
- YOLO only decides whether approvals still need a human; it does not change who does the work. With YOLO you approve/verify yourself (existing permissions) and keep routing to the Team; without YOLO the proposal gate below still applies. Unmanaged Ideas keep the workflow below unchanged.
- Don't @mention another agent just to acknowledge a handoff — @mention only when they need to act.

## Team review routing

This is the shared protocol for **active Team-managed Ideas**. It takes precedence over generic sub-agent reviewer reminders and the unmanaged review flow below. Only the Idea's **current active orchestrator** dispatches reviews and coordinates the gates; a developer or product delegate submits work and leaves routing to that orchestrator.

### Resolve authority and select the reviewer

Read the original entity and resolve every source Idea through proposal inputs, including document-input ancestry. Fetch `chorus_get_idea_team_context({ideaUuid})` for each source Idea before acting, and re-read before dispatch, approval or verification. Missing or ambiguous ancestry/context means stop; `paused` means stop automated Team actions and request explicit human repair. Never claim or reassign an Idea to take over a review. Confirmed unmanaged work retains the legacy flow.

The current orchestrator calls the recommendation tool for the review target:

```js
chorus_recommend_team_agent({ideaUuid, role: "review", proposalUuid}) // proposal review
chorus_recommend_team_agent({ideaUuid, role: "review", taskUuid})     // task review
chorus_recommend_team_agent({ideaUuid, role: "review"})               // whole-Idea code review
```

Supply at most one target. The task/proposal must belong to the source Idea. Selection is eligible → online → latest valid agent-authored target VERDICT affinity → minimum `activeCount`; equal candidates return `lead_decision`, which the current orchestrator resolves among the returned candidates, never arbitrarily. Nobody is excluded: the author, developer and orchestrator may be recommended. `rereview_affinity` keeps the same reviewer, including an orchestrator whose sub-agent reviewed earlier. No eligible online reviewer returns the orchestrator with `review_orchestrator_subagent_fallback` and empty candidates — unlike product/development's manual fallback. Honor `manual` and `paused`; recommendation alone grants no action permissions.

### Dispatch and self-submission

- **Recommendation is yourself:** run the matching `chorus:proposal-reviewer` / `chorus:task-reviewer` / `chorus:code-reviewer` as a fresh read-only sub-agent **in the same turn**, with the target UUID and round. A fresh sub-agent counts as the memory-free session; do not wait for a self-wake.
- **Another agent:** post **one** `chorus_add_comment` on the review target. The sender MUST include `Team review request — <kind>, round N` (kind is `proposal`, `task` or `code`; N is the current review round), the target UUID, the matching local reviewer protocol location from the list below, exactly one reviewer @mention, and the expected PASS / PASS WITH NOTES and FAIL recipient names/UUIDs from the table below (not mentions). Resolve these values from current context before sending; do not omit them. Then **end the turn**; do not poll for a reply. There is no server-direct reviewer wake.
- **Request/forwarding format:** never start a line with `VERDICT:` in a review request or a forwarded finding. Use prose such as `Reviewer result: FAIL` and link the original comment instead; only the actual reviewer verdict may create affinity.
- **Self-submission:** immediately after the orchestrator itself calls `chorus_pm_submit_proposal` or `chorus_submit_for_verify`, recommend and dispatch the review in that turn. The server skips waking the submitting actor.
- **Last-task check:** after any task submission, enumerate **all tasks across every proposal whose source Ideas include this Idea**, including document-input proposals; read all pages. When every task is `to_verify`, `done` or `closed`, also start the **whole-Idea review in parallel with task reviews**, not after the last verification. Read the Idea comments first and avoid a duplicate whole-Idea review request/dispatch for the current round. Prepare both task and aggregate dispatches before ending a remote-review submission turn. If a task review later needs fixes, the aggregate PASS does not clear those fixes or their task gates.

### Local reviewer protocols

Use the matching installed protocol for the receiving host; paths below are relative to this skill. Include that location in the request.

- **proposal:** [proposal reviewer protocol](../../agents/proposal-reviewer.md).
- **task:** [task reviewer protocol](../../agents/task-reviewer.md).
- **code:** [code reviewer protocol](../../agents/code-reviewer.md).

### Receiver bootstrap

Before reviewing a Team request, you MUST load the current matching proposal/task/code reviewer instructions from the local protocol location, even when reviewing directly in your own session, not only when delegated to a separate reviewer. A wake or mention is not a substitute for loading those instructions. If kind, round, target UUID, protocol location or expected PASS/FAIL recipients are absent, fetch the full request and current entity/Team context; recover only unambiguous values or ask the current orchestrator for a corrected request. Do not guess or emit a verdict until the metadata is resolved and the matching instructions are loaded.

### VERDICT routing and reviewer duty

A woken Team reviewer stays read-only and posts **exactly one VERDICT comment per round** on the reviewed entity, with **exactly one @mention**, of the actor who must act next:

| Review target | PASS / PASS WITH NOTES | FAIL |
|---------------|-----------------------|------|
| Proposal | Current Idea orchestrator | Product delegate (`productAgentUuid`), else orchestrator |
| Task | Current Idea orchestrator (to verify) | Task developer (logical assignee, not instance UUID) |
| Whole Idea | Current Idea orchestrator | Current Idea orchestrator |

Re-read the entity/Team context before posting so a stale request does not route to a former assignee. If authority or the routed recipient cannot be resolved, stop and request human repair rather than inventing a recipient. The reviewer never rejects, reopens, approves, verifies or creates tasks — those decisions belong to the authorized orchestrator or human. Put the routed mention before the final literal `VERDICT: PASS`, `VERDICT: PASS WITH NOTES` or `VERDICT: FAIL` line.

The actual verdict MUST be exactly one plain unformatted line starting at column 1: `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`. No bold, backticks, bullets, quotes, fences or extra verdict line in the posted result; the backticks here only delimit documentation examples. Place exactly one actionable routed @mention before that final line, using the recipient table, and re-read current entity/Team context before posting. Remain read-only; no lifecycle writes.

### Gates, fixes and rounds

- **Task verification:** only the current active orchestrator, with existing permissions and required AC passed, verifies after a **current-round PASS / PASS WITH NOTES** on that task. An older verdict or silence is not a PASS.
- **Proposal approval:** under **server-confirmed human-requested YOLO for this exact Idea**, the current orchestrator may approve with existing permissions only after a **current-round PASS / PASS WITH NOTES**. Without YOLO, after PASS the orchestrator posts **one comment @mentioning the human owner to request approval**, then ends the turn; it does **not** approve. Respect every linked Idea's gate and generation fence; YOLO changes approval, not Team review routing.
- **Whole-Idea gate:** PASS / PASS WITH NOTES gates only the **completion report and PR**, not individual task verification. On FAIL, the orchestrator creates tracked fix tasks via `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** (never standalone), or reopens affected tasks with existing authority. Route fixes through development, AC self-check, task review and verification, then re-run the aggregate review. A failed or cancelled fix stops automation and escalates. No review verdict authorizes push, merge or deployment.
- **Re-review:** recommend again after resubmission; use the same reviewer through `rereview_affinity` when available, with stable finding IDs. Round 2+ acknowledges every prior finding as `fixed`, `still-open` or `not-verifiable`, citing targeted re-reads/re-runs; never rename IDs or silently close findings.
- **Batching:** list all findings in one review pass/comment (within the existing reviewer finding rules); forward the batch in **one** orchestrator comment, not one mention per finding.
- **Round cap:** at most **3 rounds per entity**. If unresolved after round 3, post a comment @mentioning the human owner and **stop automation** for that entity. Never start round 4, self-review around an escalation, or treat a missing verdict as success.
- **No acknowledgement mentions:** @mention only an actor who must act on a question, decision or work handoff. Never reply `received` or @mention just to acknowledge. After a task PASS the developer needs no duplicate PASS-to-verify handoff: the VERDICT already @mentions the orchestrator.

## Independent review as an adversarial gate (unmanaged Ideas)

Chorus ships three read-only reviewer sub-agents. As orchestrator you spawn them at the three gates and act on the verdict — this is your primary quality lever when you are not writing the code yourself.

| Reviewer agent | Spawn after | Reviews |
|----------------|-------------|---------|
| `chorus:proposal-reviewer` | a proposal is submitted | proposal draft quality (VERDICT on the proposal) |
| `chorus:task-reviewer` | a task is submitted for verify | one task vs its acceptance criteria (VERDICT on the task) |
| `chorus:code-reviewer` | the idea's last task is verified | the idea's **aggregate** code change — the final ship gateway (VERDICT on the idea) |

Each posts exactly one `VERDICT: PASS` / `PASS WITH NOTES` / `FAIL` comment. Verdicts are **advisory** — they do not auto-approve, auto-verify, or hard-block; you read the BLOCKERs and decide. A `FAIL` means route the BLOCKERs back for a fix before advancing (for a code-review FAIL, add fix tasks to the *approved* proposal via `/quick-dev` and re-run once they are `done`). See `/review` and the plugin's Review Agent Configuration for the full pattern.

**First-principles alignment (a stage-tailored instruction in each reviewer).** Every one of the three reviewers also checks, top-down, that the work still serves the *original Idea's intent* — it resolves the Idea from the entity under review, reads it via the existing `chorus_get_idea` + `chorus_get_elaboration` + `chorus_get_comments`, builds the intent baseline from **human-authored** content only, and flags scope creep, requirement loss/shrink, or semantic drift. Unauthorized drift is a **BLOCKER → FAIL / reject**, downgraded to a NOTE only when traceable to a **human-originated** authorization (a human-authored Idea comment, a human-answered elaboration entry, or an explicit human override at the gate) — an agent's own comment never authorizes, so a drifting agent cannot self-clear. As orchestrator, route an alignment FAIL back for a fix like any other BLOCKER, or record the human override at the gate.

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

## Replying to the agent who woke you (advisory)

When an agent wakes a peer on a shared idea or task — an orchestrator dispatching a worker, or any agent `@mention`-ing another — the wake surfaces the **waker's live session anchor**: a note naming the waking agent and telling the woken peer that the waker has an open conversation on this idea. If you are the woken peer, **reply on the same idea/task resource** (comment there rather than opening a brand-new session) and your reply lands back in the waker's existing live session, keeping the collaboration on one thread instead of scattering into a fresh one.

This is **advisory, not routing.** There is no automatic server subscription and nothing is force-delivered — replying on the shared resource is simply *where a reply lands* (via the existing return path), not a guaranteed channel. When the waker's origin is **offline** at wake time, no live anchor is surfaced and the exchange degrades to **notify-only**: the reply reaches the waker as an ordinary notification it picks up on its next turn. Only idea/theme-anchored wakes carry this anchor; ad-hoc wakes with no shared idea do not.

---

## Reversed-Conversation gates (you never auto-ship)

Chorus is **AI proposes, humans verify**. As orchestrator you enforce that, you do not bypass it:

- **Elaboration gate (gateway resolve/skip).** When a child idea you assigned to another agent has its elaboration answered, you can close the elaboration gate yourself via `chorus_pm_validate_elaboration` (or `chorus_pm_skip_elaboration` for a trivially clear idea) even though you are not the assignee — holding `idea:admin` is enough. This is the MCP parity of the UI Verify-Elaborate: it wakes the **assignee** agent to write the proposal. You gatekeep the gate; the assignee still authors the proposal (Reversed-Conversation preserved).
- **Proposal gate.** For managed work follow [Team review routing](#team-review-routing): current-round PASS first; human approval unless the exact Idea has human-requested YOLO. For unmanaged work, run the proposal reviewer and hand the approve/reject decision to the human owner unless human-requested YOLO applies. Do not self-approve just because you *can* (`proposal:admin`).
- **Verify gate.** On a Team-managed Idea, only its current active orchestrator verifies with existing permissions after a current-round task PASS / PASS WITH NOTES per [Team review routing](#team-review-routing). For unmanaged work, when a task reaches `to_verify`, run the task reviewer, then let the human verify. Permission to verify is not authorization to rubber-stamp your own coordinated work.
- **Never merge or push.** The orchestrator drives work up to "PR ready" and hands it back to the human — it does not merge, push, or otherwise ship autonomously.

@mention the owner only when a human decision is needed; use the Team VERDICT routing table for managed review handoffs. Never send an acknowledgement-only mention.

---

## Derive a child idea vs add a task vs assign directly

| Do this | When |
|---------|------|
| **Derive a new child idea** (`chorus_pm_create_idea` + assign) | The slice is genuinely separate scope that deserves its own elaboration, proposal, and owner — a theme decomposition, or a parallelizable sub-feature. |
| **Add a task to an approved proposal** (`chorus_create_tasks` with `proposalUuid`) | The work is a discrete unit of the **same** feature that already has a proposal — e.g. code-review fix tasks, or a follow-up step in an existing DAG. |
| **Assign the existing idea/task directly** (`chorus_pm_assign_idea` / `chorus_pm_assign_task`) | The work is already scoped and just needs a (different) owner or executor — reassignment, taking over a stalled idea, or distributing existing tasks. |

Rule of thumb: **new scope → child idea; same-proposal unit → task; only the owner changes → assign.**
