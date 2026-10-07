---
name: idea
description: Chorus Idea workflow on Hermes — claim ideas, run elaboration rounds (asked in chat, or via @mention when Chorus wakes the gateway), and prepare for proposal creation.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.21.1"
  category: project-management
  mcp_server: chorus
---

# Idea Skill

This skill covers the **Ideation** stage of the AI-DLC workflow: claiming Ideas, running structured elaboration rounds to clarify requirements, and preparing for Proposal creation.

---

## Overview

Ideas are the starting point of the AI-DLC pipeline. Humans (or Admin agents) create Ideas describing what they need. The PM Agent claims an Idea, runs elaboration to clarify requirements, and then moves on to the proposal skill (`skill_view("chorus:proposal")`) to create a Proposal with document and task drafts.

**Idea status lifecycle (3 stored states):**

```
open --> elaborating --> elaborated
```

All post-elaboration progress (planning, building, verifying, done) is **derived** from the state of linked Proposals and Tasks. No agent should set Idea status directly beyond elaboration -- all transitions are side-effects of claiming, releasing, or completing elaboration.

---

## Tools

**Idea Management:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_create_idea` | Create a new idea in a project (on behalf of humans). Optional `parentUuid` derives a child idea from an existing same-project idea (single-parent lineage). |
| `chorus_edit_idea` | Edit an existing idea's title, description, and/or lineage parent. `parentUuid`: another same-project idea to reparent under, `null` to detach to top-level, omit to leave unchanged (cycle-checked + same-project). Single-parent **weak** lineage — a parent shows a read-only `+N derived` rollup but never blocks either idea's flow. Records an "edited" activity and signals presence. |
| `chorus_claim_idea` | Claim an open idea (open -> elaborating) |
| `chorus_release_idea` | Release a claimed idea (elaborating -> open) |
| `chorus_pm_assign_idea` | Assign an idea to an agent (must hold `idea:write`) or a user, on a human's behalf — the counterpart to `chorus_claim_idea` (self-claim). Silently takes over any existing assignee; an `open` idea moves to `elaborating`, any other status is preserved. Optional `instanceUuid` pins an **agent** assignment to a specific AgentInstance (agent-only) — but a project-fixed cwd target configured for the owner takes precedence and supplies the instance automatically, overriding `instanceUuid`. Assigning a **new** owner wakes it best-effort (offline still persists the assignment); re-assigning the same owner may update its pin/cwd but is wake-deduplicated. Assigning to a user notifies them with no daemon wake. Requires `idea:admin`. |
| `chorus_move_idea` | Move an Idea to a different Project. Cascade-migrates the Idea **and its full lineage subtree** (all descendant Ideas; the moved root is detached from any parent left behind), all linked Proposals (any status), all materialized Documents and Tasks, and all related Activities atomically. Comments, TaskDependency, AcceptanceCriterion, AgentSession, SessionTaskCheckin, Notification history, and Task assignees are NOT modified. Returns `moved: { ideas, proposals, documents, tasks, activities }` counts. Requires `idea:write` only — no project-level checks. |

**Requirements Elaboration:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_start_elaboration` | Generate an elaboration round (first, follow-up, or appended-after-resolution) |
| `chorus_pm_validate_elaboration` | Mark the whole elaboration complete (requires `idea:admin`; requires human confirmation first) — callable by the Idea's assignee, or by a non-assignee `idea:admin` caller acting as a resolve gateway (wakes the assignee) |
| `chorus_pm_skip_elaboration` | Skip elaboration for trivially clear Ideas |
| `chorus_answer_elaboration` | Submit answers for an elaboration round (`roundUuid` optional — auto-locates the active round) |
| `chorus_get_elaboration` | Get full elaboration state (rounds, questions, answers) |

**Shared tools** (checkin, query, comment, search, notifications): see the overview skill (`skill_view("chorus:chorus")`)

---

## Asking the human on Hermes

Hermes has no interactive question widget, so every human question in this skill goes through Chorus. First decide which mode the current turn is in:

- **Interactive mode** — a Hermes CLI/TUI session with the human typing to you in chat.
- **Gateway mode** — the turn was started by a Chorus wake (`hermes gateway`, platform `chorus`: idea assigned, elaboration answered, @mention, comment added), in the session keyed `idea:<ideaUuid>`; or, more generally, no human is reading the chat.

