## Context

Agent Team ③ (#644) derives Team management at read time (`src/services/idea-team.service.ts`). `recommendIdeaTeamRole(auth, ideaUuid, role, taskUuid?)` serves `product` and `development`:

- eligible → online;
- offline orchestrator fallback (only if the orchestrator is online and eligible for the role) → `manual: role_offline`;
- empty role → `manual: role_empty_or_ineligible`;
- development reopen affinity → minimum load → dependency affinity → `lead_decision` on ties.

`notifyIdeaTeamHandoff` (`src/services/notification-listener.ts`) wakes the orchestrator with a `mentioned` notification on `proposal:submitted`, `proposal:approved` and `task:submitted` / `status_changed → to_verify`.

The review role already exists in `AGENT_TEAM_ROLE_DEFINITIONS` (`src/lib/agent-team-roles.ts`) with read-only minimum permissions, but nothing routes to it.

Decisions come from elaboration rounds 1–3 on Idea 3a28b199 (answered by the owner).

## Goals / Non-Goals

**Goals**
- Route all three review kinds (proposal, task, whole Idea) to the Team review role through the orchestrator.
- Route each VERDICT to the actor that must act, never stall a review, and eliminate acknowledgement-only mentions.

**Non-Goals**
- A new wake kind or server-direct reviewer wake.
- Server-side enforcement of gates, reviewer read-only access or mention debounce.
- Schema changes.
- Any change to unmanaged Ideas.

## Decisions

### D1 — Review recommendation

`IdeaTeamRoutingRole` becomes `"product" | "development" | "review"`. The MCP schema gains `role: "review"` and an optional `proposalUuid`.

The review target is resolved as follows:
1. `taskUuid` set → that task. It must belong to the Idea (the existing check).
2. `proposalUuid` set → that proposal. It must list the Idea among its source Ideas (`proposalSourceIdeas`), otherwise 403 `Proposal does not belong to this Idea`.
3. Neither set → the Idea itself (whole-change review).
4. Both set → 400.

For `role: "review"`:
1. Unmanaged → `manual: unmanaged`. Paused → `paused` (unchanged).
2. `eligible = roles.review.filter(eligible)`. `online = eligible.filter(online)`.
3. If `online` is empty — whether the role is empty, all members are ineligible or all are offline — return `recommended`, `agentUuid = orchestratorUuid`, `reason: "review_orchestrator_subagent_fallback"`, `candidates: []`. This deliberately differs from product/development (q5: fall back to the sub-agent, never stop). The orchestrator always holds the read permissions, so no eligibility check is needed. The orchestrator's own liveness is irrelevant because it is the caller.
4. **Re-review affinity** (q8):
   - Find the latest comment on the target that has a line matching `^VERDICT: (PASS WITH NOTES|PASS|FAIL)\b` (multiline) and whose author is an agent.
   - Review-request and forwarding comments MUST NOT start a line with `VERDICT:` (D3), so they never count as a verdict.
   - If that author is in `online`, return `recommended`, `reason: "rereview_affinity"`.
   - If that author is the orchestrator and not in `online`, return the orchestrator with `reason: "rereview_affinity"` too, because the orchestrator's own sub-agent reviewed earlier.
5. Otherwise take the minimum `activeCount`. A single candidate → `recommended: minimum_load`; a tie → `lead_decision: equal_candidates`.
6. **No exclusions** (q4): the orchestrator, the proposal author and the task developer remain eligible.

The development-only branches (reopen affinity and dependency affinity) are untouched.

### D2 — Handoff wording

The `TEAM_HANDOFF_LABELS` text and the message suffix are extended:

- **`proposal:submitted`:** "route the proposal review via chorus_recommend_team_agent({ideaUuid, role:'review', proposalUuid})". The message names the approval rule: a human approves, unless the Idea is YOLO, in which case approval needs a PASS.
- **`task:submitted`:** "route the task review via role:'review' with taskUuid; verify only after a PASS VERDICT".
- **`last_task_submitted`** — a new label, used when every other task of the Idea is in `to_verify`, `done` or `closed`: "also start the whole-Idea code review via role:'review' without a target".
  - The Idea's tasks are the tasks of every proposal whose source Ideas include the Idea. Code-review fix tasks are created with `proposalUuid` set to the approved proposal (the yolo / quick-dev convention), so they are in scope too, and a second whole-Idea review round is triggered when they are submitted.
  - The check is one `task.count` query with `proposalUuid in [...]`, `status notIn [to_verify, done, closed]` and `uuid != task`.
  - It runs only when a managed orchestrator exists.
- **Self-submitted entities.** The handoff is skipped when the orchestrator itself is the actor; that behaviour is unchanged, because the orchestrator is already mid-turn. D3 makes the orchestrator route the review in the same turn after it submits a proposal or a task itself, including the last-task check.

The delivery channel stays `mentioned`, so CLI, OpenClaw and Hermes clients need no changes (q1 option b; no TURN_TRIGGERS change).

### D3 — Review protocol (skills and reviewer definitions)

This protocol is enforced by prompts only (q7 a, q9 a). It is documented once in the orchestrate skill and referenced from review, yolo and chorus. The three reviewer definitions gain a short "Team reviewer" section.

**Dispatch.**
- If the recommendation is `self`, run the matching sub-agent reviewer in the same turn. The sub-agent is the memory-free session (r2q1 a).
- If it is another agent, post one comment on the target with "Team review request — <kind>, round N", the reviewer @mention, and the expected @mention target for each verdict. Then end the turn.

**Self-submission.** After the orchestrator calls `chorus_pm_submit_proposal` or `chorus_submit_for_verify` itself, it routes the review in the same turn: recommend, then dispatch. After a task submission, it also checks whether every task of the Idea is now `to_verify`, `done` or `closed`, and if so starts the whole-Idea review.

**VERDICT @mention target** (r2q2 c, r3q1 c, r3q2 a). Route to whoever must act next:
- Proposal FAIL → its author: `productAgentUuid ?? orchestrator`, who revises.
- Proposal PASS / PASS WITH NOTES → orchestrator, which approves under YOLO or @mentions the human owner to request approval. With no delegate, the author and the orchestrator are the same agent, so r3q2 a holds literally. With a delegate, the delegate has nothing to do after a PASS, so routing it there would stall approval; the PASS goes to the orchestrator instead, which applies the same act-based split as r3q1 c.
- Task: PASS / PASS WITH NOTES → orchestrator; FAIL → the task's developer, i.e. its logical assignee.
- Whole Idea: orchestrator.

The reviewer writes exactly one @mention, in the VERDICT, and nothing else.

**Gates** (q3 a, r2q3 b, r2q4 a):
- Task verify needs the current-round PASS.
- A YOLO proposal approve needs a PASS.
- Whole-Idea PASS gates `chorus_create_report` and the PR; FAIL → fix tasks created with `chorus_create_tasks` and `proposalUuid` set to the approved proposal (required, so the last-task check sees them), or reopen.

**Rounds:** the same reviewer re-reviews (affinity, D1), up to 3 rounds per entity, then a comment @mentions the human owner.

**Batching:** the reviewer lists all findings with stable IDs in one round; the orchestrator forwards them in one comment.

**Request format:** a review-request or forwarding comment never starts a line with `VERDICT:`.

**No acknowledgements:** never @mention someone only to acknowledge. The developer's PASS-to-verify handoff is not needed, because the PASS VERDICT already @mentions the orchestrator.

### D3b — Wake-prompt mention guidance (q7 a)

Every mention wake appends a "post a comment … with @mention of the sender" instruction:
- `mentionGuidance` in `cli/prompts.mjs`
- `buildMentionGuidance` in `packages/openclaw-plugin/src/event-router.ts`
- `_mention_guidance` in `packages/chorus-hermes/chorus/chorus_hermes/prompts.py`

This instruction directly produces acknowledgement-only round-trips. The guidance becomes conditional: @mention the sender only if they must act on your result (a question, a requested decision, a handoff of work). Never @mention only to acknowledge or say "received".

The change is wording only. It does not change the wake kind, routing or `TURN_TRIGGERS`. Existing prompt tests are updated to the new wording.

### D4 — Host parity

All hosts receive the same text (q10 a):
- `public/chorus-plugin`
- `plugins/chorus` (Codex/TRAE)
- `public/skill`
- `public/kiro-plugin`
- `packages/chorus-pi`
- `packages/openclaw-plugin`
- `packages/chorus-hermes`
- `packages/chorus-dsh`

Where a host has no sub-agent primitive, its existing "run the reviewer inline / reviewer skill" fallback counts as the self-review path.

## Risks / Trade-offs

- **Prompt-only gates can be skipped by a misbehaving agent.** The owner accepted this (q3 a, q9 a). Server enforcement can come later.
- **Affinity reads comment text (`VERDICT:`).** A human comment containing that string is ignored because the author must be an agent.
- **The wake-prompt wording change is global.** It applies to every mention wake, not only Team-managed ones. That is intended: the owner chose prompt-level no-ack (q7 a), and acknowledgement-only mentions are never desired.
- **Detecting the last task is a race.** If two tasks are submitted at the same moment, both handoffs may say "last task", and the orchestrator might start the whole review twice. Mitigation: the skill says to check for an existing whole-Idea review request of the current round before posting one.
- **Mention-woken reviewer turns may resume an older session for the same Idea.** Accepted. Findings and IDs live in comments, and the owner scoped the memory-free requirement to self-review (r2q1).
