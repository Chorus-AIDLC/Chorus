# Idea Derived Status State Machine

The Idea Tracker displays ideas with a **derived presentation** computed from multiple entity states across the Idea → Proposal → Task lifecycle. This document defines the mapping from internal state to user-facing display.

## Idea Native Status

An Idea's own status only tracks the elaboration phase. Everything downstream (proposal, tasks) is derived.

| Status | Meaning | Transition |
|---|---|---|
| `open` | Newly created, not yet claimed | → `elaborating` (on claim / start elaboration) |
| `elaborating` | Elaboration in progress | → `elaborated` (auto, when elaboration resolves) |
| `elaborated` | **Terminal.** Elaboration complete; idea is ready for proposal. | *(no further transitions)* |

**Removed statuses**: `proposal_created`, `completed`, and `closed` are eliminated. These were remnants of an older design where Idea tracked the full lifecycle. Now, once elaboration is done the Idea is "finished" — all subsequent progress is inferred from downstream Proposal and Task entities.

**Removed MCP tool**: `chorus_update_idea_status` is removed. All Idea status transitions are side-effects of other operations (claim → `elaborating`, elaboration resolves → `elaborated`). No agent should set Idea status directly.

## Source Fields (Internal)

| Field | Table | Values |
|---|---|---|
| Idea Status | `Idea.status` | `open`, `elaborating`, `elaborated` |
| Elaboration Status | `Idea.elaborationStatus` | `null`, `validating`, `pending_answers`, `resolved` |
| Proposal Status | `Proposal.status` | `draft`, `pending`, `approved`, `rejected`, `closed` |
| Task Status | `Task.status` | `open`, `assigned`, `in_progress`, `to_verify`, `done`, `closed` |

## Full Mapping (11 internal states → 4 groups + 9 badge labels)

| # | Idea Status | Elab Status | Proposal | Tasks | → Group | → Badge |
|---|---|---|---|---|---|---|
| 1 | `open` | — | — | — | **To Do** | `open` |
| 2 | `elaborating` | `null`/`validating`/`resolved` | — | — | **In Progress** | `researching` |
| 3 | `elaborating` | `pending_answers` | — | — | **Human Conduct Required** | `answer_questions` |
| 4 | `elaborated` | — | no proposal | — | **In Progress** | `planning` |
| 5 | `elaborated` | — | `draft`/`rejected` | — | **In Progress** | `planning` |
| 6 | `elaborated` | — | `pending` | — | **Human Conduct Required** | `review_proposal` |
| 7 | `elaborated` | — | `approved` | ≥1 `to_verify` | **Human Conduct Required** | `verify_work` |
| 8 | `elaborated` | — | `approved` | ≥1 task, ALL `done`/`closed` | **Done** | `done` |
| 9 | `elaborated` | — | `approved` | any other mix / no tasks | **In Progress** | `building` |

### Evaluation Order

For `elaborated` ideas, the derived status is evaluated in this order (first match wins):

**Without an approved proposal:**

1. Has a `pending` proposal → **review_proposal**
2. Fallback (no proposal, draft, or rejected) → **planning**

**With an approved proposal (task-based derivation):**

1. Any task is `to_verify` → **verify_work**
2. All tasks `done`/`closed` (≥1 task) → **done**
3. Fallback (including no tasks, or any task still `open`/`assigned`/`in_progress`) → **building**

### Key Design Decisions

1. **Idea status is elaboration-scoped** — The Idea's own `status` field only covers `open → elaborating → elaborated`. All post-elaboration progress (planning, building, verifying, done) is derived from Proposal and Task states. This eliminates the dual-source-of-truth bug where `completed` was set before tasks finished.

2. **No direct status manipulation** — All Idea status transitions are side-effects of other operations. There is no MCP tool or API to set Idea status directly. This prevents agents from incorrectly marking an idea as done.

3. **`verify_work` triggers on any `to_verify`** — Row #7 triggers as soon as any task reaches `to_verify`, even if other tasks are still `in_progress`. This surfaces work for human review as early as possible.

4. **3 human action points** — The board highlights when humans need to act: answer elaboration questions (#3), review proposals (#6), verify completed work (#8). Everything else is AI-driven.

5. **4 dashboard groups** — `todo` (not started), `in_progress` (AI working), `human_conduct_required` (waiting on human), `done` (complete).

## Implementation

- **Computation**: `computeDerivedStatus()` in `src/services/idea.service.ts` — pure function, no DB calls
- **Data fetching**: `getIdeasWithDerivedStatus()` — 3 batch queries (ideas + proposals + tasks), no N+1
- **Auto-transitions**: `elaborating → elaborated` is triggered in `skipElaboration()` and `resolveElaboration()` when `elaborationStatus` becomes `resolved`
- **Tests**: `src/services/__tests__/idea.service.derived-status.test.ts` covering all rows
- **API**: `GET /api/projects/[uuid]/ideas/tracker` returns `derivedStatus` + `badgeHint` per idea
- **UI (Card)**: `src/app/(dashboard)/projects/[uuid]/dashboard/idea-card.tsx` renders badge color/label based on `badgeHint`
- **UI (Detail Panel)**: `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` — uses `getIdeaWithDerivedStatus()` service function via server action

## Migration Notes

- Existing ideas with `status = "proposal_created"` should be normalized to `elaborated` via `normalizeIdeaStatus()`
- Existing ideas with `status = "completed"` should be normalized to `elaborated` via `normalizeIdeaStatus()`
- Existing ideas with `status = "closed"` should be normalized to `elaborated` via `normalizeIdeaStatus()`
- `normalizeIdeaStatus()` maps legacy values: `proposal_created` → `elaborated`, `completed` → `elaborated`, `closed` → `elaborated`, `assigned`/`in_progress` → `elaborating`, `pending_review` → `elaborated`
- No DB migration required — normalization happens at read time in the service layer
