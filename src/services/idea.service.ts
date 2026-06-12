// src/services/idea.service.ts
// Idea Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { formatAssigneeComplete, formatCreatedBy } from "@/lib/uuid-resolver";
import { eventBus } from "@/lib/event-bus";
import { AlreadyClaimedError, NotClaimedError, isPrismaNotFound } from "@/lib/errors";
import { ApiError } from "@/lib/api-handler";
import * as mentionService from "@/services/mention.service";
import * as activityService from "@/services/activity.service";
import * as documentService from "@/services/document.service";
import * as proposalService from "@/services/proposal.service";
import logger from "@/lib/logger";

// ===== Derived Status =====

export type DerivedIdeaStatus = 'todo' | 'in_progress' | 'human_conduct_required' | 'done';

// ===== Type Definitions =====

export interface IdeaListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  status?: string;
  assignedToMe?: boolean;  // Filter for ideas assigned to current user
  actorUuid?: string;      // Current user/agent UUID for assignedToMe filter
  actorType?: string;      // "user" | "agent" for assignedToMe filter
}

export interface IdeaCreateParams {
  companyUuid: string;
  projectUuid: string;
  title: string;
  content?: string | null;
  attachments?: unknown;
  createdByUuid: string;
  // Optional lineage parent (single-parent forest). Must be a same-project Idea.
  parentUuid?: string | null;
}

// Lightweight lineage references emitted on single-idea reads.
export interface IdeaLineageParent {
  uuid: string;
  title: string;
  status: string;
}
export interface IdeaLineageChild {
  uuid: string;
  title: string;
  status: string;
  derivedStatus: DerivedIdeaStatus;
}

export interface IdeaClaimParams {
  ideaUuid: string;
  companyUuid: string;
  assigneeType: string;
  assigneeUuid: string;
  assignedByUuid?: string | null;
}

// API response format
export interface IdeaResponse {
  uuid: string;
  title: string;
  content: string | null;
  attachments: unknown;
  status: string;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  project?: { uuid: string; name: string };
  elaborationStatus?: string;
  elaborationDepth?: string;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  // Number of completion-report Documents (type="report") under this idea's
  // approved proposals. Always present on list rows; 0 when none exist.
  reportCount?: number;
  // Full content of completion-report Documents under this idea's approved
  // proposals, sorted by createdAt descending. Only emitted by getIdea
  // (single-entity reads), not by listIdeas — list rows carry the count only.
  reports?: import("./document.service").DocumentResponse[];
  // Lineage (single-parent forest, weak read-only relation). parentUuid is the
  // stored edge; parent/children/descendantUuids are emitted by getIdea only.
  parentUuid?: string | null;
  parent?: IdeaLineageParent | null;
  children?: IdeaLineageChild[];
  // Direct-children rollup count (drives the "+N derived" chip). Emitted on
  // list rows (listIdeas). Direct children only, not the recursive subtree.
  childCount?: number;
  // Transitive descendant UUID set of THIS idea — used by the set-parent picker
  // to disable cycle-forming candidates. Distinct from the direct-child rollup.
  descendantUuids?: string[];
}

// Cascade-move counts — emitted by moveIdea / moveIdeaPreview so REST/MCP/UI
// callers can render a "moved N proposals, M documents, ..." preview/summary.
// Numbers come straight from each Prisma updateMany().count (or .count() for
// the preview path). See openspec change idea-cross-project-cascade-move §D4.
export interface MoveIdeaCounts {
  // Idea rows moved = the moved root + its full lineage descendant subtree.
  // Always >= 1. Added with the lineage cascade (see add-idea-lineage follow-up).
  ideas: number;
  proposals: number;
  documents: number;
  tasks: number;
  activities: number;
}

export interface MoveIdeaResponse extends IdeaResponse {
  moved: MoveIdeaCounts;
}

export interface MoveIdeaPreviewResult {
  moved: MoveIdeaCounts;
}

// Idea status transition rules — simplified 3-state model
// open → elaborating → elaborated
// Post-elaboration status is derived from Proposal + Task states (see computeDerivedStatus)
export const IDEA_STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ["elaborating"],
  elaborating: ["elaborated"],
  elaborated: [],
};

// Map legacy statuses to current ones (for backward compatibility with historical data)
export function normalizeIdeaStatus(status: string): string {
  switch (status) {
    case "assigned":
    case "in_progress":
      return "elaborating";
    case "proposal_created":
    case "completed":
    case "closed":
    case "pending_review":
      return "elaborated";
    default:
      return status;
  }
}

// Validate whether a status transition is valid
export function isValidIdeaStatusTransition(from: string, to: string): boolean {
  const normalizedFrom = normalizeIdeaStatus(from);
  const allowed = IDEA_STATUS_TRANSITIONS[normalizedFrom] || [];
  return allowed.includes(to);
}

// ===== Internal Helper Functions =====

// Format a single Idea into API response format
async function formatIdeaResponse(
  idea: {
    uuid: string;
    title: string;
    content: string | null;
    attachments: unknown;
    status: string;
    elaborationStatus?: string | null;
    elaborationDepth?: string | null;
    assigneeType: string | null;
    assigneeUuid: string | null;
    assignedAt: Date | null;
    assignedByUuid: string | null;
    createdByUuid: string;
    createdAt: Date;
    updatedAt: Date;
    project?: { uuid: string; name: string };
  }
): Promise<IdeaResponse> {
  const [assignee, createdBy] = await Promise.all([
    formatAssigneeComplete(idea.assigneeType, idea.assigneeUuid, idea.assignedAt, idea.assignedByUuid),
    formatCreatedBy(idea.createdByUuid),
  ]);

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content,
    attachments: idea.attachments,
    status: normalizeIdeaStatus(idea.status),
    assignee,
    ...(idea.project && { project: idea.project }),
    ...(idea.elaborationStatus != null && { elaborationStatus: idea.elaborationStatus }),
    ...(idea.elaborationDepth != null && { elaborationDepth: idea.elaborationDepth }),
    createdBy,
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
  };
}

// ===== Service Methods =====