Then route each kind of question:

| Question kind | Interactive mode | Gateway mode |
|---|---|---|
| **Structured questions** (elaboration rounds) | Create the round with `chorus_pm_start_elaboration`, then list its questions in chat — numbered, lettered options, your recommended option marked. Record the replies with `chorus_answer_elaboration`. The human may answer in the Chorus UI instead; check `chorus_get_elaboration` before re-asking. | Create the round, then post **one** `chorus_add_comment` on the Idea that @mentions the owner and points to the pending round. **END THE TURN.** Do not poll. The gateway wakes you when the round is answered or the owner replies. |
| **Yes/no permission or confirmation** (brainstorm opt-in, permission to skip elaboration, confirming your understanding before resolving) | Ask in chat and wait for the reply. | Post a `chorus_add_comment` on the Idea that @mentions the owner and states the question; **END THE TURN**; act on the reply when woken. |

**Owner mention:** take the owner from the `## Checkin` block that the Chorus Hermes plugin's `pre_llm_call` check-in injected (or call `chorus_checkin()`; the owner is `agent.owner`), and write it as `@[Owner Name](user:<ownerUuid>)`. If needed, look it up with `chorus_search_mentionables({ query: "owner-name" })`.

**On wake:** successive wakes for one Idea share the `idea:<ideaUuid>` session, but context may have been compressed. Re-read `chorus_get_elaboration` and `chorus_get_comments` to recover where you were before continuing.

**Never answer on the human's behalf** (yolo mode, which self-answers by design, is the only exception).

---

## Tracker Research action: research-only entry

When the current instruction is an explicit Tracker Research action, route directly to the research skill (`skill_view("chorus:research")`, research-only contract) and the result-saving rules in Step 4.45. Check current authoritative development eligibility before executing. This branch bypasses the normal claim and elaboration sequence below: preserve the existing Idea, root session, pending questions, answers, resolution, proposal approval and task states. Save findings to the latest Idea body with real citations and report, then **return**. If development has begun, report the changed stage without researching or editing. Record impacts on approved scope as follow-up in the Idea; do not mutate locked proposals.

---

## Workflow

### Step 1: Check In

The Chorus Hermes plugin already ran `chorus_checkin` on the first turn of this session (and again after /reset or context compression) and injected the result as `## Checkin`. Call it again whenever you need fresh data:

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 2: Find Work

```
chorus_get_available_ideas({ projectUuid: "<project-uuid>" })
```

Or check existing assignments:

```
chorus_get_my_assignments()
```

In gateway mode the wake itself usually names the Idea (an idea-assigned notification); start from that Idea.

### Step 3: Claim an Idea

Claiming automatically transitions the Idea to `elaborating` status:

```
chorus_claim_idea({ ideaUuid: "<idea-uuid>" })
```

(Skip this when the Idea is already assigned to you, e.g. you were woken by an assignment.)

### Step 4: Gather Context

Before elaborating, understand the full picture:

1. **Read the idea in detail:**
   ```
   chorus_get_idea({ ideaUuid: "<idea-uuid>" })
   ```

