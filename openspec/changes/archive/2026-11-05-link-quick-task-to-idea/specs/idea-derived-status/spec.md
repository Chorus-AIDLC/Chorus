## ADDED Requirements

### Requirement: Single derived-status computation over proposal and linked tasks

Every surface that reports an Idea's derived status (Idea detail, Idea tracker and its groups, `chorus_get_my_assignments`, checkin, theme rollup, Team handoff, agent-assignment release, YOLO "fully done" check, research eligibility, resource graph) SHALL compute it through one shared loader and `computeDerivedStatus`. When an Idea has no directly linked tasks the result SHALL be identical to the previous behaviour. When it has linked tasks, with `all` = (tasks of the latest approved proposal, if any) ∪ (linked Quick Tasks), the precedence SHALL be: pending elaboration answers → `answer_questions`; pending proposal → `review_proposal`; any `to_verify` → `verify_work`; all `done`/`closed` → `done`; otherwise `building`. Reported task counts SHALL be `all.length`.

#### Scenario: Issue #650 — Idea completed via Quick Tasks

- **WHEN** an elaborated Idea has no proposal and three linked Quick Tasks, all `done`
- **THEN** its derived status is `done` (badge `done`) in the Idea panel, the tracker and `chorus_get_my_assignments`

#### Scenario: Linked task awaiting verification

- **WHEN** an open Idea has two linked Quick Tasks, one `done` and one `to_verify`
- **THEN** its derived status is `human_conduct_required` with badge `verify_work`, and its stored status stays `open`

#### Scenario: Union with proposal tasks

- **WHEN** an Idea has an approved proposal whose tasks are all `done` and one linked Quick Task `in_progress`
- **THEN** its derived status is `in_progress` with badge `building` and its task count includes all tasks

#### Scenario: Pending proposal still wins over done tasks

- **WHEN** all linked tasks are `done` but the Idea has a pending proposal
- **THEN** its derived status is `human_conduct_required` with badge `review_proposal`

#### Scenario: Theme rollup follows children completed via Quick Tasks

- **WHEN** every child of a theme Idea is `done`, some via linked Quick Tasks only
- **THEN** the theme rolls up to `done`

#### Scenario: No linked tasks — unchanged

- **WHEN** an Idea has no linked tasks
- **THEN** its derived status equals what `computeDerivedStatus` returned before this change for the same proposal/task state
