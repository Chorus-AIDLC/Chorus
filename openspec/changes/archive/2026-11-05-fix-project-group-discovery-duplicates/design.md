# Design

## Access boundary

Reuse accessibleGroupWhere, including owner memberships, automatic group admin and child-only discovery. Add an optional transaction client to this helper; firstCompanyUser must use that client so request-level cached state is not reused in a transaction. No capability-bit bypass, global name uniqueness, or hidden resource information in conflicts.

## Creation

Name equality is exact stored-string equality: case, whitespace and Unicode forms are unchanged. In createProjectGroup, validate the creator and query `{ AND: [await accessibleGroupWhere(actor, tx), { name: params.name }] }` before insert, using the same Serializable transaction as group/member/audit writes. On a match throw ApiError(CONFLICT, generic visible-name conflict message, 409). Do not return existing UUIDs or hidden counts.

Retry only Prisma P2034 or a verified adapter serialization conflict (`Error` named `DriverAdapterError` with `cause.kind === "TransactionWriteConflict"`), for at most four transaction attempts. Rethrow other errors and the final serialization failure. Emit the existing change event only after successful commit, once. Re-check visibility on every attempt. All service consumers (REST, MCP, actions) share this guard. Existing creator/visibility validation precedence may be retained.

This narrow classifier supersedes the initial P2034-only assumption under YOLO elaboration round 3, following task review B1. Real PostgreSQL17/Prisma7.10 races demonstrated code-less adapter write conflicts at COMMIT: these must retry rather than produce an internal error while the concurrent request successfully creates the group. Other adapter errors, string errors and generic SQLSTATE-shaped failures are not indiscriminately retried.

Concurrent identical creates by the same owner must yield one created group and one conflict after retry. Two callers unable to see each other's private groups can still legitimately create the same name. This is not global uniqueness; renaming and access changes are not constrained by this patch. A concurrent grant change can be serialized before or after creation; the check follows the transaction's valid snapshot.

## Discovery

Change orderBy from createdAt only to createdAt ascending, uuid ascending. Keep filters, counts and the page envelope intact. Tool descriptions and docs instruct callers to traverse all pages before concluding absence, and explain owner access and exact visible-name conflicts. Search can locate a group, but a miss in bounded search results cannot establish absence (proposal review N1). No cross-page snapshot guarantee during concurrent inserts/deletes, and no automatic permission widening.

## Verification

- Service matrix: explicit viewer/editor/admin owner, automatic admin, child-only visibility, hidden private groups, foreign companies and ownerless agents.
- Guard matrix: visible public/private exact duplicates rejected with no mutation/event; hidden same name allowed; different case/space/Unicode stored strings remain distinct; legacy duplicates unchanged.
- Transaction assertions: Serializable, shared transaction client, both recognized conflict signatures retry then success/conflict, four-attempt exhaustion, non-retryable failures, single post-commit event.
- Database-backed coverage of actual visibility queries and creation; genuine overlapping multi-connection PostgreSQL test for the race when available. PGlite single-connection tests are not evidence of real concurrent transaction overlap; report that limitation explicitly if no multi-connection server is available.
- MCP 24-group fixture with owner-visible private target on page two, empty terminal page, totals/returned/page/pageSize and absence of duplicates; error propagation through create.
- Focused tests, typecheck, lint changed files; independent task and aggregate reviews before completion.

## Rollout and risks

No data migration. Existing duplicate data is left intact and causes future matching visible creates to conflict. Serializable can introduce retry overhead; bound attempts and preserve original infrastructure errors. A stable tie-breaker does not prevent page drift under concurrent writes. The historical app-dev deployment and credentials are not needed or modified.
