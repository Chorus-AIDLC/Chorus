# Tasks: Comment Infinite-Scroll Pagination

## 1. Comment service cursor mode
- [ ] Extend `listComments` in `src/services/comment.service.ts` with an additive cursor mode (selected by `limit`): newest-first `(createdAt desc, id desc)`, Prisma `cursor: { uuid }` + `skip: 1` + `take: limit + 1` to compute `hasMore`/`nextCursor`; return `{ comments, total, nextCursor, hasMore }`.
- [ ] Preserve the existing offset mode (`skip`/`take`, oldest-first) byte-for-byte; treat an unresolvable cursor as the newest page (no throw).
- [ ] Unit tests in `src/services/__tests__/comment.service.test.ts`: first page, cursor page (strictly older, excludes cursor row), hasMore/nextCursor boundary, total accuracy, stale cursor fallback, offset mode unchanged.

## 2. REST + server action pagination
- [ ] `GET /api/comments` accepts optional `cursor` + `limit`; cursor mode → `success({ comments, total, nextCursor, hasMore })`; no cursor/limit → existing `paginated(...)` offset response.
- [ ] `getCommentsAction` accepts optional `{ cursor, limit }` (default limit 10), returns `{ comments, total, nextCursor, hasMore }`; resolve agent owners on the page slice; signature stays backward compatible (opts optional).

## 3. Component infinite scroll + SSE merge + count-from-total
- [ ] `UnifiedComments`: scroll container + `IntersectionObserver` bottom sentinel; first paint loads page 1 (10), scroll loads older pages appended below, newest stays on top; guard against stacked/empty/at-end triggers; spinner + "no more comments" affordances.
- [ ] Add pure `mergeCommentsByUuid(existing, incoming)` helper (modeled on daemon-chat `mergeTurnPage`); route SSE refetch, optimistic submit, and newest-page refetch through it (dedup by uuid, preserve order + scroll). SSE refetch loops newest→older pages until it overlaps an already-loaded uuid (or `hasMore` false), bounded by a small page cap with a reset-to-newest fallback, so a burst of >pageSize new comments leaves no unreachable gap.
- [ ] Switch comment count to server `total` in `UnifiedComments.onCountChange` and `discussion-drawer.tsx`; add i18n keys (loading-more, no-more-comments) to `messages/en.json` + `messages/zh.json`.
- [ ] Integration verification: in the running panel, open an entity with >10 comments → only 10 load → scroll loads older → a live comment from another session merges at top with no duplicate and no scroll jump. Tests for the merge helper + render order.
- [ ] Update `docs/design.pen` for the comment component's paginated/infinite-scroll states (loading-more spinner, end-of-list).
