## 1. Shared MCP Collection Contract

- [x] 1.1 Add shared page validation, default/max constants, 64 KiB final-serialization guard, 256/512-code-point truncation helpers, pagination metadata helpers, and an executable inventory covering every collection-returning MCP tool.
- [x] 1.2 Add contract tests for default page size 20, maximum enforcement, 64 KiB UTF-8 payload enforcement with long multibyte fixtures, truncation behavior, pagination metadata, preserved collection keys, and bounded-aggregate exemptions.

## 2. Compact Collection Migration

- [x] 2.1 Migrate public project, idea, document, proposal, task, activity, comment, reference, notification, mentionable, and assignment collection handlers to the shared contract with explicit summary projections.
- [x] 2.2 Audit and migrate PM/admin collection handlers and any remaining collection tools; isolate MCP projections from shared REST/UI service behavior and add oversized-fixture regression tests.

## 3. Search And Agent Guidance

- [x] 3.1 Add tenant- and filter-scoped exact UUID lookup to `chorus_search`, preserving bounded text-search fallback, with service and MCP tests.
- [x] 3.2 Update MCP tool descriptions, `docs/MCP_TOOLS.md`, and all maintained Chorus skill/plugin copies to prefer UUID/search discovery and single-resource `get` calls over page scanning.

## 4. Integration Verification

- [x] 4.1 Run the MCP/service test suites and OpenSpec validation, then verify the collection inventory covers all registered collection tools and representative serialized inner JSON responses never exceed 65,536 UTF-8 bytes.
