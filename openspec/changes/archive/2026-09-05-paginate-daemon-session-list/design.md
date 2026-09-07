# Design — Paginate the daemon session/conversation list

## Context

`GET /api/daemon-sessions` → `getVisibleSessionsWithOrigin(auth)` →
`getVisibleSessions(auth)`:

```ts
// daemon-session.service.ts
const rows = await prisma.daemonSession.findMany({
  where: { companyUuid, ...ownerScope(auth) },
  orderBy: { lastTurnAt: "desc" },        // NO take/limit — full history
});
await reconcileOrphanTurnsForSessions(companyUuid, rows);  // over ALL rows
return rows.map(toSessionView);
```

`getVisibleSessionsWithOrigin` then batches three enrichment queries (connection
liveness, `getFirstInstructionBySessionUuid`, idea titles) over that full set.

The chat client (`daemon-chat.tsx`) is **agent-first**: it derives the agent Select from
`connections ∪ sessions`, default-selects the most-recent agent, filters `sessions` to the
selected agent, sorts by `lastTurnAt` desc, and slices to `visibleCount` (12, +12 per
"Load more"). It fetches the full list on mount and every 15s.

## Goals

- The chat modal never loads more session rows than it shows.
- Enrichment + reconcile cost scales with a page (≤ limit), not total history.
- No behavior change for non-chat callers (`connections-view` tests, send box).
- Preserve the agent-first UX: the Select still lists every agent with history, the default
  agent is still the most-recent, older conversations still reachable via "Load more".

## Decisions

### D1 — Paginate per agent, not globally

The UI shows exactly one agent's conversations at a time. A global newest-first cursor
would return a page mixing agents, so selecting agent X could show zero of X's rows until
many pages load. Pagination is therefore **scoped by `agentUuid`**, matching the render
model 1:1.

### D2 — Agent index is a separate cheap mode

The Select and default-agent selection need the set of agents that have history and which
is most recent — a global fact the per-agent page cannot provide. A dedicated
`?view=agents` mode answers it with a single `GROUP BY agentUuid` (`_count`, `max(lastTurnAt)`),
owner/company-scoped, with **no** enrichment and **no** reconcile. Cost is O(distinct agents),
independent of total session count.

Agents currently connected but with no history still appear in the Select because the client
already unions the agent index with the live `connections` list — the index only needs to
contribute agents that have **history** (possibly disconnected).

### D3 — Keyset cursor on `(lastTurnAt desc, uuid desc)`

`lastTurnAt` is not unique, so the cursor is the composite `(lastTurnAt, uuid)`. We mirror
the existing `comment.service.ts` pattern: `orderBy: [{ lastTurnAt: "desc" }, { uuid: "desc" }]`,
`cursor: { uuid: <before> }, skip: 1`, `take: limit + 1` (the extra row is the `hasMore`
sentinel — no count query). `nextCursor` is the last returned row's `uuid`.

- Prisma `cursor` seeks to the row with that `uuid`, then applies the compound `orderBy`, so
  the `(lastTurnAt, uuid)` ordering is stable across pages even with tied timestamps.
- `limit` defaults to `DEFAULT_SESSION_PAGE = 12` (matches the client `PAGE_SIZE`), clamped to
  `1..100`.
- Empty/absent `before` → first page.

### D4 — Enrich + reconcile only the page

`getVisibleSessionsWithOrigin` gains a paginated variant that, given the page rows, runs the
same three enrichment queries + `reconcileOrphanTurnsForSessions` scoped to those ≤ limit
rows. The full-history path is retained unchanged for the legacy no-param mode.

### D5 — Route contract (additive, backward-compatible)

`GET /api/daemon-sessions`:

| Query | Response | Notes |
|---|---|---|
| _(none)_ | `{ sessions: SessionTargetView[] }` | **Unchanged** — full list, enriched, legacy. |
| `?view=agents` | `{ agents: { agentUuid, lastTurnAt, sessionCount }[] }` | Cheap GROUP BY; no enrichment/reconcile. |
| `?agentUuid=&limit=&before=` | `{ sessions: SessionTargetView[], nextCursor: string \| null, hasMore: boolean }` | Per-agent page, newest-first, enriched over the page. |

- `agentUuid` is validated under the caller's owner/self scope (reuse the existing
  `callerOwnsAgent` fence in `daemon-instruction.service.ts`); an agent the caller may not see
  yields an empty page (non-disclosure), never another owner's rows.
- Mode is chosen by params: `view=agents` wins; else `agentUuid` present → page mode; else
  legacy. Invalid `limit`/`before` are clamped/ignored, not errors.

### D6 — Client data layer (chat modal only)

`daemon-chat.tsx`:

- **Agent axis:** on mount + 15s poll, fetch `?view=agents`; merge with `connections` for the
  Select; `mostRecentAgentUuid` = the index's max-`lastTurnAt` agent (fallback to
  `connections`/first agent as today).
- **Rows:** on selected-agent resolve/change, fetch `?agentUuid=&limit=12` → the page becomes
  the row source (replacing the client-side per-agent filter + slice). Track `nextCursor`/`hasMore`.
- **Load more:** fetch `?agentUuid=&before=<nextCursor>&limit=12`, append (dedup by `uuid`).
- **Poll:** refetch the selected agent's first page (resettles `originOnline`, surfaces new
  conversations at the top) — bounded, not the whole history.
- **Live merges:** `handleSessionStarted` (prepend/patch) and the SSE transcript subscription
  are unchanged — they mutate the loaded page array. A started conversation for the selected
  agent prepends; the agent index refreshes on the next poll so a brand-new agent's entry
  appears.
- `conversation-list.tsx`: `onLoadMore` now triggers a server page fetch; `hasMore` comes from
  the server. `visibleCount` client slice is removed for the chat path.

### D7 — Non-chat callers untouched

`connections-view.tsx` (referenced only by tests now) and `send-instruction-box` receive the
`sessions` array via the no-param default, whose shape/bytes are unchanged. No edits there.

## Risks / Trade-offs

- **More round-trips on open** (agent-index + first page) vs one big fetch — but each is small
  and bounded; net latency drops at the user's scale, and both can run in parallel.
- **Agent index staleness** between polls — acceptable; the Select is coarse and the 15s poll
  reconverges, same cadence as today.
- **Cursor correctness with live inserts** — a conversation whose `lastTurnAt` advances mid-paging
  could shift pages; dedup-by-`uuid` on append prevents duplicates, and "Load more" is
  best-effort history, so a rare re-order is harmless (matches the transcript pager's stance).

## Test Plan

- Service: agent-index aggregation (counts, max lastTurnAt, owner scope); per-agent page
  (ordering, `limit` clamp, cursor `before`, `hasMore` sentinel, empty page, cross-owner
  non-disclosure); enrichment/reconcile scoped to the page; legacy no-param path unchanged.
- Route: mode selection by params; legacy default byte-shape; agent scope validation.
- Client: agent-index → Select + default agent; per-agent first page; "Load more" appends via
  server cursor; poll refetches first page; live prepend/SSE still merge; existing
  loading-skeleton behavior (`deriveChatBodyState`) preserved.
