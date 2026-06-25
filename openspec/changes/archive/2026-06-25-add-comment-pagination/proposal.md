## Why

The universal comment component (`UnifiedComments`) fetches **all** comments for an entity at once (hardcoded `take: 100`) and renders them in a single non-scrolling list. On entities with many comments, the detail panel's first paint blocks on the full comment payload + render, making the panel feel slow to open. Loading only the first page and incrementally fetching the rest on scroll keeps first paint fast while still letting users browse the full history.

## What Changes

- **Cursor-based pagination in the comment service.** `listComments` gains an optional cursor mode (fetch the page of comments *older than* a given comment), keyed on a stable `(createdAt, id)` keyset exposed publicly as a comment `uuid` cursor. The existing offset (`skip`/`take`) mode is preserved unchanged so `chorus_get_comments` (MCP) and the offset query path keep working.
- **REST `/api/comments` cursor support.** The GET endpoint accepts an optional `cursor` (a comment uuid) and `limit`, and returns `{ comments, nextCursor, hasMore }` for the cursor path while the existing paginated (offset) response stays for back-compat callers.
- **Server action gains pagination.** `getCommentsAction` accepts an optional cursor + limit and returns `{ comments, total, nextCursor, hasMore }`.
- **`UnifiedComments` becomes infinite-scroll.** First paint loads only the newest page (10 comments). A scroll container plus an `IntersectionObserver` bottom sentinel auto-loads the next (older) page as the user nears the end. Newest comments stay at the top; "down-scroll" loads older history (appended below). A spinner shows while a page loads, and an end-of-list "no more comments" affordance shows when the oldest comment is reached.
- **SSE coexists with pagination via incremental, de-duplicated merge.** The current "any entity change → reload the whole list" behavior is replaced: on a comment SSE ping the component fetches the newest page and merges it into state **de-duplicated by comment uuid** (reusing the proven `mergeTurnPage`-style union from daemon-chat), so live new comments prepend to the top without discarding already-loaded history or resetting scroll position. Optimistic insert on submit is likewise de-duped against the SSE echo.
- **Comment count switches from array length to server `total`.** Because the list is now partial, `onCountChange` (and the proposal `discussion-drawer` counter) must use the server-reported `total`, not `comments.length`, to stay accurate.

## Capabilities

### New Capabilities
- `comment-pagination`: Cursor-based, infinite-scroll loading of the universal comment list — first-page-only first paint, scroll-to-load-older, and incremental de-duplicated coexistence with real-time comment delivery; backed by a comment-service cursor mode that leaves the existing offset path intact.

### Modified Capabilities
<!-- None. No existing spec captures comment-list behavior; this is purely additive. -->

## Impact

- **Frontend:** `src/components/unified-comments.tsx` (scroll container, IntersectionObserver, paged + merged state, SSE incremental merge), `src/app/(dashboard)/projects/comment-actions.ts` (`getCommentsAction` pagination), `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/discussion-drawer.tsx` (count from `total`). New i18n keys in `messages/en.json` + `messages/zh.json` (loading-more, no-more-comments).
- **Backend:** `src/services/comment.service.ts` (`listComments` cursor mode), `src/app/api/comments/route.ts` (GET cursor params + response).
- **Unchanged / back-compat:** `chorus_get_comments` MCP tool (`src/mcp/tools/public.ts`) keeps using offset mode; the `POST /api/comments` create path and `createCommentAction` are untouched. No Prisma schema change — cursor keys on the existing `(targetType, targetUuid)` index + `createdAt`/`id`.
- **Tests:** `src/services/__tests__/comment.service.test.ts` extended for cursor mode; component-level test for paged load + dedup merge.
