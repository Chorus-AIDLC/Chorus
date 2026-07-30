## Why

Chorus projects can accumulate enough Ideas, Tasks, Proposals, Documents, comments, activities, and other resources that MCP collection calls consume excessive model context even when the agent only needs an identifier. Existing pagination is inconsistent and list rows often contain detail that belongs in single-resource `get` tools.

## What Changes

- Establish one bounded page-number contract for every MCP tool that returns a resource collection: default page 1, default page size 20, an enforced maximum page size, a 64 KiB UTF-8 ceiling for the serialized inner JSON payload, and explicit `returned`, `page`, `pageSize`, and `total` metadata.
- Replace heavy list rows with resource-specific summaries centered on UUID and title/name, plus only the status or routing fields needed to select the next resource.
- Preserve existing list parameters and top-level collection keys while making omitted pagination bounded; retain detailed data in existing single-resource `get` tools.
- Extend `chorus_search` so an exact UUID can locate a supported entity directly, while preserving text search.
- Update agent-facing tool descriptions and Chorus skill guidance to prefer search or exact UUID lookup over scanning pages.
- Add contract tests that inventory collection-returning MCP tools and enforce row and byte bounds, variable-field truncation, pagination metadata, summary projections, and UUID search behavior.

## Capabilities

### New Capabilities

- `bounded-mcp-collections`: A uniform, compact, backward-compatible response contract for MCP collection tools and an exact-UUID discovery path.

### Modified Capabilities

<!-- None. This cross-cutting MCP response contract is introduced as a new capability. -->

## Impact

- MCP registration and handlers under `src/mcp/tools/`, especially public list and search tools.
- Resource service list projections under `src/services/`.
- MCP contract and regression tests under `src/mcp/__tests__/` and service tests for UUID search.
- Agent-facing MCP documentation and Chorus skill copies across supported plugin ports.
- No database migration or new runtime dependency is required.