// List ideas query
export async function listIdeas({
  companyUuid,
  projectUuid,
  skip,
  take,
  status,
  assignedToMe,
  actorUuid,
  actorType,
}: IdeaListParams): Promise<{ ideas: IdeaResponse[]; total: number }> {
  const where: {
    projectUuid: string;
    companyUuid: string;
    status?: string;
    assigneeUuid?: string;
    assigneeType?: string;
  } = {
    projectUuid,
    companyUuid,
    ...(status && { status }),
  };

  // Add assignedToMe filter if requested
  if (assignedToMe && actorUuid && actorType) {
    where.assigneeUuid = actorUuid;
    where.assigneeType = actorType;
  }

  const [rawIdeas, total] = await Promise.all([
    prisma.idea.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        uuid: true,
        title: true,
        content: true,
        attachments: true,
        status: true,
        elaborationStatus: true,
        elaborationDepth: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        assignedByUuid: true,
        parentUuid: true,
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.idea.count({ where }),
  ]);

  const ideas = await Promise.all(rawIdeas.map(formatIdeaResponse));
  // Carry the stored lineage edge onto every row so the client can build the
  // forest. (formatIdeaResponse omits it; set it from the raw row by index.)
  rawIdeas.forEach((raw, i) => {
    ideas[i].parentUuid = raw.parentUuid ?? null;
  });

  // Attach reportCount to every row. Two extra queries per page (independent
  // of page size) with early returns when there's nothing to count.
  if (ideas.length > 0) {
    const counts = await getReportCountsForIdeas(
      companyUuid,
      projectUuid,
      ideas.map((i) => i.uuid),
    );
    for (const idea of ideas) {
      idea.reportCount = counts.get(idea.uuid) ?? 0;
    }

    // Direct-child rollup for the "+N derived" chip — one groupBy across the
    // whole project (no N+1). childCount counts DIRECT children only.
    const childCountRows = (await prisma.idea.groupBy({
      by: ["parentUuid"],
      where: { companyUuid, projectUuid, parentUuid: { not: null } },
      _count: { _all: true },
    })) ?? [];
    const childCountByParent = new Map<string, number>();
    for (const row of childCountRows) {
      if (row.parentUuid) childCountByParent.set(row.parentUuid, row._count._all);
    }
    for (const idea of ideas) {
      idea.childCount = childCountByParent.get(idea.uuid) ?? 0;
    }
  }

  return { ideas, total };
}

// Proposals carrying a completion report — i.e. those an Idea's reports
// can live under. Approved is the live state; closed is post-cleanup. We
// treat them symmetrically because reports are durable artifacts: closing
// the proposal is housekeeping, not retraction. See proposal.service.ts
// closeProposal — the report Document remains.
const REPORT_BEARING_PROPOSAL_STATUSES = ["approved", "closed"] as const;

// Batch-resolve completion-report Document counts grouped by Idea, used by
// listIdeas. Fully short-circuited at every step so we don't pay the cost
// when there are no idea-rooted report-bearing proposals or no reports
// anywhere in the project. Returns a Map for caller-side fold-back.
async function getReportCountsForIdeas(
  companyUuid: string,
  projectUuid: string,
  ideaUuids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ideaUuids.length === 0) return out;

  // Step 1: idea-rooted report-bearing proposals in this project. JSON
  // Proposal.inputUuids forces a project-scoped scan; status filter +
  // inputType + same companyUuid keep the row count tight.
  const proposals = await prisma.proposal.findMany({
    where: {
      projectUuid,
      companyUuid,
      status: { in: [...REPORT_BEARING_PROPOSAL_STATUSES] },
      inputType: "idea",
    },
    select: { uuid: true, inputUuids: true },
  });
  if (proposals.length === 0) return out;

  // Step 2: keep only proposals that point at one of THIS PAGE's ideas.
  // Build proposalUuid -> set of pageIdeaUuid associations along the way.
  // Defensive: tolerate non-array inputUuids (legacy / drift) — a thrown
  // TypeError here would 500 the entire idea list.
  const ideaSet = new Set(ideaUuids);
  const proposalUuidToIdeaUuids = new Map<string, string[]>();
  for (const p of proposals) {
    if (!Array.isArray(p.inputUuids)) continue;
    const matched = (p.inputUuids as string[]).filter((u) => ideaSet.has(u));
    if (matched.length > 0) proposalUuidToIdeaUuids.set(p.uuid, matched);
  }
  if (proposalUuidToIdeaUuids.size === 0) return out;

  // Step 3: count reports grouped by proposalUuid, then fold to ideaUuid.
  const grouped = await prisma.document.groupBy({
    by: ["proposalUuid"],
    where: {
      companyUuid,
      type: "report",
      proposalUuid: { in: Array.from(proposalUuidToIdeaUuids.keys()) },
    },
    _count: { _all: true },
  });

  for (const g of grouped) {
    if (!g.proposalUuid) continue;
    const ideas = proposalUuidToIdeaUuids.get(g.proposalUuid);
    if (!ideas) continue;
    for (const ideaUuid of ideas) {
      out.set(ideaUuid, (out.get(ideaUuid) ?? 0) + g._count._all);
    }
  }

  return out;
}

