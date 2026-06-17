# Technical Design: Agent liveness in the @-mention dropdown

## Overview

Add two fields to each **agent** candidate returned by the mention search —
`online: boolean` and `activeCount: number` — and render them as a dot + count in
the dropdown's agent rows. No new endpoint, no schema change, no new permission;
the mention candidate set is already owner-scoped (a user sees only their own
agents), which is exactly the scope the daemon-connection registry serves.

Data flow:

```
GET /api/mentionables?q=…  (caller = user; agents owner-scoped)
  → mentionService.searchMentionables
      → (existing) resolve agent candidates
      → (new) batch-enrich: for the agent uuids in the result,
          • online      = has ≥1 effectively-online DaemonConnection
          • activeCount = running/queued DaemonExecution rows on those live connections
  → route returns enriched list verbatim
  → mention-editor dropdown renders dot (online) + badge (activeCount>0) on agent rows
```

## Reuse, do not re-model

- **`daemon-connection.service.ts`** owns the liveness rule. Reuse its exported
  `STALE_THRESHOLD_MS` and the `effectiveStatus` derivation
  (`status === "online" && now - lastSeenAt.getTime() <= STALE_THRESHOLD_MS`) —
  do NOT restate the rule, so producer and consumer cannot drift. (Same constant
  the connection page and the execution staleness gate already reuse.)
