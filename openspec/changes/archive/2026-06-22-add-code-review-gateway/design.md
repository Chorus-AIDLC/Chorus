# Design: Code-Review Gateway

## Overview

A fourth reviewer — **code-reviewer** — joins proposal-reviewer and task-reviewer. It is structurally identical to them (read-only subagent, structured VERDICT comment) but differs in three ways:

1. **Scope** — the aggregate code change behind one Idea, not a single proposal draft or a single task.
2. **Verdict target** — the **Idea** resource (`targetType: "idea"`), because it gates the idea's final delivery.
3. **Trigger** — auto, when the **last task** of an idea-rooted proposal is admin-verified (the existing `on-post-verify-task.sh` hook point).

No backend/schema work. Everything is plugin-layer: agent/skill definitions, one hook branch, config keys, and skill-doc wiring.

## Decision: behavioral gate, verdict-in-comment (no structural gating in v1)

The existing reviewers are **advisory** — their VERDICT is a comment; the actual decision to advance is made by the orchestrator (human in `/review`, the agent in `/yolo`). The "wall" that gates a proposal is `Proposal.status`, and the wall that gates a task is the admin verify action — never the reviewer comment itself.

The code-review gateway copies this exact division:

- **Narrative + findings, every round → Idea comment.** Multiple rounds = multiple appended comments. Mirrors proposal/task reviewer output verbatim in shape.
- **The ship decision → the orchestrator.** In YOLO, the agent reads the latest VERDICT and only ships on PASS / PASS WITH NOTES. Outside YOLO, the verdict is advisory guidance for the human.

### Why no idea-level structured "passed" flag (rejected alternative)

An earlier design proposed `DerivedStatusContext.hasCodeReview` gating `computeDerivedStatus` so an idea cannot show `done` until a passing code-review record exists. Rejected for v1 because **one idea can have multiple proposals**: after proposal A is reviewed and shipped, opening proposal B makes any idea-level "passed" flag ambiguous (does it mean A or the idea as a whole?). Resolving that ambiguity is premature before the gateway has real usage. Deferring structural gating sidesteps the question; the gate is behavioral until the multi-proposal shape is understood. Listed in proposal.md Out of Scope.

## Trigger: extend `on-post-verify-task.sh`

`public/chorus-plugin/bin/on-post-verify-task.sh` already fires on every `chorus_admin_verify_task` and runs two independent, read-only branches that share the same "is this the last task of the proposal?" computation:

- Branch A — OpenSpec archive reminder.
- Branch B — idea-completion report reminder.

Add **Branch C — code-review gateway reminder**, following the identical pattern:

- Reuse the already-fetched `TASK_JSON` / `PROPOSAL_JSON` / task-list (all tasks of the proposal terminal) — the same `pageSize=200` + `total>returned` pagination guard.
- Gate on a new config toggle `CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER` (default `true`), parallel to how Branch A gates on `ENABLEOPENSPEC`.
- Only fire for `inputType == "idea"` proposals (the gateway reviews an idea; resolve the idea UUID from the proposal's `inputUuids`).
- Emit an `additionalContext` reminder whose body instructs the agent to spawn the code-reviewer for that idea. Reuse the existing combine-and-emit tail (`OPENSPEC_CONTEXT` / `REPORT_CONTEXT` → add `CODEREVIEW_CONTEXT`).
- **Read-only**, like the other branches — it never posts a comment or mutates anything; it only injects the reminder.

The reminder carries a stable literal substring (e.g. `spawn code-reviewer`) as the contract grep target for the regression test, matching how Branch A asserts `openspec archive <slug>` and Branch B asserts `create idea-completion report`.

### Ordering vs Branch B (completion report)

Branch C and Branch B can both fire on the same `chorus_admin_verify_task` event (both gate on "all tasks of this proposal terminal"). Code review logically precedes shipping, and the completion report is a ship-time summary — so **code review should happen before the completion report is written**. Two parts:

- **Reminder emission order in the hook.** When both branches fire, the combined `additionalContext` SHALL place the code-review reminder (Branch C) *before* the completion-report reminder (Branch B), so the agent reads them in the intended sequence. (The hook only injects text; it does not enforce execution, but ordering the reminders sets the default reading order.)
- **Workflow sequence.** The yolo/skill wiring (the workflow tasks) SHALL instruct: run the code-review gateway first; only after it returns PASS / PASS WITH NOTES does the agent write the idea-completion report. On FAIL, fix tasks are added and the report waits until a subsequent round passes.

This keeps the completion report honest — it is never written for a feature that has an outstanding FAIL verdict.

Bash 3.2 compatibility is mandatory (CLAUDE.md pitfall #10): no `${VAR,,}`, `${VAR^^}`, `declare -A`, `mapfile`, `readarray`, `|&`, `&>>`. Parse captured JSON via `printf '%s' "$VAR" | jq`, never `echo`.

## The code-reviewer agent contract

Mirrors `task-reviewer.md` structurally. Frontmatter: `model: inherit`, `color`, `maxTurns: 100`, `disallowedTools` excluding Edit/Write/NotebookEdit/Agent/ExitPlanMode (Bash read-only — same allow/deny list as task-reviewer). `criticalSystemReminder_EXPERIMENTAL` enforces read-only posture, the bash policy, output budget, finding classification, and the VERDICT contract.

### What it receives

An `ideaUuid` and the current review round number.

### Procedure

1. **Gather** — `chorus_get_idea`, the idea's elaboration, its proposals (`chorus_get_proposals`), and per approved proposal its tasks + documents (PRD/tech design). Read the idea's prior code-review comments (for round awareness).
2. **Determine the aggregate diff scope itself** (read-only repo exploration): combine task work reports + repo state (`git log`, `git diff`, `git show`) to infer what this idea changed. No strict branch convention is assumed; the reviewer states the scope it settled on in its comment.
3. **Review the whole-feature dimensions** (the value over per-task review):
   - Cross-task integration / contract consistency — wiring, interface contracts, inter-module cooperation across tasks.
   - Architecture & convention consistency (no drift) — conformance to project patterns, no locally-divergent choices.
   - Security — risks introduced by the aggregate change (the idea's own problem statement names security as a whole-feature concern: a defect only visible when the tasks are seen together).
   - Regression risk / impact on untouched areas / performance.
   - Feature-level test coverage adequacy.
   - Code soundness, simplicity, correctness of the aggregate change.
4. **Run feature-level build/test** where available (read-only); a broken build or failing tests is an automatic FAIL.
5. **Classify & verdict** — BLOCKER (blocks ship) vs NOTE (non-blocking); `VERDICT: PASS / PASS WITH NOTES / FAIL`.
6. **Post one comment** on the idea: `chorus_add_comment({ targetType: "idea", targetUuid: "<ideaUuid>", content: "<review>" })`.

### Round awareness

Round 1 is a full review. Round 2+ focuses ONLY on whether previous BLOCKERs were fixed — re-read just the files/tests tied to prior BLOCKERs; do not introduce new NOTEs or rescan unrelated code. Same anti-verification-avoidance discipline as task-reviewer.

## FAIL handling: add fix tasks, re-run

On FAIL, the orchestrator creates **new fix tasks on the existing approved proposal** (`chorus_create_tasks`), targeting the BLOCKERs — it does NOT reopen old tasks. When those fix tasks reach `done`/verified, the gateway re-runs (the last-task-verify trigger fires again, or the agent re-spawns it explicitly). Loop until PASS / PASS WITH NOTES, bounded by `maxCodeReviewRounds` (default 3, 0 = unlimited), after which it escalates to a human — parallel to the existing reviewers' round caps.

## YOLO integration

The yolo skill gains a mandatory **pre-ship code-review step** after all tasks of the idea's proposal are verified and before declaring done:

1. Spawn the code-reviewer (foreground) for the idea.
2. Read its VERDICT on the idea.
3. PASS / PASS WITH NOTES → proceed to ship/done.
4. FAIL → create fix tasks on the approved proposal, drive them through the normal develop→verify wave, then re-spawn the code-reviewer (next round). Bounded by `maxCodeReviewRounds`.

This mirrors the existing proposal-reviewer and task-reviewer adversarial loops already documented in the yolo skill.

## Four-surface parity

Per the four-plugin-surface rule, the code-reviewer is authored in all four roots, each in the host's idiom (spawn mechanism, tool prefix):

| Surface | Path | Spawn idiom |
|---|---|---|
| Claude Code plugin | `public/chorus-plugin/agents/code-reviewer.md` | `Agent({ subagent_type: "chorus:code-reviewer", ... })` |
| Standalone skill | `public/skill/code-reviewer-chorus/SKILL.md` | framework-neutral, load skill by URL |
| Codex plugin | `plugins/chorus/skills/chorus-code-reviewer/SKILL.md` | `spawn_agent(agent_type="default", items=[{type:"skill", path:"chorus:chorus-code-reviewer"}, ...])` |
| OpenClaw plugin | `packages/openclaw-plugin/skills/code-reviewer/SKILL.md` | `sessions_spawn`, `chorus__`-prefixed tools |

## Risks & Mitigations

- **Aggregate diff scope is fuzzy without a branch convention.** Mitigation: the reviewer states the scope it inferred; round-awareness keeps re-reviews cheap. Accepted as the q5 decision (agent infers from reports + repo state).
- **Behavioral gate can be skipped** if an agent ignores the protocol (no structural wall). Mitigation: this is an accepted, conscious tradeoff matching the existing reviewers; structural gating is the documented future phase.
- **Hook false-fire on multi-proposal ideas.** Branch C fires per-proposal last-task-verify; the reminder names the idea, and the reviewer scopes to the just-completed proposal's change. Mitigation: keep Branch C's gate identical to Branch B (proposal-scoped terminal check), and let the reviewer state its scope.
