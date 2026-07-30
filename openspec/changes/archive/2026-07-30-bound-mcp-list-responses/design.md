## Context

Several public MCP tools already accept `page` and `pageSize`, commonly defaulting to 1 and 20, but the convention is duplicated in handlers, some defaults differ, no common maximum is enforced, and service methods often return full records or nested relations. As a result, a nominally bounded list can still produce a large serialized response. Agents also use collection scans to rediscover known resources because `chorus_search` does not guarantee exact UUID lookup.

The owner confirmed that the first release covers all MCP collection interfaces, uses page-number pagination, defaults to 20 rows, keeps existing parameters compatible, makes list rows primarily UUID/title summaries, and treats a hard per-call response bound as the primary success criterion.

## Goals / Non-Goals

**Goals:**

- Make every MCP collection response predictably bounded without requiring callers to add parameters.
- Standardize pagination metadata while preserving each tool's existing collection key.
- Minimize list-row payloads and direct agents to single-resource tools for details.
- Make exact UUID lookup available through `chorus_search`.
- Prevent future collection tools from bypassing the contract.

**Non-Goals:**

- Cursor pagination or snapshot-consistent traversal during concurrent writes.
- Arbitrary caller-selected fields.
- Replacing single-resource `get` tools or changing their detailed response shapes.
- Changing REST pagination contracts or the dashboard UI except where shared service projections require isolation.
- Bounding detailed single-resource `get` responses, which intentionally preserve full user-authored content.

## Decisions

### 1. Shared collection contract

Introduce MCP-only helpers/constants for `DEFAULT_PAGE = 1`, `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`, and `MAX_COLLECTION_JSON_BYTES = 65_536`. Input schemas accept existing `page` and `pageSize` fields, validate positive integers, and cap or reject values above the documented maximum consistently. Responses retain the current resource key, such as `ideas` or `tasks`, and add:

```json
{
  "ideas": [],
  "returned": 0,
  "page": 1,
  "pageSize": 20,
  "total": 0
}
```

`returned` is the actual row count. Keeping the current collection key and existing metadata is less disruptive than introducing a universal `items` envelope. The alternative, versioning every tool, would create unnecessary migration work for an additive metadata change.

Before wrapping the JSON in MCP text content, the handler measures `Buffer.byteLength(JSON.stringify(payload), "utf8")`. A collection payload MUST be at most 65,536 bytes. If a requested page still exceeds this ceiling after summary projection and field truncation, the shared helper removes rows from the end until it fits and sets `returned` to the emitted row count. `pageSize` continues to report the requested/applied database page size, while `returned` makes byte-cap shortening explicit. If even the metadata plus one fully truncated row cannot fit, the tool returns a structured error rather than emitting an oversized payload.

### 2. Explicit summary projections

Each collection tool defines a typed summary projection rather than serializing full service records and deleting fields afterward. Every row includes `uuid` plus `title` or `name`. It may include compact routing fields such as `status`, `priority`, `type`, `updatedAt`, parent/proposal UUIDs, or small counts when the tool description promises them. It MUST exclude long content, descriptions, comments, document bodies, acceptance criteria, reports, reference bodies, and nested entity graphs.

All user-authored string fields in collection rows are bounded before serialization. Titles, names, labels, and status-like display strings are limited to 256 Unicode code points. Search snippets and any explicitly retained preview text are limited to 512 Unicode code points. Truncation appends `...` within the limit and does not mutate stored data; full values remain available from the detailed `get` tool. UUIDs, timestamps, enums, and machine identifiers are not truncated.

Database-level `select` projections are preferred so heavy columns and relations never enter memory. Where a service method is shared by REST/UI consumers, add an MCP-specific summary method or projection option instead of silently shrinking non-MCP responses.

### 3. Inventory all collection-returning tools

Create a checked inventory of registered MCP tools whose successful response contains zero or more homogeneous resources, including tools named `list`, plural `get`, available/unblocked assignment queries, comments, activities, notifications, references, mentionables, and search. For each tool, record one of:

- adopts the shared page contract and summary projection;
- is inherently capped by a stricter existing limit and is adapted to the same metadata;
- is a bounded aggregate/check-in response with a documented exemption and dedicated size test.

A contract test fails when a newly registered collection tool is absent from this inventory. This makes "all list interfaces" enforceable rather than dependent on naming conventions.

### 4. Exact UUID search before text search

`chorus_search` first recognizes a canonical UUID query. For each requested/supported entity type it performs a tenant-scoped exact UUID lookup and returns the normal compact search result when found. If no exact match exists, normal text search runs unchanged. Entity type and project filters still apply, and the response remains capped by the search limit.

This central discovery path is preferable to adding UUID filters independently to every list tool. Existing direct `get` tools remain the fastest path when the entity type is already known.

### 5. Agent guidance is part of the contract

Tool descriptions for collection calls state that responses are summaries and direct callers to the corresponding `get` tool. `chorus_search` advertises exact UUID support. Chorus skills and MCP documentation use search for discovery and list pagination only for browsing. All maintained plugin copies are updated together to prevent host-specific behavior drift.

### 6. Verification

Tests use oversized fixtures and assert:

- omitted pagination returns at most 20 rows;
- configured page boundaries and metadata are correct;
- the maximum page-size policy cannot be bypassed;
- serialized inner JSON is at most 65,536 UTF-8 bytes, including fixtures with extremely long multibyte titles and snippets;
- summary display strings obey the 256/512-code-point limits and indicate truncation;
- serialized rows omit known heavy fields and nested relations;
- exact UUID search is tenant- and filter-scoped;
- every registered collection tool is covered by the inventory.

## Risks / Trade-offs

- **Compatibility risk from smaller row shapes** -> Retain collection keys and essential routing fields, document the summary contract, and ensure every summarized entity has a detailed `get` path.
- **Byte-cap row reduction can return fewer rows than pageSize** -> Report the actual `returned` count and document that callers should use search for discovery; deterministic ordering still lets callers request subsequent pages.
- **Shared service changes could regress UI/API consumers** -> Use explicit MCP projections or separate summary methods and test REST behavior where services are shared.
- **Inventory can become stale** -> Make it executable through a contract test tied to registered tool names.
- **Exact UUID detection could change ordinary text search** -> Only take the direct path for canonical UUID syntax; fall back to existing search when no exact match is found.

## Migration Plan

1. Add shared pagination/summary helpers and the collection-tool inventory with tests.
2. Migrate collection handlers and service projections in coherent groups, preserving response keys.
3. Add exact UUID search and update tool descriptions, docs, and skill copies.
4. Run MCP and service test suites plus OpenSpec validation.

Rollback is code-only: revert summary projections and helper adoption. No persisted data changes are involved.

## Open Questions

- The implementation task will confirm the final `MAX_PAGE_SIZE`; 100 matches the existing REST ceiling and is the proposed default.
- The inventory audit will determine which bounded aggregate tools merit an explicit exemption rather than page-number pagination.
