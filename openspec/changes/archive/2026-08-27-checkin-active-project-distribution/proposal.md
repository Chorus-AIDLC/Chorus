# Checkin/session-start: active-project distribution + AI-DLC/search guidance

## Why

Today `chorus_checkin` returns `ideaTracker` — a per-project list of every
assigned-to-me, not-done idea, capped at the 10 most-recently-updated across
**all** projects. The Chorus plugin `SessionStart` hook injects that whole
payload verbatim into the agent's context, and the Quick Reference frames it as
"Shows up to 10 most recently updated ideas."

Two problems with injecting that list at session start:

1. **Noisy and misleading.** The list mixes ideas from every project the agent
   has ever been assigned to (including throwaway / unrelated ones). An agent
   reads it as a static to-do list to burn down, rather than as "where my work
   lives."
2. **Stale by construction.** The snapshot captured at session start is not what
   the human is asking for *now*. The right behavior is: know which projects you
   are advancing, then **search** to locate the specific work the human refers
   to — not march down an injected list.

This change reshapes the session-start injection to a compact **project
distribution** (which projects I'm advancing ideas in, and how many), and adds
an always-on **working-style reminder** (use the Chorus skill to follow AI-DLC;
use `chorus_search` to locate work across resources).

Elaboration decisions (idea `e8f3af04`, Round 1):

- **Shape** — per project show `name` + active-idea **count** only; no per-idea
  titles/uuids. "Mainly present the project."
- **"Active" definition** — unchanged from today: assigned to me (or my
  instance), not `closed`, not rolled-up `done`.
- **Reminder trigger** — always shown at every session start.
- **Reminder content** — (a) use the Chorus skill to understand Chorus / follow
  AI-DLC, and (b) use `chorus_search` to cross-resource locate the work.
- **Blast radius** — change `chorus_checkin` / session-start only.
  `chorus_get_my_assignments` keeps returning the full idea list (the on-demand
  full entry point). Owner also confirmed the plugin/doc copy should be updated
  to match.

## What Changes

- **`chorus_checkin` payload (`CheckinResponse`)**
  - Replace `ideaTracker: Record<projectUuid, { name, ideas[] }>` with
    `activeProjects: Record<projectUuid, { name, activeIdeaCount }>` — a
    project→count distribution, no per-idea payload.
  - Add `guidance: string[]` — an always-populated array of short working-style
    reminders (AI-DLC via the Chorus skill; `chorus_search` cross-resource
    location). Injected verbatim by every harness that dumps the checkin payload.
- **`chorus_get_my_assignments` — unchanged.** It keeps its full, uncapped
  `ideaTracker` + `taskTracker`. The shared `buildIdeaTracker` output shape is
  **not** modified; the distribution is derived from it so the count matches
  exactly what `chorus_get_my_assignments` would show.
- **Plugin / doc / tool-description copy**
  - `public/chorus-plugin/bin/on-session-start.sh` and
    `public/kiro-plugin/bin/on-agent-spawn.sh`: drop the stale "up to 10 most
    recently updated ideas" Quick Reference line; describe the active-project
    distribution and point to `chorus_search` / `chorus_get_my_assignments` for
    the full list.
  - `src/mcp/tools/public.ts`: refresh the `chorus_checkin` and
    `chorus_get_my_assignments` tool **description strings** (the latter says
    "same shape as checkin.ideaTracker", now false). Description-only — no
    handler logic change.
  - `docs/MCP_TOOLS.md`: update the `chorus_checkin` example shape
    (`activeProjects` + `guidance`) and the `chorus_get_my_assignments` note
    (it is no longer "structurally identical" to checkin — the two now diverge:
    checkin = distribution, my_assignments = full list).

## Capabilities

- `agent-checkin-context` — what the agent checkin / session-start payload
  surfaces about the agent's in-flight work and how to work on it.

## Impact

- **Affected code**: `src/services/checkin.service.ts`,
  `src/services/idea-tracker.service.ts` (add a distribution derivation; the
  existing `buildIdeaTracker`/`buildTaskTracker` signatures are untouched),
  `src/services/__tests__/checkin.service.test.ts`.
- **Affected plugins/docs/tool-descriptions**: CC `on-session-start.sh`, Kiro
  `on-agent-spawn.sh`, `src/mcp/tools/public.ts` (description strings only),
  `docs/MCP_TOOLS.md`.
- **Consumers**: only the MCP `chorus_checkin` tool (`src/mcp/tools/public.ts`)
  and tests read `CheckinResponse.ideaTracker`. No frontend consumer. The field
  rename is an intentional, self-contained payload change.
- **Not in scope**: `taskTracker` presentation; `chorus_get_my_assignments`
  shape; any change to the "active" filter semantics.