// Get Idea details, including full content of any completion-report
// Documents (type="report") attached to this idea's approved proposals.
// Reports are sorted by createdAt descending. Each step short-circuits when
// there's nothing to do, so the worst case for an idea with no proposals or
// no reports is one extra cheap proposal lookup.
export async function getIdea(
  companyUuid: string,
  uuid: string
): Promise<IdeaResponse | null> {
  const idea = await prisma.idea.findFirst({
    where: { uuid, companyUuid },
    include: {
      project: { select: { uuid: true, name: true } },
      parent: { select: { uuid: true, title: true, status: true } },
      children: {
        select: { uuid: true, title: true, status: true, elaborationStatus: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!idea) return null;
  const response = await formatIdeaResponse(idea);

  // Lineage: stored edge + resolved parent + direct children (with derived
  // status) + this idea's transitive descendant set (for the set-parent picker).
  response.parentUuid = idea.parentUuid ?? null;
  response.parent = idea.parent
    ? { uuid: idea.parent.uuid, title: idea.parent.title, status: normalizeIdeaStatus(idea.parent.status) }
    : null;
  const childRows = idea.children ?? [];
  if (childRows.length > 0) {
    // Reuse the batched project-wide derived-status computation (no N+1) and
    // pick out the derived status for each direct child.
    const projectIdeas = await getIdeasWithDerivedStatus(companyUuid, idea.projectUuid);
    const derivedByUuid = new Map(projectIdeas.map((i) => [i.uuid, i.derivedStatus]));
    response.children = childRows.map((child) => ({
      uuid: child.uuid,
      title: child.title,
      status: normalizeIdeaStatus(child.status),
      derivedStatus: derivedByUuid.get(child.uuid) ?? ("todo" as DerivedIdeaStatus),
    }));
  } else {
    response.children = [];
  }
  response.descendantUuids = await getDescendantUuids(uuid, companyUuid);

  // Step 1: idea-rooted report-bearing proposals (approved or closed —
  // see REPORT_BEARING_PROPOSAL_STATUSES rationale).
  const proposals = await proposalService.getProposalsByIdeaUuid(
    companyUuid,
    idea.projectUuid,
    uuid,
  );
  const reportBearing = proposals.filter((p) =>
    (REPORT_BEARING_PROPOSAL_STATUSES as readonly string[]).includes(p.status),
  );
  if (reportBearing.length === 0) {
    response.reports = [];
    return response;
  }

  // Step 2: pull report Documents across those proposals; helper already
  // includes content + sorts by createdAt desc.
  const reports = await documentService.listDocumentsByProposalUuids(
    companyUuid,
    reportBearing.map((p) => p.uuid),
    "report",
  );
  response.reports = reports;
  return response;
}

// Get raw Idea data by UUID (internal use, for permission checks etc.)
export async function getIdeaByUuid(companyUuid: string, uuid: string) {
  return prisma.idea.findFirst({
    where: { uuid, companyUuid },
  });
}

// Create Idea
export async function createIdea(params: IdeaCreateParams): Promise<IdeaResponse> {
  // Validate optional lineage parent: must exist, same company, same project.
  if (params.parentUuid) {
    const parent = await prisma.idea.findFirst({
      where: { uuid: params.parentUuid, companyUuid: params.companyUuid },
      select: { projectUuid: true },
    });
    if (!parent) {
      throw new Error("Parent idea not found");
    }
    if (parent.projectUuid !== params.projectUuid) {
      throw new Error("Parent idea must be in the same project");
    }
  }

  const idea = await prisma.idea.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      title: params.title,
      content: params.content,
      attachments: params.attachments || undefined,
      status: "open",
      createdByUuid: params.createdByUuid,
      parentUuid: params.parentUuid ?? undefined,
    },
    select: {
      uuid: true,
      title: true,
      content: true,
      attachments: true,
      status: true,
      elaborationStatus: true,
      elaborationDepth: true,
      assigneeType: true,
      assigneeUuid: true,
      assignedAt: true,
      assignedByUuid: true,
      parentUuid: true,
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: params.projectUuid, entityType: "idea", entityUuid: idea.uuid, action: "created" });

  const response = await formatIdeaResponse(idea);
  response.parentUuid = idea.parentUuid;
  return response;
}

// Update Idea
export async function updateIdea(
  uuid: string,
  companyUuid: string,
  data: { title?: string; content?: string | null; status?: string },
  actorContext?: { actorType: string; actorUuid: string }
): Promise<IdeaResponse> {
  // If content is being updated and we have actor context, capture old content for mention diffing
  let oldContent: string | null = null;
  if (data.content !== undefined && actorContext) {
    const existing = await prisma.idea.findUnique({ where: { uuid }, select: { content: true } });
    oldContent = existing?.content ?? null;
  }

  const idea = await prisma.idea.update({
    where: { uuid },
    data,
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.project!.uuid, entityType: "idea", entityUuid: idea.uuid, action: "updated" });

  // Record an "edited" activity for title/content edits (status changes have
  // their own dedicated activities elsewhere, so they're excluded here to avoid
  // double-logging). Attributed to the actor when actorContext is provided.
  if (actorContext) {
    const changedFields = (["title", "content"] as const).filter((f) => data[f] !== undefined);
    if (changedFields.length > 0) {
      await activityService.createActivity({
        companyUuid: idea.companyUuid,
        projectUuid: idea.project!.uuid,
        targetType: "idea",
        targetUuid: idea.uuid,
        actorType: actorContext.actorType,
        actorUuid: actorContext.actorUuid,
        action: "edited",
        value: { changedFields },
      });
    }
  }

  // Process new @mentions in content (append-only: only new mentions)
  if (data.content !== undefined && actorContext && data.content) {
    processNewIdeaMentions(
      idea.companyUuid,
      idea.project!.uuid,
      idea.uuid,
      idea.title,
      oldContent,
      data.content,
      actorContext.actorType,
      actorContext.actorUuid,
    ).catch((err) => logger.error({ err }, "Failed to process idea mentions"));
  }

  return formatIdeaResponse(idea);
}

// ===== Lineage (single-parent forest — weak read-only relation) =====

/**
 * Return the transitive descendant UUID set of a single idea (direct + indirect
 * children, all the way down). Bounded subtree walk via repeated indexed lookups
 * on parentUuid — this is an on-demand, single-idea query used by the set-parent
 * picker to disable cycle-forming candidates. It is intentionally distinct from
 * the direct-child-only list rollup (which stays shallow to avoid N+1 across
 * many rows); here we walk one idea's subtree only.
 *
 * A `visited` set guards against any pre-existing cyclic data so the walk always
 * terminates.
 */
export async function getDescendantUuids(
  uuid: string,
  companyUuid: string,
): Promise<string[]> {
  const descendants = new Set<string>();
  let frontier = [uuid];
  while (frontier.length > 0) {
    const children = (await prisma.idea.findMany({
      where: { companyUuid, parentUuid: { in: frontier } },
      select: { uuid: true },
    })) ?? [];
    const next: string[] = [];
    for (const child of children) {
      if (child.uuid === uuid) continue; // defensive: skip self
      if (!descendants.has(child.uuid)) {
        descendants.add(child.uuid);
        next.push(child.uuid);
      }
    }
    frontier = next;
  }
  return [...descendants];
}

/**
 * Set (or clear) an idea's lineage parent.
 *
 * - `parentUuid: null` detaches the idea (becomes top-level).
 * - Rejects self-parent, and any parent that is a descendant of the idea
 *   (transitive cycle) — the authoritative cycle guard.
 * - Enforces same-project (first version; cross-project deferred).
 *
 * Cycle detection walks the prospective parent's ancestor chain: if we reach
 * `uuid` while climbing from `parentUuid`, the assignment would close a loop.
 */
export async function setIdeaParent(
  uuid: string,
  parentUuid: string | null,
  companyUuid: string,
  actorContext?: { actorType: string; actorUuid: string },
): Promise<IdeaResponse> {
  const idea = await prisma.idea.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true, projectUuid: true, parentUuid: true },
  });
  if (!idea) throw new Error("Idea not found");
  const previousParentUuid = idea.parentUuid ?? null;

  if (parentUuid) {
    if (parentUuid === uuid) {
      throw new Error("An idea cannot be its own parent");
    }
    const parent = await prisma.idea.findFirst({
      where: { uuid: parentUuid, companyUuid },
      select: { uuid: true, projectUuid: true, parentUuid: true },
    });
    if (!parent) throw new Error("Parent idea not found");
    if (parent.projectUuid !== idea.projectUuid) {
      throw new Error("Parent idea must be in the same project");
    }
    // Walk the prospective parent's ancestor chain; reject if it reaches `uuid`.
    const seen = new Set<string>();
    let cursor: string | null = parent.parentUuid;
    while (cursor) {
      if (cursor === uuid) {
        throw new Error("Cannot set parent: would create a cycle");
      }
      if (seen.has(cursor)) break; // defensive against pre-existing cycles
      seen.add(cursor);
      const ancestor: { parentUuid: string | null } | null =
        await prisma.idea.findFirst({
          where: { uuid: cursor, companyUuid },
          select: { parentUuid: true },
        });
      cursor = ancestor?.parentUuid ?? null;
    }
  }

  const updated = await prisma.idea.update({
    where: { uuid },
    data: { parentUuid: parentUuid ?? null },
    include: { project: { select: { uuid: true, name: true } } },
  });

  eventBus.emitChange({
    companyUuid: updated.companyUuid,
    projectUuid: updated.projectUuid,
    entityType: "idea",
    entityUuid: updated.uuid,
    action: "updated",
  });

  // Record a "reparented" activity when the parent actually changed and we have
  // an actor. Captures from/to so the timeline can show the lineage move.
  const newParentUuid = updated.parentUuid ?? null;
  if (actorContext && newParentUuid !== previousParentUuid) {
    await activityService.createActivity({
      companyUuid: updated.companyUuid,
      projectUuid: updated.projectUuid,
      targetType: "idea",
      targetUuid: updated.uuid,
      actorType: actorContext.actorType,
      actorUuid: actorContext.actorUuid,
      action: "reparented",
      value: { fromParentUuid: previousParentUuid, toParentUuid: newParentUuid },
    });
  }

  const response = await formatIdeaResponse(updated);
  response.parentUuid = updated.parentUuid;
  return response;
}

