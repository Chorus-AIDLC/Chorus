# Design: `parentUuid` on lightweight idea-read surfaces

## Context

`add-idea-lineage` stored the edge as `Idea.parentUuid` (nullable self-relation) and surfaced it on the rich reads. The two lightweight surfaces have independent select-projections that pre-date lineage, so they silently drop the field. This change is a pure projection-widening: add one column to two `select`s and thread it through two response mappers. No new queries, no rollup, no N+1 concern.

## Surfaces and their backing code

### 1. `chorus_get_available_ideas` → `assignment.service.getAvailableItems`

Today the idea branch selects `{ uuid, title, content, status, createdByUuid, createdAt }` and `formatAvailableIdea` maps to `AvailableIdeaResponse`. The change:

- `AvailableIdeaResponse` gains `parentUuid: string | null`.
- The `prisma.idea.findMany` `select` gains `parentUuid: true`.
- `formatAvailableIdea`'s input type gains `parentUuid: string | null` and the return object sets `parentUuid: idea.parentUuid ?? null`.

`formatAvailableIdea` is `async` (it resolves `createdBy`); adding a synchronous field does not change its shape.

### 2 & 3. `chorus_get_my_assignments` + `chorus_checkin` → `idea-tracker.service.buildIdeaTracker`

Both surfaces render the idea tracker through the single `buildIdeaTracker` function, so one edit covers both (this shared-shape invariant is the whole reason `idea-tracker.service` exists — see its header comment). The change:

- `IdeaTrackerEntry` gains `parentUuid: string | null`.
- The `prisma.idea.findMany` `select` (Q1 in `buildIdeaTracker`) gains `parentUuid: true`.
- The `tracker[projectUuid].ideas.push({...})` object sets `parentUuid: idea.parentUuid ?? null`.

`checkin.service.ts` declares its own `CheckinIdea` interface that is structurally parallel to `IdeaTrackerEntry` but is a **separate type** (it is the static type of `CheckinResponse.ideaTracker`). The runtime value already comes from `buildIdeaTracker`, so the value is correct regardless; but to keep the declared `chorus_checkin` response type accurate, `CheckinIdea` also gains `parentUuid: string | null`. This is a type-only edit — no runtime behavior change in `checkin.service`.

## Field semantics

- `parentUuid` is the **stored** edge, surfaced verbatim. `null` for a top-level idea.
- No `childCount`, no `parent` title — those remain exclusive to `chorus_get_ideas` / `chorus_get_idea` (elaboration q2 = a). An agent that needs the rollup or parent title makes one `chorus_get_idea` call.
- Normalization: emit `idea.parentUuid ?? null` so the field is always present (never `undefined`) in the JSON payload, matching how `listIdeas` does it (`ideas[i].parentUuid = raw.parentUuid ?? null`).

## Query budget

Zero new queries. `parentUuid` is an already-indexed scalar column on rows both surfaces already fetch; it rides along in the existing `select`. The tracker's documented "4 prisma calls" budget is unchanged, and `getAvailableItems` stays at its single idea fetch.

## Testing

- `assignment.service.test.ts` — the existing `getAvailableItems` fixtures return raw idea rows; extend a fixture row with `parentUuid` and assert the formatted response carries it (and that a row without a parent yields `null`).
- `idea-tracker.service.test.ts` — extend a `buildIdeaTracker` fixture idea with `parentUuid` and assert the tracker entry carries it through; assert a parentless idea yields `null`. Because `checkin` and `my_assignments` both call `buildIdeaTracker`, the single tracker test covers both surfaces' runtime behavior.

## Risks

- **Low.** Additive field only; no consumer removes or renames anything. Existing clients ignoring unknown fields are unaffected. The only failure mode is forgetting to update one of the two parallel interfaces (`IdeaTrackerEntry` vs `CheckinIdea`), which `tsc --noEmit` catches.
