# Design: section-scoped `chorus_get_proposal`

## Context

`chorus_get_proposal` lives in `src/mcp/tools/public.ts` and is the only caller of
`proposalService.getProposal(companyUuid, uuid)`. That service function loads the
proposal row, runs `formatProposalResponse()`, and returns a `ProposalResponse` whose
`documentDrafts` and `taskDrafts` arrays carry the **full** content of every draft.

The same `getProposal()` is also imported by `src/app/api/proposals/[uuid]/route.ts`
(the frontend's proposal detail page). So we must not change `getProposal()`'s shape —
the frontend renders the full drafts and depends on that contract.

## Goals

1. One tool, four views, selected by a `section` parameter — no new MCP tool.
2. Default response is the cheap index (the bloat fix).
3. Zero change to `getProposal()` and therefore zero REST/frontend impact.
4. Slicing is pure and reuses the already-formatted `ProposalResponse` — no second DB query.

## Decision

### Service layer

Add to `src/services/proposal.service.ts`:

```ts
export type ProposalSection = "basic" | "documents" | "tasks" | "full";

// Lightweight index entries (no heavy text fields)
export interface DocumentDraftIndexEntry {
  uuid: string;
  type: string;
  title: string;
  contentLength: number;   // content.length, so callers can gauge cost before drilling in
}

export interface TaskDraftIndexEntry {
  uuid: string;
  title: string;
  priority?: string;
  storyPoints?: number;
  acceptanceCriteriaCount: number;   // count of acceptanceCriteriaItems (0 if none)
  dependsOnDraftUuids?: string[];    // preserve the DAG so a caller sees structure
}

// The shape returned for section=basic
export interface ProposalBasicResponse {
  // ...all ProposalResponse fields EXCEPT documentDrafts / taskDrafts...
  section: "basic";
  documentDraftCount: number;
  taskDraftCount: number;
  documentDraftIndex: DocumentDraftIndexEntry[];
  taskDraftIndex: TaskDraftIndexEntry[];
}

// section=documents | tasks | full return ProposalResponse-derived shapes carrying a
// `section` discriminator plus only the requested heavy arrays.
export async function getProposalSection(
  companyUuid: string,
  uuid: string,
  section: ProposalSection,
): Promise<ProposalSectionResponse | null>;
```

Implementation:

- `getProposalSection` calls the existing `getProposal(companyUuid, uuid)` once to obtain
  the full `ProposalResponse` (single DB read, existing formatting). Returns `null` if the
  proposal is not found (tool maps that to the existing "Proposal not found" error).
- It then derives the requested slice **in memory**:
  - `basic`: strip `documentDrafts` / `taskDrafts`, emit `documentDraftIndex` +
    `taskDraftIndex` (mapped via small helpers `toDocumentDraftIndex` /
    `toTaskDraftIndex`) and the two counts. `contentLength = (content ?? "").length`;
    `acceptanceCriteriaCount = acceptanceCriteriaItems?.length ?? 0`.
  - `documents`: metadata + `documentDrafts` (full), `taskDrafts` omitted.
  - `tasks`: metadata + `taskDrafts` (full), `documentDrafts` omitted.
  - `full`: the unmodified `ProposalResponse` plus `section: "full"`.
- A `section` discriminator field is added to every returned shape so the agent reading
  the JSON always knows which view it got.

This keeps `getProposal()` and `formatProposalResponse()` 100% intact. The new function is
a thin, pure projection on top of them.

### MCP tool layer

In `src/mcp/tools/public.ts`, `chorus_get_proposal`:

- Extend `inputSchema` with
  `section: z.enum(["basic","documents","tasks","full"]).optional()`.
- Default to `"basic"` when omitted: `const view = section ?? "basic"`.
- Call `proposalService.getProposalSection(auth.companyUuid, proposalUuid, view)`.
- Same not-found handling (`isError: true`, `"Proposal not found"`).
- Expand the tool `description` to document the four sections, the default, and a hint to
  drill into `documents` / `tasks` using the same `proposalUuid`.

### Why not booleans / why not modify `getProposal()`

- A single `section` enum keeps the surface flat and expresses "only documents" cleanly,
  which boolean include-flags cannot do without ambiguous combinations.
- Modifying `getProposal()`'s signature risks a REST caller accidentally receiving a
  trimmed payload; a dedicated function isolates the MCP-only behavior.

## Risks / Trade-offs

- **Breaking default for agents.** Agents that did `chorus_get_proposal({proposalUuid})`
  and read `documentDrafts[].content` now get the index instead. Mitigation: update the
  proposal-reviewer agent and proposal/review skills to fetch `section: "documents"` /
  `section: "tasks"` (or `section: "full"` where a single round-trip is genuinely wanted),
  and document the change in `docs/MCP_TOOLS.md`.
- **Index drift.** If `DocumentDraft` / `TaskDraft` grows new fields, the index mappers
  must be revisited. Mitigation: index mappers are tiny, colocated with the types, and
  covered by unit tests that assert the exact index field set.

## Migration

No data migration. Pure code + skill/doc change. Existing stored proposals are read
through the new projection unchanged.
