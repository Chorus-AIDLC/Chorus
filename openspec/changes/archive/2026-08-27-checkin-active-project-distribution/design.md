# Technical Design: Checkin active-project distribution + guidance

## Overview

Reshape the `chorus_checkin` payload so session-start injects a compact
project→active-idea-count distribution plus an always-on working-style reminder,
instead of a capped per-idea list. `chorus_get_my_assignments` is untouched and
remains the on-demand full list. The distribution is **derived from the same
`buildIdeaTracker` result** so counts cannot drift from the full list.

## Architecture

Two surfaces:

1. **Server (`checkin.service.ts` + `idea-tracker.service.ts`)** — computes the
   new payload fields.
2. **Plugin/doc copy** — session-start hooks + `MCP_TOOLS.md` describe the new
   shape (the reminder text itself rides in the payload `guidance`, so no
   per-hook reminder string is required).

## Data Model / Payload contract

`CheckinResponse` (in `src/services/checkin.service.ts`):

```ts
// REMOVED
// ideaTracker: Record<string, CheckinProject>;   // CheckinProject = { name, ideas: CheckinIdea[] }

// ADDED
export interface CheckinActiveProject {
  name: string;            // project name ("" if unresolved, same fallback as today)
  activeIdeaCount: number; // count of active ideas on my plate in this project (>= 1)
}
activeProjects: Record<string, CheckinActiveProject>;  // keyed by projectUuid

guidance: string[];        // always-populated, non-empty working-style reminders
```

- `activeProjects` only contains projects with **at least one** active idea
  (empty object when the agent has no active work — same "empty tracker" shape
  as today).
- `CheckinIdea` / `CheckinProject` interfaces are removed from
  `checkin.service.ts` (no longer used by checkin). `IdeaTrackerEntry` /
  `IdeaTrackerProject` in `idea-tracker.service.ts` are unchanged (still used by
  `chorus_get_my_assignments`).

### "Active" definition (unchanged)

Active = exactly what `buildIdeaTracker` already returns: ideas matched by
`buildAssigneeMatch(auth)` (agent OR its instance OR owner), `status != "closed"`,
and derived status `!= "done"` (container/theme ideas roll up their children's
status via the existing Q5 board query). We do **not** re-implement this filter —
see below.

## Count-consistency: derive, don't re-query

The distribution MUST match what `chorus_get_my_assignments` shows for the same
agent. To guarantee that, derive counts from the **uncapped** `buildIdeaTracker`
result rather than writing a second, divergent count query (the divergent-query
mistake is exactly what the 0.7.2 single-source refactor fixed — see the header
comment in `idea-tracker.service.ts`).

New helper in `idea-tracker.service.ts`:

```ts
export async function buildActiveProjectDistribution(
  auth: AuthContext,
  options: BuildIdeaTrackerOptions = {},
): Promise<Record<string, CheckinActiveProject-like>> {
  // Reuse the single source of truth — no maxIdeas cap so counts are accurate
  // across all projects (checkin's old 10-cap must NOT truncate the count).
  const tracker = await buildIdeaTracker(auth, options); // { [projectUuid]: { name, ideas[] } }
  const out: Record<string, { name: string; activeIdeaCount: number }> = {};
  for (const [projectUuid, project] of Object.entries(tracker)) {
    out[projectUuid] = { name: project.name, activeIdeaCount: project.ideas.length };
  }
  return out;
}
```

`checkin.service.ts` then calls `buildActiveProjectDistribution(auth)` (no
`maxIdeas`) in place of the old `buildIdeaTracker(auth, { maxIdeas: 10 })`.

> **Count-match caveat.** Counts match `chorus_get_my_assignments` for the same
> agent whenever both run over the same project set. `getMyAssignments` accepts
> an optional `projectUuids` filter (`assignment.service.ts`); checkin passes
> none (all projects). So for a project-scoped call the two can differ by
> construction — this is pre-existing checkin behavior (checkin has always been
> all-projects), not a regression introduced here. "Match exactly" therefore
> means: same agent, same (all-projects) scope, same active-idea filter.

