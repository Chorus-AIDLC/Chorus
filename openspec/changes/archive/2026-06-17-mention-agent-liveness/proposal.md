# Proposal: Agent liveness in the @-mention dropdown

## Why

When a user @-mentions an agent to hand it work, the @-mention dropdown
(`mention-editor.tsx`, driven by `GET /api/mentionables`) shows only the agent's
name and roles — **not whether the agent has a live daemon connection**. So a
user can @-mention an offline agent, the task sits at `assigned` with no daemon
to pick it up, and there's no signal at the moment of decision.

Bringing the "online" signal forward to the mention-selection moment avoids
"assigned to an agent that nobody's running". And now that the daemon reports
what it's executing (the just-merged `DaemonExecution` model), we can show one
more decision-useful number right there: **how many tasks/resources that agent's
daemon is currently working on** — so a user can prefer an idle online agent over
a busy one.

This is the third consumer of the daemon-connection observability layer (idea
`f2fe9a7f`): siblings put liveness on a dedicated page and (planned) the sidebar;
this one puts it at the point of dispatch.

### Premise correction (verified against code)

The idea originally assumed the mention dropdown lists **company-wide** agents, so
the owner-scoped `GET /api/agent-connections` couldn't cover them and a new
company-scoped endpoint would be needed. The code says otherwise:
`mentionService.searchMentionables` (`src/services/mention.service.ts:288-319`,
and the empty-query branch `:230-257`) returns agent candidates **owner-scoped** —
a user sees only agents they own — exactly the scope the connection registry
already serves. The mention editor's caller is always a human user. So **no new
endpoint, no new permission, and no company-wide visibility change** are needed:
the agents in the dropdown are precisely the agents whose liveness the existing
owner-scoped data already covers.

## What Changes

- **`searchMentionables` enriches each AGENT candidate with two fields** (users
  unchanged): `online: boolean` and `activeCount: number`.
  - `online` reuses the daemon-connection registry's `effectiveStatus` rule
    (`status === "online" && now - lastSeenAt <= STALE_THRESHOLD_MS`): an agent
    is online iff it has at least one effectively-online `DaemonConnection`.
  - `activeCount` is the number of `running`/`queued` `DaemonExecution` rows on
    that agent's effectively-online connection(s) — the same source as the dot
    (both come from the daemon). An offline agent is therefore naturally
    `online: false, activeCount: 0`.
  - Both are resolved in **batch** over the agent candidate set (one connection
    query + one execution `groupBy`), not per-row — no N+1.
- **`GET /api/mentionables` / `chorus_search_mentionables`** pass the enriched
  fields straight through (the route already returns the service result; the MCP
  tool description gains the two fields).
- **`mention-editor.tsx` dropdown** renders, on **agent** rows only:
  - a static green dot when `online` (with an `Online`/`Offline` title tooltip);
    offline agents show no dot (the dropdown is a dense list — restraint over a
    sea of grey dots);
  - a small count badge **only when `activeCount > 0`**;
  - and **removes the existing roles line** (the dot + count take its place).
  - User candidates are untouched (no dot, no count — online is an agent/daemon
    concept).
- **Snapshot at open, no polling**: the dropdown is transient; each mention
  search request naturally returns fresh `online`/`activeCount`, so no in-popup
  polling is added.

## Capabilities

### New Capabilities

- `mention-agent-liveness`: the agent-liveness enrichment of the @-mention
  surface — what `online`/`activeCount` mean, how they're derived (reusing the
  connection registry's `effectiveStatus` + `DaemonExecution`), their
  owner-scoped visibility, and how the dropdown renders the dot + count on agent
  rows (and not on user rows).

### Modified Capabilities

- `mcp-tool-surface`: `chorus_search_mentionables`'s returned agent shape gains
  `online` + `activeCount`. (Additive; same permission gate, same tool.)

## Impact

- **Schema**: none. Reuses `DaemonConnection` and the existing `DaemonExecution`
  model; no migration.
- **Backend**: `src/services/mention.service.ts` (enrich agent candidates in both
  the empty-query and search branches), reusing `STALE_THRESHOLD_MS` /
  `effectiveStatus` from `daemon-connection.service.ts` and a batched
  running/queued count from `DaemonExecution`. The `Mentionable` type gains
  `online?: boolean` + `activeCount?: number`. `GET /api/mentionables` is
  unchanged in shape (passes the service result through).
- **MCP**: `chorus_search_mentionables` description updated to document the two
  new agent fields; `docs/MCP_TOOLS.md` updated.
- **Frontend**: `src/components/mention-editor.tsx` — add the dot + count to agent
  rows, remove the roles line; `Mentionable` client type extended. New
  user-facing strings (tooltip `Online`/`Offline`, count label) localized in
  `en` + `zh`. `docs/design.pen` gets the dropdown agent-row mock.
- **Visibility**: owner-scoped, unchanged — a user only ever sees their own
  agents' liveness, identical to the connection page. No new permission bit.
- **Dependency**: builds on the merged `DaemonExecution` model (PR #323) for
  `activeCount`. The `online` half depends only on the pre-existing
  `DaemonConnection` registry.
- **Out of scope** (carried from the idea's non-goals): no online indicator on
  already-inserted @mention chips; no "online-first" reordering of candidates; no
  in-popup polling; no change to user candidates; no change to mention
  search/ranking beyond adding the two fields.
- **Backward compat**: fully additive. A client that ignores the new fields
  renders exactly as before; the fields are optional on the type.
