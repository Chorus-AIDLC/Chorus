# Design: root-idea resolution

## Context

`cli/lineage.mjs` (the daemon's client-side resolver) is the reference algorithm
being ported to the server. Its walk:

```
entity → idea uuid → walk parentUuid to top
  task     : get_task.proposalUuid → ideaFromProposal
  proposal : ideaFromProposal
  idea     : itself
  document : null  (gap)
  ideaFromProposal: get_proposal; inputType==="idea" ? inputUuids[0] : null  (multi-idea gap)
```

The data model (verified against `prisma/schema.prisma`):

- `Task.proposalUuid: String?` (nullable; quick tasks have none)
- `Document.proposalUuid: String?` (nullable; standalone docs have none)
- `Proposal.inputType: String` + `Proposal.inputUuids: Json` (array; idea-derived
  proposals set `inputType="idea"`, `inputUuids` = source idea uuids)
- `Idea.parentUuid: String?` (single-parent forest edge)

All four entities expose a raw `*ByUuid(companyUuid, uuid)` service getter
(`getTaskByUuid`, `getProposalByUuid`, `getDocumentByUuid`, `getIdeaByUuid`) that is
a plain `prisma.<model>.findFirst({ where: { uuid, companyUuid } })` — these are the
building blocks. The service never crosses the company boundary.

## Goals / Non-Goals

- **Goal**: one server call resolves entity → root idea, as the single source of
  truth; close the document gap; make multi-idea ambiguity explicit; keep the daemon
  deterministic (one root → one session).
- **Non-goal**: REST surface, notification-schema change, permission gating, changing
  the daemon's cache/key/session-map.

## Service contract — `resolveRootIdea`

```
resolveRootIdea(companyUuid, entityType, entityUuid) -> {
  rootIdeaUuid: string | null,
  lineage: Array<{ type: "task"|"document"|"proposal"|"idea", uuid: string, title: string | null }>,
  resolvedVia: ResolvedVia,
  ambiguous?: boolean,
  candidates?: string[],   // root idea uuids, when ambiguous
}
```

`ResolvedVia` enum and meaning:

| value | meaning | rootIdeaUuid |
|---|---|---|
| `root_idea` | entity is an idea (or resolved idea) and walked to a root | non-null |
| `via_proposal` | task → proposal(inputType=idea) → idea → root | non-null |
| `via_document_proposal` | document → proposal(inputType=idea) → idea → root | non-null |
| `no_proposal` | task/document with no proposalUuid (quick task / standalone) | null |
| `proposal_input_not_idea` | proposal/derived has `inputType !== "idea"` | null |
| `standalone_document` | document with no proposalUuid | null |
| `not_found` | entity uuid not found in this company | null |

`null` is a **successful** result, not an error — "no idea ancestor" is a legitimate
outcome the daemon handles by falling back to a per-entity session key. This avoids
the earlier `#isSessionExpired` trap where a literal "not found" string was
misclassified.

### Algorithm

```
1. Resolve entity → starting idea uuid + provenance:
   - idea     → (entityUuid, root_idea)
   - proposal → ideaFromProposal(proposal)
   - task     → t = getTaskByUuid; t? : (no proposalUuid → null/no_proposal)
                                        : ideaFromProposal(t.proposalUuid) [via_proposal]
                not found → null/not_found
   - document → d = getDocumentByUuid; d? : (no proposalUuid → null/standalone_document)
                                            : ideaFromProposal(d.proposalUuid) [via_document_proposal]
                not found → null/not_found
2. ideaFromProposal(proposalUuid):
   - p = getProposalByUuid; not found → null/not_found
   - p.inputType !== "idea" → null/proposal_input_not_idea
   - ideas = inputUuids (string[]); empty → null/proposal_input_not_idea
   - startIdea = ideas[0]; ambiguous = ideas.length > 1; candidates = ideas
3. walkToRoot(startIdea):
   - follow getIdeaByUuid(...).parentUuid up to MAX_PARENT_HOPS (50)
   - visited-set cycle guard (matches the client walk)
   - returns the topmost idea uuid
4. lineage[] is accumulated child→root as each hop resolves, carrying each entity's
   title for the observability UI; the root idea's parentUuid resolution feeds the
   ambiguity flags through unchanged.
```

The ambiguity flags reflect the **proposal** step (multi-idea input), independent of
how deep the parent walk goes. When ambiguous, `candidates` are the **root ideas** of
each `inputUuids` entry (each walked to its own top), so a future consumer sees the
real set of main lines — but `rootIdeaUuid` remains `candidates[0]` to keep the
daemon's session anchor single-valued.

## MCP tool — `chorus_resolve_root_idea`

Registered in `registerPublicTools` (public.ts), no permission gate, alongside
`chorus_get_idea`:

```
inputSchema: { entityType: z.enum(["task","document","proposal","idea"]), entityUuid: z.string() }
handler: resolveRootIdea(auth.companyUuid, entityType, entityUuid) → JSON.stringify
```

Not added to `permission-map.ts` (read tools are public there). Documented in
`docs/MCP_TOOLS.md` as a public tool.

## Daemon integration — `cli/lineage.mjs`

`LineageResolver.rootIdeaFor` becomes **server-first with fallback**:

```
rootIdeaFor(event):
  cache hit → return
  try:
    r = mcp.callTool("chorus_resolve_root_idea", { entityType, entityUuid })
    if r is a well-formed object (has rootIdeaUuid field, possibly null):
       root = r.rootIdeaUuid           // server is source of truth, incl. null
  catch toolUnavailable(err):           // older server / tool not registered
    root = <existing client-side walk>  // unchanged #toIdeaUuid/#walkToRoot path
  cache.set; return root
```

- **Tool-unavailable detection**: the SDK surfaces an unknown tool as a tool/method
  error. We must distinguish "tool not registered on this server" (→ fall back to the
  client walk) from a transient transport error (already retried once by
  `ChorusClient.callTool`) and from a legitimate `null` result (→ use it, do NOT fall
  back). A `null` rootIdeaUuid in a well-formed response is authoritative — fallback
  fires only when the call itself fails or returns a non-conforming shape.
- The cache, key derivation, and session-map are untouched, so the per-root-idea
  WakeQueue serialization and the existing tests' invariants hold.
- The client-side `#toIdeaUuid` / `#walkToRoot` / `#ideaFromProposal` methods stay as
  the fallback implementation — they are not deleted.

## Risks / Trade-offs

- **Server/daemon version skew** → mandatory fallback (chosen over hard dependency).
- **Document attribution now active** → a document notification that previously fell
  to `entity:document:` will now (correctly) join its idea's session. This is the
  intended fix, not a regression; called out so reviewers expect the behavior change.
- **Ambiguous multi-idea** → deterministic `candidates[0]` keeps session anchoring
  stable; the flag lets a future UI surface the ambiguity rather than hiding it.

## Migration

None. Additive server tool; daemon change is backward-compatible via fallback. No
schema change, no data migration.

## Test plan

- Service unit tests (`lineage.service.test.ts`): each entity type, each `resolvedVia`
  branch, multi-idea ambiguity, cycle guard, cross-company isolation (getter returns
  null for another company's uuid), deep parent walk.
- Daemon tests (`lineage.test.mjs`): server-first happy path (uses server result incl.
  null), fallback when the tool call throws an unavailable-tool error, no-fallback when
  the server returns a well-formed null, cache still single-flight.