2. **Read existing project documents** (for context, tech stack, conventions):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   chorus_get_document({ documentUuid: "<doc-uuid>" })
   ```

3. **Review past proposals** (to understand patterns and standards):
   ```
   chorus_get_proposals({ projectUuid: "<project-uuid>", status: "approved" })
   ```

4. **Check existing tasks** (to avoid duplication):
   ```
   chorus_list_tasks({ projectUuid: "<project-uuid>" })
   ```

5. **Read comments** on the idea for additional context:
   ```
   chorus_get_comments({ targetType: "idea", targetUuid: "<idea-uuid>" })
   ```

### Step 4.4: Attach External References

**Make attaching external references a reflex, not an afterthought.** While gathering context you will often surface external links that are *evidence* for this Idea — a precedent issue or PR, a reference implementation, official documentation, a paper or blog post. The moment you see one, attach it as a reference artifact. References are read back inline by `chorus_get_idea` / `chorus_get_proposal` / `chorus_get_task`, so they carry the "why" forward to whoever picks up the proposal or task next.

**Prefer attaching at creation time** via the inline `references[]` param on `chorus_pm_create_idea` (and later `chorus_pm_create_proposal` / `chorus_create_tasks`) rather than a post-hoc `chorus_add_reference`. Attaching at create means the evidence is present from the first read; use `chorus_add_reference` only when the link surfaces after the entity already exists.

**Pick the `type` that fits the link:**

| `type` | Use for |
|--------|---------|
| `docs` | Official documentation — framework / API / library reference |
| `repo` | A reference implementation or source repository |
| `issue_pr` | An issue or pull-request thread — precedent, prior art, the delivering PR |
| `paper_blog` | A paper or blog post — background or design rationale |

**Example** — a new localization Idea, attaching the precedent PR and the framework docs inline at creation:

```
chorus_pm_create_idea({
  projectUuid: "<project-uuid>",
  title: "Add Portuguese (pt) locale",
  content: "...",
  references: [
    { type: "issue_pr", url: "https://github.com/org/repo/pull/411",
      title: "PR #411 — prior locale work (precedent to mirror)" },
    { type: "docs", url: "https://next-intl.dev/docs/routing",
      title: "next-intl routing docs (locale registration)" }
  ]
})
```

### Step 4.45: Optional Lightweight Research

Before the first formal clarification round, delegate factual checks to the research skill (`skill_view("chorus:research")`, shared rules). Supply the Idea stage, focused question, current body and evidence, user intent and budget. This applies equally to conversational, form-created and MCP-created Ideas; it does not depend on a Checkbox or daemon flag. Follow the shared trigger/skip and re-entry rules. If the direction is still fuzzy, use the existing focusing/brainstorm choice first; once focused, apply these rules before synthesizing formal questions.

Consume useful findings by reusing existing References or attaching new sources with `chorus_add_reference` (the Idea already exists). Use its returned reference `uuid`, or read `chorus_get_idea().references[].uuid`; the Idea UUID is not an evidence UUID. Re-read the latest Idea body, merge facts and implications while preserving user text, and save with `chorus_edit_idea`, citing relevant statements as `[1](ref:<actual-reference-uuid>)`. Keep uncertainty explicit; empty/unavailable results do not need invented citations. Then continue the existing elaboration/decomposition flow and human gates. Returning from brainstorm consumes any returned findings here without searching again.

### Step 4.5: Brainstorm Mode (Optional Prelude)

If the Idea is fuzzy and you'd struggle to enumerate concrete multi-choice questions, offer the user a brainstorm prelude before structured elaboration. Ask **once**, as a yes/no question with two choices: `"Already clear, run structured elaboration"` and `"Brainstorm first to explore directions"`.

- **Interactive mode:** ask in chat, e.g. "This Idea is still fuzzy. (a) It's already clear, run structured elaboration, or (b) brainstorm first to explore directions?" and wait for the reply.
- **Gateway mode:** post one comment on the Idea and end the turn:
  ```
  chorus_add_comment({
    targetType: "idea",
    targetUuid: "<idea-uuid>",
    content: "@[Owner Name](user:<owner-uuid>) Before I elaborate this Idea: should I (a) run structured elaboration now — it's already clear — or (b) brainstorm first to explore directions? Reply a or b."
  })
  ```
  Act on the reply when the gateway wakes you. Do not start brainstorming or elaborating before the reply arrives.

- **"Already clear":** Skip to Step 5.
- **"Brainstorm first":** Load the brainstorm skill (`skill_view("chorus:brainstorm")`) and follow it. See that skill for the dialogue cadence (one question at a time — a chat question, or a single-question round in gateway mode) and synthesis rules — do NOT re-implement them here.

When the brainstorm skill returns, you own the lifecycle decision (the brainstorm skill deliberately leaves it to you):

- If the synthesized round answers cover everything → obtain human confirmation (Step 5, item 5 confirmation flow), then call `chorus_pm_validate_elaboration` to resolve the elaboration. (Resolve needs `idea:admin` — see the permission note in Step 5, item 6 if your key is `pm_agent`-preset; a non-assignee `idea:admin` caller can also resolve as a gateway, which wakes the assignee.)
- If gaps remain → call `chorus_pm_start_elaboration` again to open a structured Round 2. Pick the depth yourself — do NOT re-prompt the user about depth.

Either outcome ends Step 4.5; skip Step 5's first round (continue with the confirm/resolve loop of Step 5, items 3-6, for any Round 2).

### Step 5: Elaborate on the Idea

**Every Idea should go through elaboration.** Skip only when requirements are completely unambiguous (e.g., bug fix with clear steps). Elaboration improves Proposal quality and reduces rejection cycles.

#### Simple Ideas (skip elaboration)

You may skip elaboration, but **you MUST ask the user for permission first** before calling `chorus_pm_skip_elaboration`. Never skip on your own judgment alone.

- **Interactive mode:** ask in chat ("This looks trivially clear because <reason>. May I skip elaboration?") and wait for an explicit yes.
- **Gateway mode:** post a comment on the Idea that @mentions the owner, states why you think elaboration can be skipped, and asks for a yes/no; then END THE TURN. Skip only if the reply is an explicit yes; otherwise run elaboration.

Once permission is granted:

```
chorus_pm_skip_elaboration({
  ideaUuid: "<idea-uuid>",
  reason: "Bug fix with clear reproduction steps"
})
```

#### Standard/Complex Ideas (run elaboration)

> **Elaboration is a loop, not a straight line.** Steps 2–5 below are **one round**. Keep looping back to `chorus_pm_start_elaboration` (a new round) until every open question is settled, then resolve **once** in Step 6. You re-enter the loop whenever:
> - the answers to a round **derive new questions** or surface a contradiction/gap, **or**
> - at the resolve gate (Step 5d / Step 6) the **human raises a new concern or correction**.
>
> Each new round is just another `chorus_pm_start_elaboration` call — there is no separate "follow-up" flag, and you do not resolve until the loop is genuinely done. Round cap is 10.

1. **Determine depth** based on idea complexity:
   - `"minimal"` — 2-4 questions (small features, minor enhancements)
   - `"standard"` — 5-10 questions (typical new features)
   - `"comprehensive"` — 10-15 questions (large features, architectural changes)

2. **Create elaboration questions:**

   > **Note:** Do NOT include an "Other" option in your questions. The UI automatically adds a free-text "Other" option to every question.

   ```
   chorus_pm_start_elaboration({
     ideaUuid: "<idea-uuid>",
     depth: "standard",
     questions: [
       {
         id: "q1",
         text: "What user roles should have access to this feature?",
         category: "functional",
         options: [
           { id: "a", label: "All users" },
           { id: "b", label: "Admin only" },
           { id: "c", label: "Role-based (configurable)" }
         ]
       }
     ]
   })
   ```

3. **Present questions to the human — through Chorus, never as an unrecorded side conversation.** The round you just created is the record; how you reach the human depends on the mode:

   **Interactive mode** — list every question of the round in chat, numbered, with lettered options matching the option ids, and mark your recommended option:

   ```
   Elaboration round 1 (also visible in the Chorus elaboration panel):

   1. Which new locales should be prioritized for V1?  [scope]
      a) Japanese only — single locale for initial release (Recommended)
      b) Japanese + Korean — two East Asian locales
   2. ...

   Reply like "1a, 2c", or write your own answer for any question.
   ```

   After the human replies, map their choices back to option IDs and call `chorus_answer_elaboration`. If they wrote their own answer ("Other"), set `selectedOptionId: null` and `customText` to their input. If they say they answered in the Chorus UI, read `chorus_get_elaboration` instead of re-asking.

   **Gateway mode** — post one pointer comment, then end the turn:

   ```
   chorus_add_comment({
     targetType: "idea",
     targetUuid: "<idea-uuid>",
     content: "@[Owner Name](user:<owner-uuid>) Elaboration round 1 (<n> questions) is ready for you in the Idea's elaboration panel. Key open points: <one line>."
   })
   ```

   Do not poll. When the gateway wakes you (elaboration answered), read the answers with `chorus_get_elaboration` and continue with item 5. The human answering in the UI submits the answers, so skip item 4 in that case.

4. **Submit answers** (interactive mode, from the chat replies):
   ```
   chorus_answer_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     answers: [
       { questionId: "q1", selectedOptionId: "c", customText: null },
       { questionId: "q2", selectedOptionId: null, customText: "Custom hybrid approach" }
     ]
   })
   ```

   Answer format:
   - **Select an option**: `selectedOptionId: "a", customText: null`
   - **Select an option + add a note**: `selectedOptionId: "a", customText: "additional context"`
   - **Choose "Other" (free text)**: `selectedOptionId: null, customText: "your answer"` — customText is required when no option is selected

   > `roundUuid` is **optional** on `chorus_answer_elaboration`. Omit it and the service auto-locates the Idea's single active (`pending_answers`) round. Pass it explicitly only when you need to target a specific round.

5. **Review answers and confirm with the owner (@mention flow):**

   After answers are submitted, **@mention the answerer** (typically the agent's owner) with a summary of your understanding. This prevents misinterpretation before you resolve.

   a. **Get owner info** from the injected `## Checkin` / `chorus_checkin` response (`agent.owner`) or search:
      ```
      chorus_search_mentionables({ query: "owner-name" })
      ```

   b. **Post a summary comment** on the idea (in both modes — it is the audit trail of the confirmation):
      ```
      chorus_add_comment({
        targetType: "idea",
        targetUuid: "<idea-uuid>",
        content: "@[Owner Name](user:owner-uuid) I've reviewed the elaboration answers. Here's my understanding:\n\n- Key requirement 1: ...\n- Key requirement 2: ...\n\nDoes this match your intent?"
      })
      ```

   c. **Wait for confirmation.**
      - **Interactive mode:** also show the summary in chat and ask "Does this match your intent?"; a chat reply counts, as does a reply comment.
      - **Gateway mode:** END THE TURN after posting the comment. Do not poll; the gateway wakes you when the owner replies.

   d. **Based on the response — this is the loop decision point:**
      - **Confirmed, nothing left to discuss** — Treat this as the human confirmation required to resolve; proceed to Step 6 and call `chorus_pm_validate_elaboration`.
      - **Human raises a new concern / correction / question** — Do **NOT** resolve. Loop back: open a **new round** with `chorus_pm_start_elaboration` capturing the new questions, collect answers (Steps 2–5 again), and re-confirm. Repeat until the human has no remaining concerns.
      - **The answers themselves derived new questions or a contradiction** — Same as above: loop back to `chorus_pm_start_elaboration` for another round before resolving.
      - **Unclear** — Ask clarifying questions (in chat when interactive, otherwise via another @mention comment and end the turn), then continue the loop.

