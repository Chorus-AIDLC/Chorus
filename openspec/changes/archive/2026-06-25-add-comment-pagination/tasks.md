# Tasks: Comment Infinite-Scroll Pagination

## 1. Comment service cursor mode
- [x] Extend `listComments` in `src/services/comment.service.ts` with an additive cursor mode (selected by `limit`): newest-first `(createdAt desc, id desc)`, Prisma `cursor: { uuid }` + `skip: 1` + `take: limit + 1` to compute `hasMore`/`nextCursor`; return `{ comments, total, nextCursor, hasMore }`.
- [x] Preserve the existing offset mode (`skip`/`take`, oldest-first) byte-for-byte; treat an unresolvable cursor as the newest page (no throw).
- [x] Unit tests in `src/services/__tests__/comment.service.test.ts`: first page, cursor page (strictly older, excludes cursor row), hasMore/nextCursor boundary, total accuracy, stale cursor fallback, offset mode unchanged.

## 2. REST + server action pagination
- [x] `GET /api/comments` accepts optional `cursor` + `limit`; cursor mode → `success({ comments, total, nextCursor, hasMore })`; no cursor/limit → existing `paginated(...)` offset response.
- [x] `getCommentsAction` accepts optional `{ cursor, limit }` (default limit 10), returns `{ comments, total, nextCursor, hasMore }`; resolve agent owners on the page slice; signature stays backward compatible (opts optional).

## 3. Component infinite scroll + SSE merge + count-from-total
- [x] `UnifiedComments`: scroll container + `IntersectionObserver` bottom sentinel; first paint loads page 1 (10), scroll loads older pages appended below, newest stays on top; guard against stacked/empty/at-end triggers; spinner + "no more comments" affordances.
- [x] Add pure `mergeCommentsByUuid(existing, incoming)` helper (modeled on daemon-chat `mergeTurnPage`); route SSE refetch, optimistic submit, and newest-page refetch through it (dedup by uuid, preserve order + scroll). SSE refetch loops newest→older pages until it overlaps an already-loaded uuid (or `hasMore` false), bounded by a small page cap with a reset-to-newest fallback, so a burst of >pageSize new comments leaves no unreachable gap.
- [x] Switch comment count to server `total` in `UnifiedComments.onCountChange` and `discussion-drawer.tsx`; add i18n keys (loading-more, no-more-comments) to `messages/en.json` + `messages/zh.json`.
- [x] Integration verification: covered by jsdom render tests (`src/components/__tests__/unified-comments.test.tsx`) — first-page-only load (10), sentinel-triggered older-page append, newest-on-top order, merge dedup of the optimistic echo, and the burst-completeness sweep. (Live in-browser walkthrough deferred — this was authored in a headless daemon session without a browser; the render + helper tests assert the same behaviors.)
- [ ] Update `docs/design.pen` for the comment component's paginated/infinite-scroll states (loading-more spinner, end-of-list). **Deferred — follow-up required.** Could not complete in the headless daemon session: the Pencil MCP server is rooted at a different repo (`/home/ubuntu/dev/strands-ai-sdk`) and requires an interactive editor, and CLAUDE.md forbids hand-editing the encrypted `.pen` file. Needs a follow-up in an interactive Pencil session pointed at the ai-pm repo.
