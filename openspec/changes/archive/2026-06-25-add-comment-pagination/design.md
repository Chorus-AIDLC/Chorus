# Technical Design: Comment Infinite-Scroll Pagination

## Overview

Convert the universal comment list from a one-shot full fetch to cursor-based infinite scroll. The list keeps its current visual order — **newest comment at the top** — and "scrolling down" loads progressively **older** comments appended below. Real-time new comments continue to arrive via SSE and are merged into the top of the loaded window, de-duplicated by comment `uuid`, without discarding already-loaded older pages or resetting scroll position.

All decisions below trace to the resolved elaboration (Round 1):
1. Newest on top, scroll down loads older. 2. Cursor pagination. 3. Page size **10**. 4. Incremental insert + dedup by uuid (no full reload). 5. Spinner while loading + "no more comments" at end. 6. Change the universal `UnifiedComments` component. 7. `IntersectionObserver` bottom sentinel.

## Architecture

```
UnifiedComments (client)
  state: comments[] (asc by createdAt, rendered reversed → newest on top)
         oldestCursor, hasMore, isLoadingPage, isLoadingInitial
  ── initial: getCommentsAction(target, { limit: 10 })           → newest page
  ── scroll near bottom (IntersectionObserver sentinel)
        → getCommentsAction(target, { cursor: oldestUuid, limit: 10 })  → older page (append below)
  ── SSE ping (useRealtimeEntityEvent) for this entity
        → getCommentsAction(target, { limit: 10 })               → newest page
        → mergeByUuid(existing, incoming)                        → prepend new, dedup
  ── submit (optimistic) → mergeByUuid(existing, [created])      → dedup vs SSE echo

getCommentsAction (server action)  ── cursor passthrough ──▶ comment.service.listComments
GET /api/comments?cursor=&limit=   ── REST parity ──────────▶ comment.service.listComments
chorus_get_comments (MCP)          ── unchanged offset path ─▶ comment.service.listComments
```

## Data Model

No schema change. The `Comment` model already has what a keyset cursor needs:

- `id Int @id @default(autoincrement())` — monotonic tiebreaker (never exposed to the client).
- `uuid String @unique` — the **public** cursor token (UUID-first; we never expose `id`).
- `createdAt DateTime @default(now())` — primary sort key.
- index `@@index([targetType, targetUuid])` — scopes the per-entity query.

**Cursor encoding:** the client passes a comment `uuid` as the opaque cursor. The service resolves it to that comment's `(createdAt, id)` and fetches the next page *strictly older* than it. Using Prisma's native `cursor` + `skip: 1` on a `uuid`-unique field is the simplest correct keyset:

```
orderBy: [{ createdAt: "desc" }, { id: "desc" }]
cursor:  { uuid: <cursorUuid> }   // when provided
skip:    <cursorUuid ? 1 : 0>     // skip the cursor row itself
take:    limit + 1                // fetch one extra to compute hasMore
```

