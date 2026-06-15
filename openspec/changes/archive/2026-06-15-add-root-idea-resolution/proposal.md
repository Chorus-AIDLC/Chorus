# Server-side root-idea resolution endpoint

> **Post-archive revision (2026-06-15):** this change originally exposed resolution as
> a public MCP tool `chorus_resolve_root_idea`. Before merge, the exposure was changed
> to a **standalone REST endpoint** `GET /api/entities/{type}/{uuid}/root-idea`
> (callable with an agent API key, no permission gate), and the daemon was changed to
> call it once per notification with **no client-side fallback walk**. The cumulative
> specs in `openspec/specs/root-idea-resolution/` and `openspec/specs/cli-daemon/`
> reflect the shipped REST design; the delta files below preserve the original MCP
> proposal for history.

## Why

The Chorus CLI daemon anchors each local Claude session on the **root idea** of a
dispatched entity (same root → `--resume` the same session — the "main line"
continuity that makes the daemon useful). To do that, every inbound notification
must be attributed from its entity up to a root idea.

Today that attribution runs **client-side** in `cli/lineage.mjs`, which re-implements
Chorus's data model from the outside:

- Task / Document carry only a nullable `proposalUuid` — no direct `ideaUuid`.
- Proposal carries `inputType` + `inputUuids` (a JSON array) — no `ideaUuid` column.
- Idea carries a single-parent `parentUuid` chain.

So one task attribution costs `get_task` + `get_proposal` + N×`get_idea` =
**3–4 serial MCP round-trips**, paid for every new root (cross-entity, or after a
daemon restart). This duplication causes three concrete problems:

1. **Multi-hop cost** — only a single-run in-memory cache mitigates it.
2. **Client re-implements server semantics** — if the server changes lineage rules
   (multi-idea proposals, documents directly attached to ideas), the client
   silently mis-attributes. The single source of truth should live on the server.
3. **Coverage gaps already shipped in `cli/lineage.mjs`:**
   - **Documents are never attributed** — `lineage.mjs` returns `null`
     unconditionally for documents, even when a document belongs to a proposal that
     belongs to an idea. Those notifications fall to an isolated `entity:document:`
     session instead of the idea's main line.
   - **Multi-idea proposals take only `inputUuids[0]`** — a merged proposal's tasks
     attribute to the first idea, which may not be the intended main line, with no
     signal that the choice was ambiguous.

## What Changes

- **ADD** a public, read-only MCP tool `chorus_resolve_root_idea({ entityType, entityUuid })`
  that resolves an entity to its root idea **server-side in one call** and returns:
  - `rootIdeaUuid: string | null`
  - `lineage: Array<{ type, uuid, title }>` — ordered child→root, zero-cost data for
    the future observability UI (idea `f2fe9a7f` / `c152dcfc`)
  - `resolvedVia: enum` — explains the outcome (`root_idea`, `via_proposal`,
    `via_document_proposal`, `no_proposal`, `proposal_input_not_idea`,
    `standalone_document`, `not_found`) so callers can log a clear attribution trail
  - `ambiguous?: boolean` + `candidates?: string[]` — set when a multi-idea proposal
    forced an `inputUuids[0]` choice
- **ADD** a server lineage service (`resolveRootIdea`) that performs the walk using
  the existing raw `*ByUuid` getters, all scoped by `companyUuid`. This is the new
  single source of truth.
- **CLOSE the document gap server-side**: documents attribute via
  `document.proposalUuid → proposal → idea`; only a standalone document (no proposal)
  returns `null`.
- **DEFINE multi-idea semantics**: return the `inputUuids[0]` root as the main line
  but flag `ambiguous` and list `candidates`, so the daemon stays deterministic
  (one root → one session, the precondition for the WakeQueue's per-key serialization)
  while the ambiguity is visible.
- **MODIFY the daemon** (`cli/lineage.mjs`): prefer the server endpoint, **fall back**
  to the existing client-side walk when the tool is unavailable (older server, tool
  not registered, transport error). The cache / key / session-map are untouched —
  zero-regression, progressive migration. A daemon is an npm package whose version
  need not match the server's, so the fallback is mandatory, not optional.

## Non-goals

- **No REST endpoint.** The only consumer is the daemon, which talks MCP exclusively.
  A REST surface has no consumer today; the lineage service is factored so a future
  `GET /api/entities/{type}/{uuid}/root-idea` is a thin add if observability needs it.
- **No notification-schema change.** Attaching `rootIdeaUuid` to every notification
  (and a migration) benefits only the daemon and over-weights the notification table;
  that belongs to the observability idea (`f2fe9a7f`) if "show the owning idea on
  every notification" ever becomes a general UI need.
- **No permission gate.** Like `chorus_get_idea` / `chorus_get_proposal`, this is a
  public read tool, multi-tenant-scoped by `companyUuid`. The daemon's default
  `allowedTools` already includes `mcp__chorus__*`.

## Capabilities

- `root-idea-resolution` (new) — the server tool + service contract and its
  attribution semantics for every entity type.
- `cli-daemon` (modified) — the lineage-anchored session-continuity requirement now
  resolves via the server endpoint with a client-walk fallback.

## Impact

- New: `src/services/lineage.service.ts`, `chorus_resolve_root_idea` registration in
  `src/mcp/tools/public.ts`, service tests, docs in `docs/MCP_TOOLS.md`.
- Changed: `cli/lineage.mjs` (server-first + fallback), its tests, and the four
  daemon skill/doc surfaces are unaffected (tool is public, no permission row).
- Risk: low. The server tool is additive; the daemon change is guarded by a fallback
  that preserves today's behavior byte-for-byte when the endpoint is absent.
