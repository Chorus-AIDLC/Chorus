# team-review-routing Specification

## Purpose
TBD - created by archiving change team-review-agent-routing. Update Purpose after archive.

## Requirements

### Requirement: Review-role recommendation

`chorus_recommend_team_agent` SHALL accept `role: "review"` with an optional review target:
- `taskUuid` targets a task;
- `proposalUuid` targets a proposal;
- neither targets the Idea-level whole-change review;
- supplying both SHALL be rejected with a 400 error.

A `proposalUuid` whose proposal does not list the Idea as a source SHALL be rejected with a 403 error. A `taskUuid` that does not belong to the Idea SHALL be rejected with a 403 error.

For an active Team-managed Idea, the recommendation SHALL consider only eligible members of the review role. It SHALL prefer online members, then the author of the target's latest agent-authored comment that has a line starting with `VERDICT: PASS`, `VERDICT: PASS WITH NOTES` or `VERDICT: FAIL` (re-review affinity), then the minimum `activeCount`. Re-review affinity SHALL also select the orchestrator when it authored that verdict, even if it is not an online review member. A tie at minimum load SHALL return `lead_decision` with the tied candidates.

The recommendation SHALL NOT exclude the orchestrator, the proposal author or the task developer.

Unmanaged and paused Ideas SHALL return `manual` and `paused` respectively, exactly as for the other roles.

#### Scenario: Single online reviewer is recommended
- **WHEN** the orchestrator calls `chorus_recommend_team_agent({ideaUuid, role: "review", taskUuid})` and exactly one eligible review member is online with the lowest load
- **THEN** the result is `decision: "recommended"` with that member's `agentUuid`, even if that member is the task's developer or the orchestrator

#### Scenario: Re-review goes to the previous reviewer
- **WHEN** a task was reopened after an agent-authored `VERDICT: FAIL` comment by reviewer R, the task is resubmitted, and R is still eligible and online
- **THEN** the review recommendation is R with `reason: "rereview_affinity"`, even if another review member has a lower load

#### Scenario: Both targets supplied
- **WHEN** the call passes both `taskUuid` and `proposalUuid`
- **THEN** it fails with a 400 error and recommends nobody

#### Scenario: Proposal from another Idea
- **WHEN** `proposalUuid` names a proposal whose source Ideas do not include `ideaUuid`
- **THEN** it fails with a 403 error

### Requirement: Review never stalls for lack of a reviewer

When the review role of an active Team-managed Idea has no eligible online member, `chorus_recommend_team_agent` with `role: "review"` SHALL return `decision: "recommended"` with `agentUuid` set to the Idea's orchestrator and `reason: "review_orchestrator_subagent_fallback"`. This covers a role that is empty, has only ineligible members, or has only offline members. The Team review protocol SHALL instruct an orchestrator receiving itself as the reviewer to run the matching reviewer sub-agent in the same turn rather than waiting.

#### Scenario: Empty review role
- **WHEN** the project Team has no review members and the orchestrator requests a review recommendation
- **THEN** the result recommends the orchestrator with `reason: "review_orchestrator_subagent_fallback"` and never `manual`

#### Scenario: All reviewers offline
- **WHEN** every eligible review member is offline
- **THEN** the result recommends the orchestrator with `reason: "review_orchestrator_subagent_fallback"`

### Requirement: Review handoff wording

The Team handoff notification sent to the orchestrator SHALL name the review step:
- On a proposal submission it SHALL instruct the orchestrator to route the proposal review with `role: "review"` and `proposalUuid`.
- On a task submission for verification it SHALL instruct the orchestrator to route the task review with `role: "review"` and `taskUuid`, and to verify only after a PASS verdict.
- When the submitted task is the last task of the Idea that is not in `to_verify`, `done` or `closed`, the notification SHALL additionally instruct the orchestrator to start the whole-Idea code review. The Idea's tasks are the tasks of every proposal sourced from the Idea.

When the orchestrator itself submits a proposal or task, no handoff is sent. The Team review protocol SHALL instruct the orchestrator to route the review in the same turn, including the last-task check.

The notification SHALL keep using the existing `mentioned` action. No new turn trigger SHALL be introduced.

