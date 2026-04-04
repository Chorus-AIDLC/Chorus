# Idea Derived Status State Machine

The Idea Tracker displays ideas with a **derived presentation** computed from multiple entity states across the Idea → Proposal → Task lifecycle. This document defines the mapping from internal state to user-facing display.

## Source Fields (Internal)

| Field | Table | Values |
|---|---|---|
| Idea Status | `Idea.status` | `open`, `elaborating`, `proposal_created`, `completed`, `closed` |
| Elaboration Status | `Idea.elaborationStatus` | `null`, `validating`, `pending_answers`, `resolved` |
| Proposal Status | `Proposal.status` | `draft`, `pending`, `approved`, `rejected`, `closed` |
| Task Status | `Task.status` | `open`, `assigned`, `in_progress`, `to_verify`, `done`, `closed` |

## Full Mapping (11 internal states → 4 groups + 9 badge labels)

| # | Idea Status | Elab Status | Proposal | Tasks | → Group | → Card Badge | → Detail Panel Badge |
|---|---|---|---|---|---|---|---|
| 1 | `open` | — | — | — | **To Do** | `open` | `open` |
| 2 | `elaborating` | `null`/`validating`/`resolved` | — | — | **In Progress** | `researching` | `researching` |
| 3 | `elaborating` | `pending_answers` | — | — | **Human Conduct Required** | `answer_questions` | `answer_questions` |
| 4 | `proposal_created` | — | `draft`/`rejected` | — | **In Progress** | `planning` | `planning` |
| 5 | `proposal_created` | — | `pending` | — | **Human Conduct Required** | `review_proposal` | `review_proposal` |
| 6 | `proposal_created` | — | `approved` | not all finished (any `open`/`assigned`/`in_progress` remaining) | **In Progress** | `building` | `building` |
| 7 | `proposal_created` | — | `approved` | ALL `done`/`closed`/`to_verify`, with ≥1 `to_verify` | **Human Conduct Required** | `verify_work` | `verify_work` |
| 8 | `proposal_created` | — | `approved` | ≥1 task, ALL `done`/`closed` | **Done** | `done` | `done` |
| 9 | `proposal_created` | — | `approved` | no tasks | **In Progress** | `building` | `building` |
| 10 | `completed` | — | — | — | **Done** | `done` | `done` |
| 11 | `closed` | — | — | — | *(excluded from board)* | `closed` | `closed` |

### Evaluation Order

The code evaluates `proposal_created` + `approved` states in this order (first match wins):

1. All tasks `done`/`closed` (≥1 task) → **done**
2. All tasks `done`/`closed`/`to_verify` with ≥1 `to_verify` → **verify_work**
3. Fallback (including no tasks, or any task still `open`/`assigned`/`in_progress`) → **building**

### Key Design Decisions

1. **`verify_work` requires ALL tasks complete** — Row #7 only triggers when every task is `done`, `closed`, or `to_verify` (with at least one `to_verify`). A mix of `in_progress` + `to_verify` stays as `building` (#6), preventing premature "verify" prompts.

2. **3 human action points** — The board highlights when humans need to act: answer elaboration questions (#3), review proposals (#5), verify completed work (#7). Everything else is AI-driven.

3. **4 dashboard groups** — `todo` (not started), `in_progress` (AI working), `human_conduct_required` (waiting on human), `done` (complete). `closed` ideas are excluded from the board.

## Implementation

- **Computation**: `computeDerivedStatus()` in `src/services/idea.service.ts` — pure function, no DB calls
- **Data fetching**: `getIdeasWithDerivedStatus()` — 3 batch queries (ideas + proposals + tasks), no N+1
- **Tests**: 27 test cases in `src/services/__tests__/idea.service.derived-status.test.ts` covering all 11 rows
- **API**: `GET /api/projects/[uuid]/ideas/tracker` returns `derivedStatus` + `badgeHint` per idea
- **UI (Card)**: `src/app/(dashboard)/projects/[uuid]/dashboard/idea-card.tsx` renders badge color/label based on `badgeHint`
- **UI (Detail Panel)**: `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` — uses `getIdeaWithDerivedStatus()` service function via server action, ensuring the detail panel badge matches the card badge