6. **Resolve the elaboration (the single commit gate — only when the loop is done):**

   Resolving marks the **whole elaboration phase** complete — it sets `idea.elaborationStatus = "resolved"` (Idea → `elaborated`), which is the gating signal that lets a downstream Proposal be submitted. It is an **Idea-level** action (takes only `ideaUuid`, does not target a round). Resolve **once**, only after the Step 5d loop has fully settled — every derived question answered and the human has no remaining concerns. If anything is still open, go back to `chorus_pm_start_elaboration` instead of resolving.

   > **Precondition:** resolve requires the Idea to have at least one round and **every** round to be fully answered (none left in `pending_answers`). If a round still has open questions, answer it (or it'll be rejected).

   > **⚠️ Human confirmation required.** Outside YOLO automation you MUST obtain explicit human confirmation before resolving. The "Confirmed" reply in step 5d above counts as that confirmation. Never resolve on your own judgment alone.

   > **Permission (N1): `chorus_pm_validate_elaboration` requires `idea:admin`.** The `pm_agent` preset only grants `idea:write`, so a PM-preset agent **cannot** resolve — it must hand off to an `admin_agent`-preset agent (or an admin-preset API key) to perform the resolve. If your key lacks `idea:admin`, surface this to the human (in chat, or via an @mention comment) and request the handoff instead of failing silently.

   > **Assignee OR idea:admin gateway (N2):** the resolving actor may be the Idea's **assignee**, OR a non-assignee holding **`idea:admin`** acting as a resolve gateway (a Chorus permission concept, unrelated to `hermes gateway`). A gateway resolve (or skip via `chorus_pm_skip_elaboration`) is the MCP analogue of the human UI **Verify-Elaborate**: it logs an `elaboration_verified` activity that wakes the Idea's **assignee** agent to write the proposal. So an orchestrator/admin no longer needs to claim/reassign the Idea to resolve it — holding `idea:admin` is enough. (Assignee self-resolve/skip is unchanged and wakes no one.)

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
   })
   ```

   **Want a follow-up round instead of resolving?** Just call `chorus_pm_start_elaboration` again — there is no separate "open a round" flag. It works while still `elaborating` (a normal follow-up round) and, after you've already resolved, as an **appended round** (`isAppended: true`) that keeps the Idea `elaborated` and never blocks an in-flight Proposal. Per-question issue tagging no longer exists.

7. **Check elaboration status** at any time:
   ```
   chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })
   ```

**Elaboration as audit trail:** Even if the user discusses requirements with you outside the formal elaboration flow (for example in a Hermes chat), record key decisions as elaboration rounds so they are persisted and visible to the team.

**Question categories:** `functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, `scope`