// Claim Idea (self-claim: only works when no assignee)
export async function claimIdea({
  ideaUuid,
  companyUuid,
  assigneeType,
  assigneeUuid,
  assignedByUuid,
}: IdeaClaimParams): Promise<IdeaResponse> {
  const existing = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!existing) throw new AlreadyClaimedError("Idea");
  if (existing.assigneeUuid) {
    throw new AlreadyClaimedError("Idea");
  }
  const normalizedStatus = normalizeIdeaStatus(existing.status);
  if (normalizedStatus === "elaborated") {
    throw new Error("Cannot claim an elaborated Idea");
  }

  const idea = await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: {
      status: "elaborating",
      assigneeType,
      assigneeUuid,
      assignedAt: new Date(),
      assignedByUuid,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.project!.uuid, entityType: "idea", entityUuid: idea.uuid, action: "updated" });

  return formatIdeaResponse(idea);
}

// Assign Idea (reassign: works regardless of current assignee, any non-terminal status)
export async function assignIdea({
  ideaUuid,
  companyUuid,
  assigneeType,
  assigneeUuid,
  assignedByUuid,
}: IdeaClaimParams): Promise<IdeaResponse> {
  const existing = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!existing) throw new Error("Idea not found");
  const normalizedAssignStatus = normalizeIdeaStatus(existing.status);
  if (normalizedAssignStatus === "elaborated") {
    throw new Error("Cannot assign an elaborated Idea");
  }

  // If currently open, move to elaborating; otherwise keep current status
  const newStatus = existing.status === "open" ? "elaborating" : existing.status;

  const idea = await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: {
      status: newStatus,
      assigneeType,
      assigneeUuid,
      assignedAt: new Date(),
      assignedByUuid,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.project!.uuid, entityType: "idea", entityUuid: idea.uuid, action: "updated" });

  return formatIdeaResponse(idea);
}

