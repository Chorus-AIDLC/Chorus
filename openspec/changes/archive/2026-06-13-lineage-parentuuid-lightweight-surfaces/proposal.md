# Proposal: Propagate `parentUuid` to the lightweight idea-read MCP surfaces

## Why

The `add-idea-lineage` change (0.10.0) added a single-parent `Idea.parentUuid` self-relation and exposed it on the two "rich" idea-read surfaces — `chorus_get_idea` (full `parent` / `children[]` / `descendantUuids`) and `chorus_get_ideas` (`parentUuid` + `childCount` rollup). The remaining idea-returning surfaces were left on their pre-lineage shapes, so an agent's view of "does this idea have a parent" is inconsistent across tools:

| MCP surface | Returns `parentUuid` today? | Backing |
|---|---|---|
| `chorus_get_idea` | ✅ yes (+ `parent`, `children[]`, `descendantUuids`) | `idea.service` |
| `chorus_get_ideas` | ✅ yes (+ `childCount`) | `idea.service` `listIdeas` |
| `chorus_get_available_ideas` | ❌ no | `assignment.service` `getAvailableItems` |
| `chorus_get_my_assignments` | ❌ no | `idea-tracker.service` `buildIdeaTracker` |
| `chorus_checkin` (`ideaTracker`) | ❌ no | same `idea-tracker.service` shape |
| `chorus_search` (idea hits) | ❌ no | `search.service` generic result |

Concrete pain:

1. An agent discovering claimable work via `chorus_get_available_ideas` cannot tell that an open idea is the child of another idea without a second `chorus_get_idea` round-trip.
2. The `checkin` / `get_my_assignments` tracker views show no lineage, so an agent cannot reason about its assigned ideas' hierarchy at a glance.
3. The lineage forest is currently only buildable from `chorus_get_ideas`; the lightweight discovery/tracker surfaces are blind to it.

## What Changes

Confirmed scope from elaboration (Round 1, all answered):

- **q1 = b** — enrich `chorus_get_available_ideas` **and** the shared idea-tracker shape (`chorus_get_my_assignments` + `chorus_checkin`). Leave `chorus_search` alone (its result type is generic across task/idea/proposal/document/project, so an idea-only field is a poor fit there).
- **q2 = a** — add **only** `parentUuid`. No `childCount` rollup, no parent title. Agents needing more fall back to `chorus_get_idea`.
- **q3 = a** — pure agent-facing payload enrichment. **No** frontend tracker UI changes.

Resulting edits:

- **`assignment.service.ts`** — add `parentUuid` to the `AvailableIdeaResponse` type, the `idea.findMany` `select` in `getAvailableItems`, and the `formatAvailableIdea` mapper. Surfaces on `chorus_get_available_ideas`.
- **`idea-tracker.service.ts`** — add `parentUuid` to the `IdeaTrackerEntry` type, the `idea.findMany` `select` in `buildIdeaTracker`, and the pushed entry. Surfaces on **both** `chorus_get_my_assignments` and `chorus_checkin` in one edit (they share `buildIdeaTracker`).
- **`checkin.service.ts`** — add `parentUuid` to the structurally-parallel `CheckinIdea` interface so the `chorus_checkin` response type stays accurate (the runtime value already flows through `buildIdeaTracker`).
- **`docs/MCP_TOOLS.md`** — update the example payloads / field notes for the three tools to show `parentUuid`.

### Explicitly out of scope

- No `childCount` / parent-title rollup on these lightweight surfaces (q2 = a).
- No `chorus_search` change (q1 = b).
- No frontend / tracker UI change (q3 = a).
- No schema change — `parentUuid` already exists on `Idea`.

## Capabilities

### Modified Capabilities

- `idea-lineage`: extend the "Read-Only Direct-Child Rollup" surface contract so the lightweight discovery and tracker reads also carry the stored `parentUuid` edge (the field only, not the `childCount` rollup).

## Impact

- **Schema**: zero migrations. `Idea.parentUuid` already exists from `add-idea-lineage`.
- **Backend code**: `src/services/assignment.service.ts`, `src/services/idea-tracker.service.ts`, `src/services/checkin.service.ts`.
- **Tests**: `src/services/__tests__/assignment.service.test.ts`, `src/services/__tests__/idea-tracker.service.test.ts` — extend the existing fixtures to assert `parentUuid` is carried through.
- **Docs**: `docs/MCP_TOOLS.md` example payloads for `chorus_checkin`, `chorus_get_my_assignments`, `chorus_get_available_ideas`.
- **No MCP tool added or removed**; no permission-map change; no i18n; no `design.pen` (no UI surface touched).