---

## Idea Lineage (derive vs. task)

Ideas can form a **single-parent forest**: an idea may have one parent (`parentUuid`), establishing a weak lineage. "Weak" means the parent only shows a read-only `+N derived` rollup of its **direct** children — it never blocks or alters either idea's elaboration/proposal/task flow, and a parent is always a full first-class idea (it can have its own content, proposals, and tasks).

When a new direction surfaces (during elaboration, brainstorm, or review), decide where it belongs:

- **Derive a child idea** (`chorus_pm_create_idea` with `parentUuid`, or `chorus_edit_idea` with `parentUuid` to reparent an existing idea) when the new direction needs **its own elaboration/proposal lifecycle** — it is an independent AI-DLC pass.
- **Add a task** to the current idea's proposal when the new work is just *how to implement the current idea*.
- **Create a plain top-level idea** (no `parentUuid`) when there is no lineage to the current idea.

This is a soft heuristic, not a rule — use judgment. Cycle prevention is automatic: you cannot set a parent that is the idea itself or one of its descendants. Parent and child must be in the same project (cross-project lineage is not supported yet). Deleting a parent re-parents its children to top-level (it never cascades).

### Theme ideas

A **theme** is an idea that only *groups* related children under a shared direction — it is not a deliverable itself. Set `isContainer: true` on `chorus_pm_create_idea` / `chorus_edit_idea` (or the detail-panel toggle) to make one; it is freely reversible. The one rule that matters: **a theme cannot create a proposal** — to deliver its direction, derive a child idea (`parentUuid = <theme>`) and write the proposal on the child. A theme may still elaborate (its elaboration is shared context for children), and its status/progress rolls up from its children. Everything else is self-documented on the tool params.