// Release Idea (clears assignee, resets to open; any non-terminal status)
export async function releaseIdea(uuid: string): Promise<IdeaResponse> {
  const existing = await prisma.idea.findUnique({ where: { uuid } });
  if (!existing) throw new Error("Idea not found");
  const normalizedReleaseStatus = normalizeIdeaStatus(existing.status);
  if (normalizedReleaseStatus === "elaborated") {
    throw new Error("Cannot release an elaborated Idea");
  }

  const idea = await prisma.idea.update({
    where: { uuid },
    data: {
      status: "open",
      assigneeType: null,
      assigneeUuid: null,
      assignedAt: null,
      assignedByUuid: null,
      elaborationDepth: null,
      elaborationStatus: null,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.project!.uuid, entityType: "idea", entityUuid: idea.uuid, action: "updated" });

  return formatIdeaResponse(idea);
}

// Process new @mentions in idea content (append-only: only new mentions)
async function processNewIdeaMentions(
  companyUuid: string,
  projectUuid: string,
  ideaUuid: string,
  ideaTitle: string,
  oldContent: string | null,
  newContent: string,
  actorType: string,
  actorUuid: string,
): Promise<void> {
  const oldMentions = oldContent ? mentionService.parseMentions(oldContent) : [];
  const newMentions = mentionService.parseMentions(newContent);

  const oldKeys = new Set(oldMentions.map((m) => `${m.type}:${m.uuid}`));
  const brandNewMentions = newMentions.filter((m) => !oldKeys.has(`${m.type}:${m.uuid}`));

  if (brandNewMentions.length === 0) return;

  await mentionService.createMentions({
    companyUuid,
    sourceType: "idea",
    sourceUuid: ideaUuid,
    content: newContent,
    actorType,
    actorUuid,
    projectUuid,
    entityTitle: ideaTitle,
  });

  for (const mention of brandNewMentions) {
    if (mention.type === actorType && mention.uuid === actorUuid) continue;
    await activityService.createActivity({
      companyUuid,
      projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType,
      actorUuid,
      action: "mentioned",
      value: {
        mentionedType: mention.type,
        mentionedUuid: mention.uuid,
        mentionedName: mention.displayName,
        sourceType: "idea",
        sourceUuid: ideaUuid,
      },
    });
  }
}

// Delete Idea
export async function deleteIdea(uuid: string) {
  // Resolve companyUuid up front so the orphan updateMany is tenant-scoped
  // (defensive — parentUuid is a unique idea UUID, but we keep every write
  // companyUuid-scoped per the multi-tenancy guideline).
  const target = await prisma.idea.findUnique({
    where: { uuid },
    select: { companyUuid: true },
  });
  // Orphan direct children to top-level BEFORE deleting the parent (weak
  // lineage: a parent does not own its children). Doing this first also means
  // the Restrict referential action on the self-relation never fires, since no
  // child references the parent by delete time.
  if (target) {
    await prisma.idea.updateMany({
      where: { companyUuid: target.companyUuid, parentUuid: uuid },
      data: { parentUuid: null },
    });
  }
  const idea = await prisma.idea.delete({ where: { uuid } });
  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: idea.uuid, action: "deleted" });
  return idea;
}

