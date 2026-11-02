## Why

Agent Team ③ (#644) routes product and development work of a Team-managed Idea through its orchestrator (the Idea's current agent assignee), but reviews still run as sub-agents inside whichever session happens to be active. In the ③ E2E (project 49dedc4a, Idea 157df08d) the Team's review role was never woken: the lead ran its own sub-agent reviewers and the developer ran an extra self-review. The handoff also produced 4–6 "received, no reply needed" @mention comments between agents, and the proposal needed three review rounds, each with a separate mention round-trip.

Agent Team ④ makes the Team review role do the reviewing. The orchestrator routes each review to it, the reviewer @mentions exactly the actor who has to act next, and nobody posts acknowledgement-only mentions.

## What Changes

- `chorus_recommend_team_agent` accepts `role: "review"` plus an optional review target (`taskUuid` / `proposalUuid`; neither means the Idea-level whole-change review).
  - Selection order: eligible → online → re-review affinity (the reviewer who posted the target's latest VERDICT) → minimum load.
  - Nobody is excluded: the orchestrator, the proposal author and the task developer can all be recommended.
  - When the review role is empty, ineligible or entirely offline, the recommendation falls back to the orchestrator itself (`decision: "recommended"`, `reason: "review_orchestrator_subagent_fallback"`). It never returns `manual`, so the review never stalls.
- The Team handoff notification to the orchestrator names the review step:
  - on `proposal:submitted` and `task:submitted`, it tells the orchestrator to route the review via `role: "review"`;
  - when the submitted task is the **last** non-terminal task of its proposal, it also says to start the whole-Idea code review.
- Skill and agent docs on **all** hosts define the Team review protocol (behavioural, prompt-enforced):
  - **Who runs the review:** if the recommended reviewer is the orchestrator itself, it runs the existing `proposal-reviewer` / `task-reviewer` / `code-reviewer` sub-agent in the same turn; a sub-agent counts as a memory-free session. Otherwise the orchestrator posts one review request on the target entity @mentioning the reviewer.
  - **Reviewer duty:** a woken Team reviewer only reads and posts one `VERDICT:` comment. It never rejects, reopens, verifies or creates tasks, and it lists every finding with stable IDs in one pass.
  - **Self-submission:** after the orchestrator submits a proposal or task itself, it routes the review in the same turn. The server handoff skips the actor, so the orchestrator also does the last-task check itself.
  - **VERDICT @mention routing** — to whoever must act next:

    | Review | PASS / PASS WITH NOTES | FAIL |
    |---|---|---|
    | Proposal | orchestrator (approve under YOLO / ask the human) | product delegate, else orchestrator |
    | Task | Idea orchestrator (to verify) | task developer (to fix) |
    | Whole Idea | orchestrator | orchestrator |

  - **Gates:**
    - The orchestrator verifies a task only after a PASS / PASS WITH NOTES VERDICT for the current round.
    - Under human-requested YOLO, the orchestrator approves a proposal only after a PASS; without YOLO the VERDICT is advisory and a human approves.
    - The whole-Idea review starts when the last task reaches `to_verify` and runs in parallel with the task reviews. Its PASS gates only the completion report and the PR; on FAIL the orchestrator adds fix tasks or reopens tasks.
  - **Re-review:** a resubmitted entity is re-reviewed by the same reviewer, reusing the finding IDs (round-2+ rules), for at most 3 rounds; after that it goes to a human.
  - **No acknowledgement mentions:** VERDICTs and handoff receipts only @mention someone who must act; nobody replies "received".
- The mention wake prompt is made conditional in the CLI (`cli/prompts.mjs`), OpenClaw and Hermes: @mention the sender only if they must act, never just to acknowledge.
- `docs/MCP_TOOLS.md` documents the new role and parameters.
- An end-to-end verification on a real Team project covers all of the Idea's acceptance points.

## Non-goals

- No new `TURN_TRIGGERS` value, wake kind or server-direct reviewer wake: the orchestrator delegates, and the reviewer is woken by an ordinary @mention.
- No server-side enforcement: no VERDICT gate on verify/approve, no tool restriction for reviewer sessions, no mention debounce or `[ack]` marker.
- No schema change.
- Projects or Ideas without an active Team keep the current sub-agent reviewer flow unchanged.

## Capabilities

### New Capabilities
- `team-review-routing`: review-role recommendation, review handoff wording, VERDICT routing, review gates and the no-acknowledgement rule for Team-managed Ideas.

## Impact

- Server:
  - `src/types/idea-team.ts` (`IdeaTeamRoutingRole`)
  - `src/services/idea-team.service.ts` (`recommendIdeaTeamRole`)
  - `src/mcp/tools/public.ts` (tool schema and description)
  - `src/services/notification-listener.ts` (`notifyIdeaTeamHandoff`)
- Wake prompts:
  - `cli/prompts.mjs` (`mentionGuidance`)
  - `packages/openclaw-plugin/src/event-router.ts`
  - `packages/chorus-hermes/chorus/chorus_hermes/prompts.py`
  - tests under `src/services/__tests__/`
- Docs:
  - `docs/MCP_TOOLS.md`
  - orchestrate / review / yolo / chorus skills and the three reviewer definitions in `public/chorus-plugin`, `plugins/chorus` (Codex/TRAE), `public/skill`, `public/kiro-plugin`, `packages/chorus-pi`, `packages/openclaw-plugin`, `packages/chorus-hermes` and `packages/chorus-dsh`