- **`DaemonExecution`** (merged in PR #323) is the source for `activeCount`: rows
  with `status` in (`running`, `queued`). It carries `agentUuid` and
  `connectionUuid` directly, and is indexed `(connectionUuid, status)` and
  `(companyUuid, agentUuid)`.
- **`StatusDot`** visual language exists on the Agent Connections page
  (`agent-connections/page.tsx`), but the dropdown renders raw DOM (not React),
  so the dot here is a small inline element matching that palette — not an import.

## Data Model

None. No new model, no migration. Two **transport** fields are added to the
existing `Mentionable` interface (`mention.service.ts`), both optional so the
shape stays backward compatible and users simply omit them:

```ts
interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  roles?: string[];
  online?: boolean;       // agents only
  activeCount?: number;   // agents only; running/queued executions
}
```

## Enrichment contract (the core)

A single helper enriches the agent candidates after they're resolved, in BOTH
branches of `searchMentionables` (the empty-query branch at ~:230-257 AND the
search branch at ~:302-319 — easy to miss one; the empty-query branch is the
common "popup just opened" case and MUST be enriched too):

1. Collect the agent candidate uuids (`agentUuids`). If empty, skip (no queries).
2. **Online set** — one query, companyUuid-scoped:
   `prisma.daemonConnection.findMany({ where: { companyUuid, agentUuid: { in: agentUuids } }, select: { agentUuid, status, lastSeenAt } })`.
   An agent is `online` iff ANY of its rows satisfies the `effectiveStatus`
   online rule. Build a `Set<agentUuid>` of online agents.
3. **Active counts** — one query, companyUuid-scoped:
   count `running`/`queued` `DaemonExecution` rows grouped by `agentUuid` for
   `agentUuid in agentUuids`. A `groupBy({ by: ['agentUuid'], where: { companyUuid, agentUuid: { in }, status: { in: ['running','queued'] } }, _count })`
   yields the per-agent count in one round-trip. Build a `Map<agentUuid, number>`.
   - **Liveness coherence**: `activeCount` must be 0 for an agent that is not
     `online` (an offline agent shows no dot and no badge). The execution rows of
     a stale/offline connection are excluded the same way the execution read path
     does it — gate the count on the agent being in the online set (the simplest
     correct rule: if `!online` then `activeCount = 0`). The implementer may
     either filter the groupBy to live connections or zero-out non-online agents
     after the fact; the AC only requires the coherent outcome.
4. Map each agent candidate to `{ ...agent, online, activeCount }`. Users are
   left untouched.

Two queries total regardless of candidate count — no N+1. Both are
companyUuid-scoped; the agent set is already owner-scoped by the existing search,
so visibility is inherited (a user can only ever see their own agents here).

## API Design

- `GET /api/mentionables` — unchanged in shape; it already returns the service
  result via `success(results)`. The enriched fields ride along automatically.
- `chorus_search_mentionables` (MCP) — same: returns the service result. Its
  LLM-facing description is updated to document `online` + `activeCount` on agent
  entries so agent callers know the fields exist.
- No new route, no new query param, no new permission gate.

## Module Contracts

- **One liveness rule, reused.** `online` is derived with the connection
  registry's exact `effectiveStatus` formula and its single `STALE_THRESHOLD_MS`
  — never a second threshold.
- **`activeCount` is daemon-sourced and coherent with `online`.** It counts
  `running`/`queued` `DaemonExecution` rows for the agent; it is 0 whenever the
  agent is not `online`. (So the count never contradicts the dot.)
- **Agent-only.** `online`/`activeCount` are populated for `type === "agent"`
  candidates only; user candidates never carry them, and the dropdown never
  renders a dot/badge on a user row.
- **Additive + optional.** Both fields are optional on `Mentionable`; any
  existing consumer that ignores them is unaffected.

## Frontend (mention-editor.tsx)

The dropdown is rendered as raw DOM in `createSuggestionPopupRenderer` →
`renderList` (`mention-editor.tsx:223-272`). For an **agent** row:

- Replace the existing roles line (`:261-266`) with a status line: a small green
  dot when `online` (title `Online`), nothing when offline (title `Offline` on
  the row's status slot if present) — the dot element carries the localized
  tooltip; and, when `activeCount > 0`, a compact count badge (e.g. "▶ 3" /
  localized "{n} active"). When `activeCount === 0`, no badge.
- The `Mentionable` client type (top of the file) gains the two optional fields.
- User rows are unchanged (name + email, no status line).
- Reduced-motion: the dot is static (no pulse), so nothing to gate — consistent
  with the idea's "restraint in the dropdown" decision.

## Implementation Plan

Single cohesive module (one task): service enrichment + type + MCP description +
frontend render + i18n + tests. It's one vertical slice across a thin surface and
splitting it would add Chorus task overhead for no isolation benefit.

1. Service: `Mentionable` type + batched enrichment helper, wired into both
   branches of `searchMentionables`. Unit tests (Prisma mocked): online iff any
   live connection; activeCount from running/queued; offline ⇒ count 0; users
   unenriched; empty-candidate set issues no liveness queries; companyUuid scope.
2. MCP tool description + `docs/MCP_TOOLS.md`.
3. Frontend: dropdown agent-row dot + count, remove roles line, extend client
   type, localize en + zh. Update `docs/design.pen`.
4. Verify: `tsc` + full suite; manual check that an online owned agent shows the
   dot and (when its daemon is busy) the count, offline shows neither, users
   unaffected.

## Risks & Mitigations

- **Missing the empty-query branch.** `searchMentionables` returns agents from
  two code paths; enriching only the search branch would leave the just-opened
  (empty-query) popup unlit. Mitigation: an AC + a unit test specifically for the
  empty-query branch.
- **`activeCount` contradicting the dot.** If counted naively, a stale connection's
  rows could inflate the count for an agent shown offline. Mitigation: the
  contract zeroes `activeCount` for non-online agents (and/or counts only live
  connections), with a unit test for the offline⇒0 case.
- **Dropdown is non-React DOM.** Changes are imperative string/DOM building, not
  JSX — easy to introduce an unescaped-content or layout regression. Mitigation:
  keep the dot/badge as simple spans matching the existing palette; the existing
  page test + a render assertion guard the agent row.
- **LLM-memory hazards.** Implementer must verify against code, not memory: the
  exact `effectiveStatus`/`STALE_THRESHOLD_MS` export, the `DaemonExecution`
  field names + active statuses, and the two candidate-producing branches in
  `searchMentionables`.