// Move Idea to a different project — performs the full AI-DLC cascade migration.
//
// One Prisma $transaction updates the entire pipeline tail in lock-step:
//   - Idea row.
//   - All Proposals where inputType="idea" AND inputUuids contains ideaUuid
//     (no status filter — sweeps draft/pending/approved/rejected/revised, see D1).
//   - All Documents where proposalUuid in {migrated proposals}.
//   - All Tasks      where proposalUuid in {migrated proposals}.
//   - All Activities targeting any of {idea, migrated proposals, migrated tasks,
//     migrated documents}, OR-joined inside one updateMany (D3).
//
// Tables intentionally NOT touched (spec "Comments and task dependencies are
// NOT independently rewritten" + "Notifications and AgentSession are NOT
// modified"): Comment, TaskDependency, AcceptanceCriterion, SessionTaskCheckin,
// AgentSession, Notification, Task.assignee*. Their FKs already follow the
// migrated entity rows; rewriting them would be redundant or actively wrong.
//
// Every where clause carries `companyUuid` so a same-uuid row in another
// company cannot be touched (cross-company isolation scenario).
export async function moveIdea(
  companyUuid: string,
  ideaUuid: string,
  targetProjectUuid: string,
  actorUuid: string,
  actorType: string = "user"
): Promise<MoveIdeaResponse> {
  // Validate idea exists and belongs to same company
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
    include: { project: { select: { uuid: true, name: true } } },
  });
  if (!idea) throw new ApiError("NOT_FOUND", "Idea not found", 404);

  // Validate target project exists and belongs to same company
  const targetProject = await prisma.project.findFirst({
    where: { uuid: targetProjectUuid, companyUuid },
    select: { uuid: true, name: true },
  });
  if (!targetProject) throw new ApiError("NOT_FOUND", "Target project not found", 404);

  if (idea.projectUuid === targetProjectUuid) {
    throw new ApiError("BAD_REQUEST", "Idea is already in the target project", 400);
  }

  const fromProjectUuid = idea.projectUuid;

  // Lineage: the move carries the whole subtree. Resolve the moved root's
  // transitive descendants up front (single-idea BFS, scoped to companyUuid),
  // so every idea in {root, ...descendants} migrates together and no
  // cross-project parentUuid edge is left behind. (add-idea-lineage follow-up.)
  //
  // KNOWN TOCTOU (accepted, pre-existing shape): this resolution runs before the
  // $transaction below — same pattern as the proposal resolution. A child
  // reparented under `ideaUuid` concurrently, between this read and the
  // updateMany, would be left behind with a now-cross-project parentUuid.
  // Tightening this means resolving descendants inside the transaction; tracked
  // as a follow-up, not fixed here to keep the change scoped.
  const descendantUuids = await getDescendantUuids(ideaUuid, companyUuid);
  const movedIdeaUuids = [ideaUuid, ...descendantUuids];

  // Transaction: cascade-update the moved Idea subtree + their linked Proposals
  // + those Proposals' Documents/Tasks + the Activity stream that targets any of
  // those rows. Counts are returned so REST/MCP/UI can render a summary.
  const moved = await prisma.$transaction(async (tx) => {
    // Resolve the proposal set for EVERY moved idea via JSON inputUuids match.
    // inputUuids is a Json column, so the only indexable operator is
    // `array_contains` (single-value containment); we OR one clause per moved
    // idea to cover the whole subtree. No status filter (D1) — every status
    // follows the idea. This is the only call that touches the JSON column;
    // subsequent steps reuse the resulting uuid list to walk the PK index.
    const proposals = await tx.proposal.findMany({
      where: {
        companyUuid,
        inputType: "idea",
        OR: movedIdeaUuids.map((u) => ({ inputUuids: { array_contains: [u] } })),
      },
      select: { uuid: true },
    });
    const proposalUuids = proposals.map((p) => p.uuid);

    // Idea rows — move the whole subtree. Then detach the moved ROOT from a
    // parent that is NOT moving (a parent is always an ancestor, never in the
    // moved set), so no cross-project lineage edge survives. Descendants keep
    // their parentUuid because their parents ARE in the moved set.
    const ideaUpdate = await tx.idea.updateMany({
      where: { companyUuid, uuid: { in: movedIdeaUuids } },
      data: { projectUuid: targetProjectUuid },
    });
    const ideaCount = ideaUpdate.count;
    if (idea.parentUuid) {
      await tx.idea.update({
        where: { uuid: ideaUuid },
        data: { parentUuid: null },
      });
    }

    // Short-circuit when no proposals are linked: skip the proposal/document/
    // task lookups and updateMany calls that would all return count 0 anyway.
    // Activity still runs because idea-targeting activity rows can exist
    // independent of any proposal (e.g. created/assigned/released events).
    let proposalCount = 0;
    let documentCount = 0;
    let taskCount = 0;
    let documentUuids: string[] = [];
    let taskUuids: string[] = [];

    if (proposalUuids.length > 0) {
      // Resolve Document/Task UUIDs via proposalUuid (D2).
      const [documentRows, taskRows] = await Promise.all([
        tx.document.findMany({
          where: { companyUuid, proposalUuid: { in: proposalUuids } },
          select: { uuid: true },
        }),
        tx.task.findMany({
          where: { companyUuid, proposalUuid: { in: proposalUuids } },
          select: { uuid: true },
        }),
      ]);
      documentUuids = documentRows.map((d) => d.uuid);
      taskUuids = taskRows.map((t) => t.uuid);

      // Proposals — walk the uuid PK from step 1's result instead of rescanning
      // the JSON inputUuids column. `array_overlaps` cannot use a btree index
      // and forces a seq scan, while `uuid IN (...)` hits Proposal_uuid_key.
      const proposalUpdate = await tx.proposal.updateMany({
        where: { companyUuid, uuid: { in: proposalUuids } },
        data: { projectUuid: targetProjectUuid },
      });
      proposalCount = proposalUpdate.count;

      // Documents linked to migrated proposals.
      const documentUpdate = await tx.document.updateMany({
        where: { companyUuid, proposalUuid: { in: proposalUuids } },
        data: { projectUuid: targetProjectUuid },
      });
      documentCount = documentUpdate.count;

      // Tasks linked to migrated proposals (assignee fields untouched).
      const taskUpdate = await tx.task.updateMany({
        where: { companyUuid, proposalUuid: { in: proposalUuids } },
        data: { projectUuid: targetProjectUuid },
      });
      taskCount = taskUpdate.count;
    }

    // Activity rows whose (targetType, targetUuid) hits any migrated entity.
    // OR-clause (D3) keeps it in one updateMany call so partial failures can't
    // leave the activity feed split across two projects. Empty IN clauses on
    // proposal/task/document branches are harmless — Prisma compiles them to
    // a no-match predicate.
    const activityUpdate = await tx.activity.updateMany({
      where: {
        companyUuid,
        OR: [
          { targetType: "idea", targetUuid: { in: movedIdeaUuids } },
          { targetType: "proposal", targetUuid: { in: proposalUuids } },
          { targetType: "task", targetUuid: { in: taskUuids } },
          { targetType: "document", targetUuid: { in: documentUuids } },
        ],
      },
      data: { projectUuid: targetProjectUuid },
    });

    return {
      ideas: ideaCount,
      proposals: proposalCount,
      documents: documentCount,
      tasks: taskCount,
      activities: activityUpdate.count,
    };
  });

  // Log activity (the "moved" event itself lives on the new project's stream).
  await activityService.createActivity({
    companyUuid,
    projectUuid: targetProjectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "moved",
    value: {
      fromProjectUuid,
      fromProjectName: idea.project!.name,
      toProjectUuid: targetProjectUuid,
      toProjectName: targetProject.name,
      moved,
    },
  });

  // Emit changes for both projects (the source loses the idea; the target gains it).
  eventBus.emitChange({ companyUuid, projectUuid: fromProjectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });
  eventBus.emitChange({ companyUuid, projectUuid: targetProjectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  // Return updated idea + cascade counts.
  const updated = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
    include: { project: { select: { uuid: true, name: true } } },
  });
  const formatted = await formatIdeaResponse(updated!);
  return { ...formatted, moved };
}