Fetch `limit + 1` rows; if `limit + 1` came back, `hasMore = true` and the extra row is dropped; `nextCursor` = uuid of the last *kept* row. This is robust against new comments being inserted at the head while the user pages older history (the elaboration's stated reason for choosing cursor over offset).

> Note the service's internal cursor query orders **desc** (newest→oldest, natural for "load older"). The component still renders newest-on-top. To avoid a second source of truth for ordering, the cursor path returns comments **newest-first**; the component normalizes into its existing asc-array-then-reverse model (or renders the newest-first array directly — see Module Contracts).

## API Design

### Service: `listComments` (extended, additive)

```ts
interface CommentListParams {
  companyUuid: string;
  targetType: TargetType;
  targetUuid: string;
  // Offset mode (existing — used by MCP + offset REST): both present.
  skip?: number;
  take?: number;
  // Cursor mode (new): when `limit` is present, cursor mode is used.
  cursor?: string | null;   // a comment uuid; null/absent = newest page
  limit?: number;           // page size for cursor mode
}

// Offset mode return (unchanged):
//   { comments: CommentResponse[]; total: number }
// Cursor mode return (new):
//   { comments: CommentResponse[]; total: number; nextCursor: string | null; hasMore: boolean }
```

- Mode is selected by presence of `limit` (cursor) vs `take` (offset). Exactly one mode per call.
- `total` is still returned in cursor mode (one `count` query) so the UI can show an accurate count without loading all pages.
- Cursor-mode comments are returned **newest-first** (`createdAt desc`). Offset mode keeps its current `createdAt asc` contract — **do not** change offset ordering (MCP and any existing consumer depend on it).
- Unknown/invalid `cursor` uuid (not found for this target) → treat as newest page (cursor ignored) rather than throwing, so a stale client cursor degrades gracefully.

### REST: `GET /api/comments`

- New optional query params: `cursor` (comment uuid), `limit` (1–100, default 10).
- When `cursor` or `limit` is present → cursor mode: respond `success({ comments, total, nextCursor, hasMore })`.
- When neither is present → existing offset behavior via `parsePagination` + `paginated(...)` (back-compat).

### Server action: `getCommentsAction`

```ts
getCommentsAction(
  targetType, targetUuid,
  opts?: { cursor?: string | null; limit?: number }
): Promise<
  | { success: true; comments: CommentWithOwner[]; total: number; nextCursor: string | null; hasMore: boolean }
  | { success: false; error: string }
>
```

- Default `limit = 10` when `opts` omitted-but-paginated; when called with no opts at all it still works (newest page, default limit) so callers that only need `total` (the drawer counter) keep working.
- Agent-owner resolution (`resolveAgentOwners`) runs on the page slice, as today.

## Module Contracts

Shared conventions across the tasks in this change:

1. **Ordering contract.** Cursor mode is **newest-first** end-to-end (service → API → action → component). Offset mode stays **oldest-first**. No task may change offset ordering. The component holds comments newest-first internally and renders top-down (dropping the legacy `[...comments].reverse()`), OR keeps an asc array — whichever it chooses, the "newest visually on top" invariant must hold and be covered by a test.
2. **Dedup-merge contract.** A single pure helper `mergeCommentsByUuid(existing, incoming)` (modeled on daemon-chat's `mergeTurnPage`) is the only way new comments enter state from SSE, optimistic submit, or a refetched newest page. Incoming wins on uuid collision; final array preserves the chosen order invariant. It must be unit-tested in isolation. **Burst completeness:** an SSE-triggered refetch must not leave a hole when more than `pageSize` comments were created since the last merge. A single newest-page-of-`pageSize` fetch would only patch the top `pageSize`, while older-cursor paging only walks below the oldest *loaded* row — so comments newer than the oldest-loaded row but beyond the first page would be unreachable. To close this, the SSE refetch loops newest→older pages and merges each until it overlaps an already-loaded uuid (or `hasMore` is false), bounded by a small cap (e.g. 5 pages) to avoid a pathological full reload; if the cap is hit without overlap, fall back to resetting to the newest page (accepting a one-time loss of loaded older history rather than a permanent hole). In normal operation pings are per-comment (and entity events are debounced ~300ms in `realtime-context`), so the first page overlaps immediately and the loop terminates after one fetch.
3. **Cursor token contract.** The cursor is always a comment `uuid` string (never a serial id, never an offset). `nextCursor` is `null` exactly when `hasMore` is false. The component stores `nextCursor` from the *oldest* loaded page and passes it to load the next older page.
4. **Count contract.** Comment count for badges/headers comes from the server `total`, never from `comments.length`. Both `UnifiedComments.onCountChange` and `discussion-drawer` adopt this.
5. **SSE payload reality.** `eventBus.emitChange` carries no comment body — only an entity-changed ping (`entityType`, `entityUuid`, `actorUuid`). "Incremental insert" is therefore implemented as *fetch newest page → merge-dedup*, not as consuming a pushed comment object. Self-authored echoes are still skipped via the existing `event.actorUuid === currentUserUuid` guard, with the optimistic insert already covering the local case.

## Implementation Plan

1. **Service cursor mode** (`comment.service.ts`) + unit tests — foundation; no UI yet.
2. **REST + server action** plumbing (`/api/comments`, `comment-actions.ts`) — exposes cursor mode; keeps offset/back-compat.
3. **Component infinite scroll + SSE merge** (`unified-comments.tsx`, dedup helper, i18n, count-from-total in both callers) — consumes the above end-to-end.

Tasks 2 and 3 depend on 1; task 3 depends on 2. Task 3 is the integration checkpoint (verifies the full first-page → scroll-older → live-merge loop in the running panel).

## Risks & Mitigations

- **Offset/cursor mode confusion in the service.** Mitigation: select mode by a single explicit signal (`limit` present), return shapes documented in Module Contracts, and assert both in tests; never change the offset ordering.
- **Duplicate/jumping comments when SSE refetch overlaps optimistic insert.** Mitigation: all state entry funnels through `mergeCommentsByUuid`; uuid is unique so collisions resolve deterministically.
- **Scroll position jump when older pages append.** Mitigation: older comments append **below** the current viewport (newest stays on top), so appending never shifts what the user is reading; only the sentinel region grows.
- **`IntersectionObserver` firing repeatedly / during initial empty state.** Mitigation: guard with `hasMore && !isLoadingPage && !isLoadingInitial`; disconnect/skip while a page request is in flight.
- **Stale client cursor after archival/edge cases.** Mitigation: service treats an unresolvable cursor as "newest page" instead of throwing.
- **Other `getCommentsAction` callers.** Only two exist (`UnifiedComments`, `discussion-drawer`); both are updated in task 3. The new `opts` arg is optional so the signature stays backward compatible.
- **External-dependency hallucination.** Developers must verify Prisma `cursor`/`skip`/`take` keyset semantics and `IntersectionObserver` options against current docs rather than memory.
