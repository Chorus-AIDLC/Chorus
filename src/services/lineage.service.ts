// src/services/lineage.service.ts
// Server-side "entity → root idea" resolution. Single source of truth for
// attributing any entity (task / document / proposal / idea) up the Chorus
// lineage to the topmost idea of its forest. This replaces the daemon's
// client-side multi-hop walk (cli/lineage.mjs): the daemon now prefers calling
// the chorus_resolve_root_idea MCP tool, which delegates here.
//
// Data model (prisma/schema.prisma):
//   • Task.proposalUuid      String?  (nullable; quick tasks have none)
//   • Document.proposalUuid  String?  (nullable; standalone docs have none)
//   • Proposal.inputType     String   ("idea" | "document")
//   • Proposal.inputUuids    Json     (string[]; for inputType="idea" these are idea uuids)
//   • Idea.parentUuid        String?  (single-parent forest edge)
//
// Every read goes through the raw `*ByUuid(companyUuid, uuid)` getters, which
// are `findFirst({ where: { uuid, companyUuid } })` — so the walk never crosses
// the company boundary. A missing entity (or one in another company) resolves to
// null/not_found, never a thrown error: "no idea ancestor" is a legitimate,
// successful outcome the daemon handles by falling back to a per-entity session.

import { getTaskByUuid } from "@/services/task.service";
import { getProposalByUuid } from "@/services/proposal.service";
import { getDocumentByUuid } from "@/services/document.service";
import { getIdeaByUuid } from "@/services/idea.service";

/** Entity kinds the resolver accepts as a starting point. */
export type LineageEntityType = "task" | "document" | "proposal" | "idea";

/** Why the resolution produced (or failed to produce) a root idea. */
export type ResolvedVia =
  | "root_idea" // entity is/resolved to an idea, walked to its root
  | "via_proposal" // task → proposal(inputType=idea) → idea → root
  | "via_document_proposal" // document → proposal(inputType=idea) → idea → root
  | "no_proposal" // task/document with no proposalUuid (quick task / standalone)
  | "proposal_input_not_idea" // proposal's inputType !== "idea" (or no input ideas)
  | "standalone_document" // document with no proposalUuid
  | "not_found"; // entity uuid not found in this company

/** One hop on the resolved lineage path, ordered child (input entity) → root. */
export interface LineageNode {
  type: LineageEntityType;
  uuid: string;
  title: string | null;
}

export interface ResolveRootIdeaResult {
  /** Root idea uuid, or null when there is no idea ancestor (a success, not an error). */
  rootIdeaUuid: string | null;
  /** The resolved path, ordered from the input entity to the root idea. */
  lineage: LineageNode[];
  /** Explains the outcome so callers can log a clear attribution trail. */
  resolvedVia: ResolvedVia;
  /** True when a multi-idea proposal forced an inputUuids[0] choice. */
  ambiguous?: boolean;
  /** When ambiguous: the root idea uuid of each input idea (candidates[0] === rootIdeaUuid). */
  candidates?: string[];
}

/** Cycle / runaway guard for the parentUuid walk. Matches the client (cli/lineage.mjs). */
export const MAX_PARENT_HOPS = 50;

/**
 * Resolve an entity to the root idea of its lineage, server-side, in one call.
 *
 * @param companyUuid Tenant scope — every getter is scoped to this; no cross-company reads.
 * @param entityType  "task" | "document" | "proposal" | "idea".
 * @param entityUuid  The entity's uuid.
 */
export async function resolveRootIdea(
  companyUuid: string,
  entityType: LineageEntityType,
  entityUuid: string
): Promise<ResolveRootIdeaResult> {
  switch (entityType) {
    case "idea":
      return resolveFromIdea(companyUuid, entityUuid);
    case "proposal":
      return resolveFromProposal(companyUuid, entityUuid, "proposal");
    case "task":
      return resolveFromTask(companyUuid, entityUuid);
    case "document":
      return resolveFromDocument(companyUuid, entityUuid);
    default:
      // Unreachable for typed callers; defensive for runtime (e.g. MCP input).
      return { rootIdeaUuid: null, lineage: [], resolvedVia: "not_found" };
  }
}

/** Walk the entity's own idea chain to the root. */
async function resolveFromIdea(
  companyUuid: string,
  ideaUuid: string
): Promise<ResolveRootIdeaResult> {
  const lineage: LineageNode[] = [];
  const root = await walkToRoot(companyUuid, ideaUuid, lineage);
  if (root === null) {
    return { rootIdeaUuid: null, lineage: [], resolvedVia: "not_found" };
  }
  return { rootIdeaUuid: root, lineage, resolvedVia: "root_idea" };
}