#### Theme decompose (daemon-assisted)

When a theme is created via the conversational "help me break this into child ideas" entry, don't create children immediately — **propose then create**: (1) edit the theme + optionally one short scope-elaboration round; (2) propose the candidate children as an elaboration round (`chorus_pm_start_elaboration`), one single-select question per candidate, for the user to accept/decline in the panel (in gateway mode, post the @mention pointer comment and end the turn); (3) on the answer re-wake, create each accepted child with `chorus_pm_create_idea` (`parentUuid = <theme>`, left in `open`).

---

## Tips

- When combining multiple ideas, explain how they relate in the proposal description
- Elaboration improves Proposal quality — don't skip it unless the requirements are trivially clear, and never without the human's explicit permission
- Every structured question goes through a Chorus elaboration round: list it in chat when the human is there, otherwise @mention the owner and end the turn — never poll
- Record decisions made in conversation as elaboration rounds for auditability
- Always @mention the owner to confirm understanding before resolving

---

## Next

- Once elaboration is resolved, load the proposal skill (`skill_view("chorus:proposal")`) to create a Proposal with document and task drafts
- **Human "Verify Elaborate" handoff:** when a human clicks **Verify Elaborate** on the idea-detail panel, Chorus resolves the elaboration and wakes the Idea's assigned agent (on Hermes, through `hermes gateway`) to write the proposal — so the woken agent picks up this idea→proposal handoff automatically (no human-authored proposal needed).
- **Human "Start Development" handoff:** once the proposal is approved and unfinished tasks remain, the idea-detail panel shows a **Start Development** button (enabled while the assignee agent is online). A `start_development` wake means: claim and execute ALL remaining tasks of the idea's approved proposal in dependency order until none are claimable — not just one task.
- **Human "Yolo" handoff:** the idea-detail panel also shows a **Yolo** button at ANY incomplete stage (enabled while the assignee agent is online), confirmed via a dialog before it fires. A `yolo_requested` wake means: drive the WHOLE idea to done via the yolo skill (`skill_view("chorus:yolo")`, the full-auto AI-DLC pipeline) — read the idea's current state first and resume from whatever phase it is in (self-elaborate + write the proposal if not yet resolved; execute if a proposal is approved with open tasks; etc.), never assuming a fixed stage. Complete through done + the completion report, but never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see `skill_view("chorus:chorus")`