// Non-mutating preview that mirrors moveIdea's SELECT logic but only counts.
// Used by REST GET /api/ideas/[uuid]/move/preview to drive the UI confirmation
// dialog. The MCP surface does NOT expose a preview tool — agents call the
// real move and inspect the returned `moved` counts (see spec §D4).
//
// No transaction: a small drift between preview-time and move-time counts is
// acceptable; the move's own returned counts are authoritative for the toast.
export async function moveIdeaPreview(
  companyUuid: string,
  ideaUuid: string,
  targetProjectUuid: string
): Promise<MoveIdeaPreviewResult> {
  // Validate idea exists and belongs to same company
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
    select: { uuid: true, projectUuid: true },
  });
  if (!idea) throw new ApiError("NOT_FOUND", "Idea not found", 404);

  // Validate target project exists and belongs to same company
  const targetProject = await prisma.project.findFirst({
    where: { uuid: targetProjectUuid, companyUuid },
    select: { uuid: true },
  });
  if (!targetProject) throw new ApiError("NOT_FOUND", "Target project not found", 404);

  if (idea.projectUuid === targetProjectUuid) {
    throw new ApiError("BAD_REQUEST", "Idea is already in the target project", 400);
  }

  // Mirror moveIdea's lineage cascade: the preview counts the whole moved
  // subtree (root + transitive descendants), not just the root idea.
  const descendantUuids = await getDescendantUuids(ideaUuid, companyUuid);
  const movedIdeaUuids = [ideaUuid, ...descendantUuids];

  // Same SELECT pipeline as moveIdea — proposals → documents/tasks → activity.
  // The single JSON-column scan is the proposal.findMany; everything downstream
  // walks primary-key indexes. proposalUuids.length doubles as the proposal
  // count, removing the redundant prisma.proposal.count call.
  const proposals = await prisma.proposal.findMany({
    where: {
      companyUuid,
      inputType: "idea",
      OR: movedIdeaUuids.map((u) => ({ inputUuids: { array_contains: [u] } })),
    },
    select: { uuid: true },
  });
  const proposalUuids = proposals.map((p) => p.uuid);

  let documentCount = 0;
  let taskCount = 0;
  let documentUuids: string[] = [];
  let taskUuids: string[] = [];

  if (proposalUuids.length > 0) {
    const [documentRows, taskRows] = await Promise.all([
      prisma.document.findMany({
        where: { companyUuid, proposalUuid: { in: proposalUuids } },
        select: { uuid: true },
      }),
      prisma.task.findMany({
        where: { companyUuid, proposalUuid: { in: proposalUuids } },
        select: { uuid: true },
      }),
    ]);
    documentUuids = documentRows.map((d) => d.uuid);
    taskUuids = taskRows.map((t) => t.uuid);
    documentCount = documentUuids.length;
    taskCount = taskUuids.length;
  }

  const activityCount = await prisma.activity.count({
    where: {
      companyUuid,
      OR: [
        { targetType: "idea", targetUuid: { in: movedIdeaUuids } },
        { targetType: "proposal", targetUuid: { in: proposalUuids } },
        { targetType: "task", targetUuid: { in: taskUuids } },
        { targetType: "document", targetUuid: { in: documentUuids } },
      ],
    },
  });

  return {
    moved: {
      ideas: movedIdeaUuids.length,
      proposals: proposalUuids.length,
      documents: documentCount,
      tasks: taskCount,
      activities: activityCount,
    },
  };
}

// ===== Derived Status =====

/**
 * Compute the derived status for a single idea based on its native status
 * and related Proposal/Task chain.
 */
export interface DerivedStatusContext {
  ideaStatus: string;
  elaborationStatus?: string | null;
  hasPendingProposal: boolean;
  hasApprovedProposal: boolean;
  taskStatuses: string[];
}

export type BadgeHint =
  | "open"              // New idea, not started
  | "researching"       // AI elaborating
  | "answer_questions"  // Elaboration: human needs to answer questions
  | "planning"          // AI drafting proposal
  | "review_proposal"   // Proposal: awaiting human approval
  | "building"          // Tasks in development
  | "verify_work"       // Tasks: work done, human needs to verify
  | "done"              // All tasks complete
  | null;

export interface DerivedStatusResult {
  derivedStatus: DerivedIdeaStatus;
  badgeHint: BadgeHint;
}

export function computeDerivedStatus(ctx: DerivedStatusContext): DerivedStatusResult {
  const normalized = normalizeIdeaStatus(ctx.ideaStatus);

  switch (normalized) {
    case "open":
      return { derivedStatus: "todo", badgeHint: "open" };
    case "elaborating":
      // Only pending_answers means human needs to act; otherwise agent is working
      if (ctx.elaborationStatus === "pending_answers")
        return { derivedStatus: "human_conduct_required", badgeHint: "answer_questions" };
      return { derivedStatus: "in_progress", badgeHint: "researching" };
    case "elaborated": {
      if (ctx.hasPendingProposal)
        return { derivedStatus: "human_conduct_required", badgeHint: "review_proposal" };
      if (ctx.hasApprovedProposal) {
        if (ctx.taskStatuses.some((s) => s === "to_verify"))
          return { derivedStatus: "human_conduct_required", badgeHint: "verify_work" };
        const allDone = ctx.taskStatuses.length > 0
          && ctx.taskStatuses.every((s) => s === "done" || s === "closed");
        if (allDone) return { derivedStatus: "done", badgeHint: "done" };
        return { derivedStatus: "in_progress", badgeHint: "building" };
      }
      return { derivedStatus: "in_progress", badgeHint: "planning" };
    }
    default:
      return { derivedStatus: "todo", badgeHint: "open" };
  }
}

/**
 * Get a single idea with its derived status computed from proposal + task states.
 * Returns the full IdeaResponse plus derivedStatus and badgeHint.
 */