> **Cap note:** dropping the `maxIdeas: 10` cap means checkin now runs the
> uncapped tracker query — the same cost as one `chorus_get_my_assignments`
> call, run once per session. The container-rollup query still only fires when
> the agent has a container idea on its plate (unchanged). This is an accepted,
> bounded cost; the count would be wrong (silently truncated) if we kept the cap.

### Guidance

`guidance` is a small constant array assembled in `checkin.service.ts` (module
constant). Always non-empty. Content maps 1:1 to the elaboration answers:

```ts
const CHECKIN_GUIDANCE: string[] = [
  "For long-horizon work, use the Chorus skill to follow the AI-DLC workflow (idea → proposal → task → verify) instead of coding ad hoc — see the /chorus skill.",
  "Use chorus_search to locate the specific work the user refers to across ideas, proposals, tasks, and documents. activeProjects tells you WHICH projects hold your work; search to find the exact item — don't treat it as a fixed to-do list.",
];
```

Placing guidance in the payload (not per-hook static text) means every harness
that injects the checkin JSON (Claude Code, Codex, Kiro, and any future harness)
surfaces the reminder for free, with one source of truth.

## Plugin / doc copy

- **CC `public/chorus-plugin/bin/on-session-start.sh`** — replace the Quick
  Reference line
  `- **Idea Tracker**: Shows up to 10 most recently updated ideas. Use chorus_get_ideas() for full list.`
  with a line describing `activeProjects` (project distribution + count) and
  pointing to `chorus_search` (locate specific work) / `chorus_get_my_assignments`
  (full list). Bash 3.2 compatible (string edit only — no new shell features).
- **Kiro `public/kiro-plugin/bin/on-agent-spawn.sh:64`** — same edit, matching
  its phrasing ("the checkin above lists up to 10 …").
- **`src/mcp/tools/public.ts`** — the agent-facing tool **description strings**
  go stale after the rename: `chorus_checkin` (~L491) still describes the idea
  list, and `chorus_get_my_assignments` (~L507) says "same shape as
  checkin.ideaTracker" (now false). Update both description strings —
  checkin → `activeProjects` + `guidance`; my_assignments → full per-idea list.
  Description-only: the handlers serialize the whole service object and never
  destructure `.ideaTracker`, so no handler logic changes and nothing breaks at
  compile time.
- **`docs/MCP_TOOLS.md`** — update the `chorus_checkin` response example
  (`activeProjects` + `guidance`, drop the `ideaTracker` block + its `parentUuid`
  note) and revise the `chorus_get_my_assignments` "structurally identical to
  chorus_checkin.ideaTracker" note to state that checkin now returns a
  distribution while `chorus_get_my_assignments` returns the full list.

## Test plan

`src/services/__tests__/checkin.service.test.ts` — rework the `ideaTracker`
describe block into `activeProjects`:

- Multi-project: `activeProjects[P].activeIdeaCount` equals the number of active
  ideas per project; no `ideas[]` array present.
- Done/closed excluded from the count (mirror existing filter assertions).
- Container rollup: a theme whose children are all done drops out of the count
  (reuse the existing container test fixture).
- Empty state: no active ideas → `activeProjects` is `{}` (and `guidance` still
  present/non-empty).
- `guidance` is a non-empty `string[]` on every checkin response.
- Uncapped: >10 active ideas across projects are all counted (the old 10-cap no
  longer truncates the distribution).

Keep the suite within coverage thresholds (95% lines / 85% branches). Update the
`src/mcp/__tests__/collection-migration.test.ts` checkin mock if it asserts the
`ideaTracker` field.

## Risks & Mitigations

- **Divergent counts** (distribution ≠ my_assignments): mitigated by deriving
  from the same `buildIdeaTracker` result rather than a second query.
- **Cost of uncapped query at every session start**: bounded — equal to one
  `chorus_get_my_assignments`; runs once per session; container query gated as
  before.
- **Hidden consumer of `checkin.ideaTracker`**: grep confirms only the MCP tool
  + tests read it; no frontend/daemon consumer. Rename is safe.
- **Copy drift across harnesses**: the reminder lives in the payload, so only
  the two stale "10 most recent" copy lines + MCP_TOOLS.md need edits; other
  harness docs inherit the payload.