#### Scenario: Last task submitted
- **WHEN** a Team-managed Idea's proposal has three tasks, two already `done`, and the third moves to `to_verify`
- **THEN** the orchestrator's handoff message instructs it both to route the task review and to start the whole-Idea code review

#### Scenario: Not the last task
- **WHEN** a task moves to `to_verify` while another task of the same proposal is still `in_progress`
- **THEN** the handoff message instructs only the task review and does not mention the whole-Idea code review

#### Scenario: Orchestrator submits its own proposal
- **WHEN** the orchestrator submits a proposal it authored itself
- **THEN** no handoff notification is sent, and the orchestrator requests a review recommendation and dispatches the review in the same turn

#### Scenario: Unmanaged Idea unchanged
- **WHEN** a task of an Idea without an active Team moves to `to_verify`
- **THEN** no Team handoff notification is created, exactly as before this change

### Requirement: VERDICT routing and reviewer duty

Every host's skill documentation and reviewer definitions SHALL define the Team review protocol.

**Reviewer duty.** A Team reviewer woken for a review SHALL only read and post exactly one `VERDICT:` comment per round, listing all findings with stable IDs. It SHALL NOT reject, reopen, approve, verify or create tasks.

**VERDICT @mention target.** The VERDICT SHALL contain exactly one @mention of the actor that must act next:
- for a proposal review with PASS or PASS WITH NOTES, the orchestrator;
- for a proposal review with FAIL, the Idea's product delegate, or the orchestrator if no product agent was delegated;
- for a task review with PASS or PASS WITH NOTES, the orchestrator;
- for a task review with FAIL, the task's developer;
- for the whole-Idea review, the orchestrator.

**No acknowledgement mentions.** VERDICTs, handoff receipts and acknowledgements SHALL NOT @mention anyone who is not required to act. The mention wake prompt of every daemon client SHALL tell the woken agent to @mention the sender only when the sender must act on its result.

#### Scenario: Task FAIL goes to the developer
- **WHEN** a Team reviewer posts `VERDICT: FAIL` on a task developed by agent D
- **THEN** the VERDICT @mentions only D, and D fixes and resubmits without posting an acknowledgement mention

#### Scenario: Wake prompt does not demand an acknowledgement
- **WHEN** an agent is woken by an @mention and its work needs nothing further from the sender
- **THEN** the wake prompt does not instruct it to @mention the sender, and it posts no acknowledgement-only mention

#### Scenario: Task PASS goes to the orchestrator
- **WHEN** a Team reviewer posts `VERDICT: PASS` on a task
- **THEN** the VERDICT @mentions only the Idea's orchestrator, which verifies the task

### Requirement: Review gates and rounds

The Team review protocol SHALL require:
- The orchestrator SHALL verify a task only after a PASS or PASS WITH NOTES VERDICT for the task's current round.
- Under human-requested YOLO, the orchestrator SHALL approve a proposal only after a PASS or PASS WITH NOTES VERDICT. Without YOLO, the VERDICT is advisory, a human approves, and after a PASS or PASS WITH NOTES the orchestrator SHALL post one comment @mentioning the human owner to request approval.
- The whole-Idea review SHALL start when the last task reaches `to_verify`, in parallel with task reviews. Its PASS SHALL gate only the completion report and the pull request; a FAIL SHALL lead to fix tasks created with `proposalUuid` set to the approved proposal, or to reopened tasks.
- A resubmitted entity SHALL be re-reviewed by the same reviewer when available, reusing finding IDs.
- After 3 review rounds without a PASS on one entity, the orchestrator SHALL stop the automatic loop and @mention the human owner.

#### Scenario: YOLO approval waits for PASS
- **WHEN** a YOLO Team-managed Idea's proposal is submitted and its review VERDICT is FAIL
- **THEN** the orchestrator does not approve the proposal and routes the findings to the product delegate (or revises the proposal itself)

#### Scenario: Non-YOLO proposal PASS asks the human
- **WHEN** a non-YOLO Team-managed Idea's proposal receives `VERDICT: PASS`
- **THEN** the orchestrator does not approve it and posts one comment @mentioning the human owner to request approval

#### Scenario: Round cap reached
- **WHEN** a task receives a third `VERDICT: FAIL`
- **THEN** the orchestrator does not request a fourth review and @mentions the human owner with the outstanding BLOCKER IDs