export async function getIdeaWithDerivedStatus(
  companyUuid: string,
  ideaUuid: string,
): Promise<(IdeaResponse & DerivedStatusResult) | null> {
  const idea = await getIdea(companyUuid, ideaUuid);
  if (!idea) return null;

  const proposals = await prisma.proposal.findMany({
    where: {
      companyUuid,
      projectUuid: idea.project?.uuid,
      status: { in: ["approved", "pending"] },
      inputUuids: { array_contains: [ideaUuid] },
    },
    select: { uuid: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const approvedProposal = proposals.find((p) => p.status === "approved") ?? null;
  let taskStatuses: string[] = [];
  if (approvedProposal) {
    const tasks = await prisma.task.findMany({
      where: { companyUuid, proposalUuid: approvedProposal.uuid },
      select: { status: true },
    });
    taskStatuses = tasks.map((t) => t.status);
  }

  const result = computeDerivedStatus({
    ideaStatus: idea.status,
    elaborationStatus: idea.elaborationStatus,
    hasPendingProposal: proposals.some((p) => p.status === "pending"),
    hasApprovedProposal: !!approvedProposal,
    taskStatuses,
  });

  return { ...idea, ...result };
}

export interface IdeaWithDerivedStatus {
  uuid: string;
  title: string;
  status: string;
  derivedStatus: DerivedIdeaStatus;
  badgeHint: BadgeHint;
  createdAt: Date;
  updatedAt: Date;
  projectUuid: string;
  proposalCount: number;
  taskCount: number;
  // Lineage: stored parent edge + count of direct children (rollup). The forest
  // is built client-side from parentUuid; childCount drives the "+N derived" chip.
  parentUuid: string | null;
  childCount: number;
}

/**
 * Get all ideas in a project with their derived statuses.
 * Uses 3 batch queries (Ideas, Proposals, Tasks) — no N+1.
 */
export async function getIdeasWithDerivedStatus(
  companyUuid: string,
  projectUuid: string,
): Promise<IdeaWithDerivedStatus[]> {
  // Query 1: All ideas in the project
  const ideas = await prisma.idea.findMany({
    where: { companyUuid, projectUuid },
    select: {
      uuid: true,
      title: true,
      status: true,
      elaborationStatus: true,
      parentUuid: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Query 1b: Direct-child counts per parent — a single groupBy (no N+1). Only
  // counts direct children (weak-semantic rollup; not the recursive subtree).
  const childCountRows = (await prisma.idea.groupBy({
    by: ["parentUuid"],
    where: { companyUuid, projectUuid, parentUuid: { not: null } },
    _count: { _all: true },
  })) ?? [];
  const childCountByParent = new Map<string, number>();
  for (const row of childCountRows) {
    if (row.parentUuid) childCountByParent.set(row.parentUuid, row._count._all);
  }

  // Query 2: All proposals (approved + pending) for the project
  const proposals = await prisma.proposal.findMany({
    where: {
      companyUuid,
      projectUuid,
      status: { in: ["approved", "pending"] },
    },
    select: {
      uuid: true,
      status: true,
      inputUuids: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Build ideaUuid → latest approved Proposal mapping
  // Also track which ideas have a pending proposal and count pending+approved per idea
  const ideaToLatestApproved = new Map<string, { uuid: string; createdAt: Date }>();
  const ideasWithPendingProposal = new Set<string>();
  const ideaProposalCounts = new Map<string, number>();

  for (const proposal of proposals) {
    const inputUuids = proposal.inputUuids as string[];
    if (!Array.isArray(inputUuids)) continue;
    for (const ideaUuid of inputUuids) {
      ideaProposalCounts.set(ideaUuid, (ideaProposalCounts.get(ideaUuid) ?? 0) + 1);
      if (proposal.status === "pending") {
        ideasWithPendingProposal.add(ideaUuid);
      } else if (proposal.status === "approved") {
        const existing = ideaToLatestApproved.get(ideaUuid);
        if (!existing || proposal.createdAt > existing.createdAt) {
          ideaToLatestApproved.set(ideaUuid, { uuid: proposal.uuid, createdAt: proposal.createdAt });
        }
      }
    }
  }

  // Collect unique approved proposal UUIDs
  const relevantProposalUuids = [...new Set([...ideaToLatestApproved.values()].map((p) => p.uuid))];

  // Query 3: Tasks linked to those approved proposals
  const proposalToTaskStatuses = new Map<string, string[]>();
  if (relevantProposalUuids.length > 0) {
    const tasks = await prisma.task.findMany({
      where: {
        companyUuid,
        proposalUuid: { in: relevantProposalUuids },
      },
      select: {
        proposalUuid: true,
        status: true,
      },
    });

    for (const task of tasks) {
      if (!task.proposalUuid) continue;
      const statuses = proposalToTaskStatuses.get(task.proposalUuid) || [];
      statuses.push(task.status);
      proposalToTaskStatuses.set(task.proposalUuid, statuses);
    }
  }

  // Compute derived status for each idea
  return ideas.map((idea) => {
    const latestApproved = ideaToLatestApproved.get(idea.uuid);
    const taskStatuses = latestApproved
      ? proposalToTaskStatuses.get(latestApproved.uuid) || []
      : [];

    const { derivedStatus, badgeHint } = computeDerivedStatus({
      ideaStatus: idea.status,
      elaborationStatus: idea.elaborationStatus,
      hasPendingProposal: ideasWithPendingProposal.has(idea.uuid),
      hasApprovedProposal: !!latestApproved,
      taskStatuses,
    });

    return {
      uuid: idea.uuid,
      title: idea.title,
      status: idea.status,
      derivedStatus,
      badgeHint,
      createdAt: idea.createdAt,
      updatedAt: idea.updatedAt,
      projectUuid,
      proposalCount: ideaProposalCounts.get(idea.uuid) ?? 0,
      taskCount: taskStatuses.length,
      parentUuid: idea.parentUuid ?? null,
      childCount: childCountByParent.get(idea.uuid) ?? 0,
    };
  });
}

// ===== Tracker Grouping =====

/** Serialized idea for the tracker API/SSR response */
export interface TrackerIdeaItem {
  uuid: string;
  title: string;
  status: string;
  derivedStatus: DerivedIdeaStatus;
  badgeHint: BadgeHint;
  createdAt: string;
  // Lineage (single-parent forest). parentUuid lets the client build the tree
  // view; childCount drives the "+N derived" rollup chip. Direct children only.
  parentUuid: string | null;
  childCount: number;
}

export interface TrackerGroupsResult {
  groups: Record<string, TrackerIdeaItem[]>;
  counts: Record<string, number>;
}

/** The 4 tracker columns (closed is excluded from the board view) */
const TRACKER_STATUSES: DerivedIdeaStatus[] = [
  "todo",
  "in_progress",
  "human_conduct_required",
  "done",
];

/**
 * Get ideas grouped by derived status for the tracker board.
 * Business logic lives here — routes/server components just call this.
 */
export async function getTrackerGroups(
  companyUuid: string,
  projectUuid: string,
): Promise<TrackerGroupsResult> {
  const ideas = await getIdeasWithDerivedStatus(companyUuid, projectUuid);

  const groups: Record<string, TrackerIdeaItem[]> = {};
  const counts: Record<string, number> = {};

  for (const status of TRACKER_STATUSES) {
    groups[status] = [];
    counts[status] = 0;
  }

  for (const idea of ideas) {
    const ds = idea.derivedStatus;
    const formatted: TrackerIdeaItem = {
      uuid: idea.uuid,
      title: idea.title,
      status: idea.status,
      derivedStatus: ds,
      badgeHint: idea.badgeHint,
      createdAt: idea.createdAt.toISOString(),
      parentUuid: idea.parentUuid,
      childCount: idea.childCount,
    };

    if (groups[ds]) {
      groups[ds].push(formatted);
      counts[ds]++;
    }
  }

  return { groups, counts };
}