async function resolveFromTask(
  companyUuid: string,
  taskUuid: string
): Promise<ResolveRootIdeaResult> {
  const task = await getTaskByUuid(companyUuid, taskUuid);
  if (!task) {
    return { rootIdeaUuid: null, lineage: [], resolvedVia: "not_found" };
  }
  const head: LineageNode = { type: "task", uuid: task.uuid, title: task.title };
  if (!task.proposalUuid) {
    return { rootIdeaUuid: null, lineage: [head], resolvedVia: "no_proposal" };
  }
  return resolveFromProposal(companyUuid, task.proposalUuid, "via_proposal", head);
}

async function resolveFromDocument(
  companyUuid: string,
  documentUuid: string
): Promise<ResolveRootIdeaResult> {
  const doc = await getDocumentByUuid(companyUuid, documentUuid);
  if (!doc) {
    return { rootIdeaUuid: null, lineage: [], resolvedVia: "not_found" };
  }
  const head: LineageNode = { type: "document", uuid: doc.uuid, title: doc.title };
  if (!doc.proposalUuid) {
    return { rootIdeaUuid: null, lineage: [head], resolvedVia: "standalone_document" };
  }
  return resolveFromProposal(companyUuid, doc.proposalUuid, "via_document_proposal", head);
}

/**
 * Resolve a proposal to its root idea. `successVia` distinguishes the entry path
 * (a bare proposal lookup vs. one reached through a task/document). `head` is an
 * optional already-resolved child node to prepend to the lineage.
 */
async function resolveFromProposal(
  companyUuid: string,
  proposalUuid: string,
  successVia: "proposal" | "via_proposal" | "via_document_proposal",
  head?: LineageNode
): Promise<ResolveRootIdeaResult> {
  const lineage: LineageNode[] = head ? [head] : [];
  const proposal = await getProposalByUuid(companyUuid, proposalUuid);
  if (!proposal) {
    return { rootIdeaUuid: null, lineage, resolvedVia: "not_found" };
  }
  lineage.push({ type: "proposal", uuid: proposal.uuid, title: proposal.title });

  if (proposal.inputType !== "idea") {
    return { rootIdeaUuid: null, lineage, resolvedVia: "proposal_input_not_idea" };
  }
  const inputUuids = normalizeUuidArray(proposal.inputUuids);
  if (inputUuids.length === 0) {
    return { rootIdeaUuid: null, lineage, resolvedVia: "proposal_input_not_idea" };
  }

  // Primary line = inputUuids[0]; append the idea chain to the lineage.
  const primaryRoot = await walkToRoot(companyUuid, inputUuids[0], lineage);
  if (primaryRoot === null) {
    return { rootIdeaUuid: null, lineage, resolvedVia: "not_found" };
  }

  const resolvedVia: ResolvedVia =
    successVia === "via_document_proposal"
      ? "via_document_proposal"
      : successVia === "via_proposal"
        ? "via_proposal"
        : "root_idea";

  if (inputUuids.length === 1) {
    return { rootIdeaUuid: primaryRoot, lineage, resolvedVia };
  }

  // Multi-idea proposal: stay single-valued (primaryRoot) but surface the
  // ambiguity. candidates = the root of each input idea, walked independently.
  // A candidate idea that is missing in this company is skipped (not fatal).
  const candidates: string[] = [primaryRoot];
  for (const ideaUuid of inputUuids.slice(1)) {
    const root = await walkToRoot(companyUuid, ideaUuid);
    if (root !== null) candidates.push(root);
  }
  return { rootIdeaUuid: primaryRoot, lineage, resolvedVia, ambiguous: true, candidates };
}

/**
 * Walk the parentUuid chain to the top of the lineage forest, starting at
 * `startIdeaUuid`. Bounded by MAX_PARENT_HOPS with a visited-set cycle guard.
 * Each visited idea (including the start) is appended to `lineage` in child→root
 * order when the array is supplied. Returns the topmost reachable idea uuid, or
 * null when the start idea does not exist in this company.
 */
async function walkToRoot(
  companyUuid: string,
  startIdeaUuid: string,
  lineage?: LineageNode[]
): Promise<string | null> {
  let idea = await getIdeaByUuid(companyUuid, startIdeaUuid);
  if (!idea) return null; // start idea not in this company
  lineage?.push({ type: "idea", uuid: idea.uuid, title: idea.title });
  const visited = new Set<string>([idea.uuid]);
  // Each iteration takes one parent hop; the returned uuid is always the last
  // node appended to `lineage`, even when the hop bound is hit.
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    const parent = idea.parentUuid;
    if (!parent) return idea.uuid; // reached a root
    if (visited.has(parent)) return idea.uuid; // cycle — stop at the current node
    visited.add(parent);
    const parentIdea = await getIdeaByUuid(companyUuid, parent);
    if (!parentIdea) return idea.uuid; // parent not in this company — stop here
    lineage?.push({ type: "idea", uuid: parentIdea.uuid, title: parentIdea.title });
    idea = parentIdea;
  }
  return idea.uuid; // hop bound hit — return deepest reached (== last lineage node)
}

/** Coerce a Prisma Json value into a string[] (proposal.inputUuids). */
function normalizeUuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
