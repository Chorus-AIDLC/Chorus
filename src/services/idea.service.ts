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

// ===== Derived Status =====

export type DerivedIdeaStatus = 'todo' | 'in_progress' | 'human_conduct_required' | 'done' | 'closed';

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
}

// Idea status transition rules — simplified AI-DLC lifecycle
// open → elaborating → proposal_created → completed → closed
export const IDEA_STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ["elaborating", "closed"],
  elaborating: ["proposal_created", "closed"],
  proposal_created: ["completed", "elaborating", "closed"],
  completed: ["closed"],
  closed: [],
};

// Map legacy statuses to current ones (for backward compatibility with historical data)
export function normalizeIdeaStatus(status: string): string {
  switch (status) {
    case "assigned":
    case "in_progress":
      return "elaborating";
    case "pending_review":
      return "proposal_created";
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
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.idea.count({ where }),
  ]);

  const ideas = await Promise.all(rawIdeas.map(formatIdeaResponse));
  return { ideas, total };
}

// Get Idea details
export async function getIdea(
  companyUuid: string,
  uuid: string
): Promise<IdeaResponse | null> {
  const idea = await prisma.idea.findFirst({
    where: { uuid, companyUuid },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  if (!idea) return null;
  return formatIdeaResponse(idea);
}

// Get raw Idea data by UUID (internal use, for permission checks etc.)
export async function getIdeaByUuid(companyUuid: string, uuid: string) {
  return prisma.idea.findFirst({
    where: { uuid, companyUuid },
  });
}

// Create Idea
export async function createIdea(params: IdeaCreateParams): Promise<IdeaResponse> {
  const idea = await prisma.idea.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      title: params.title,
      content: params.content,
      attachments: params.attachments || undefined,
      status: "open",
      createdByUuid: params.createdByUuid,
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
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: params.projectUuid, entityType: "idea", entityUuid: idea.uuid, action: "created" });

  return formatIdeaResponse(idea);
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
    ).catch((err) => console.error("[Idea] Failed to process mentions:", err));
  }

  return formatIdeaResponse(idea);
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
  if (existing.status === "completed" || existing.status === "closed") {
    throw new Error("Cannot claim a completed or closed Idea");
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
  if (existing.status === "completed" || existing.status === "closed") {
    throw new Error("Cannot assign a completed or closed Idea");
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
  if (existing.status === "completed" || existing.status === "closed") {
    throw new Error("Cannot release a completed or closed Idea");
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
  const idea = await prisma.idea.delete({ where: { uuid } });
  eventBus.emitChange({ companyUuid: idea.companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: idea.uuid, action: "deleted" });
  return idea;
}

// Move Idea to a different project
export async function moveIdea(
  companyUuid: string,
  ideaUuid: string,
  targetProjectUuid: string,
  actorUuid: string,
  actorType: string = "user"
): Promise<IdeaResponse> {
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

  // Transaction: update idea + linked proposals
  await prisma.$transaction(async (tx) => {
    // Update Idea.projectUuid
    await tx.idea.update({
      where: { uuid: ideaUuid },
      data: { projectUuid: targetProjectUuid },
    });

    // Update linked Proposal.projectUuid (draft or pending only)
    await tx.proposal.updateMany({
      where: {
        companyUuid,
        inputType: "idea",
        inputUuids: { array_contains: [ideaUuid] },
        status: { in: ["draft", "pending"] },
      },
      data: { projectUuid: targetProjectUuid },
    });
  });

  // Log activity
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
    },
  });

  // Emit changes for both projects
  eventBus.emitChange({ companyUuid, projectUuid: fromProjectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });
  eventBus.emitChange({ companyUuid, projectUuid: targetProjectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  // Return updated idea
  const updated = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
    include: { project: { select: { uuid: true, name: true } } },
  });
  return formatIdeaResponse(updated!);
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
  | "closed"            // Idea closed
  | null;

export interface DerivedStatusResult {
  derivedStatus: DerivedIdeaStatus;
  badgeHint: BadgeHint;
}

export function computeDerivedStatus(ctx: DerivedStatusContext): DerivedStatusResult {
  const normalized = normalizeIdeaStatus(ctx.ideaStatus);

  switch (normalized) {
    case "completed":
      return { derivedStatus: "done", badgeHint: "done" };
    case "closed":
      return { derivedStatus: "closed", badgeHint: "closed" };
    case "open":
      return { derivedStatus: "todo", badgeHint: "open" };
    case "elaborating":
      // Only pending_answers means human needs to act; otherwise agent is working
      if (ctx.elaborationStatus === "pending_answers")
        return { derivedStatus: "human_conduct_required", badgeHint: "answer_questions" };
      return { derivedStatus: "in_progress", badgeHint: "researching" };
    case "proposal_created": {
      if (ctx.hasApprovedProposal) {
        // Approved — derive from task progress
        const allDone = ctx.taskStatuses.length > 0
          && ctx.taskStatuses.every((s) => s === "done" || s === "closed");
        if (allDone) return { derivedStatus: "done", badgeHint: "done" };
        // Only enter verify_work when ALL tasks are done/closed/to_verify (none still building)
        const allFinishedOrVerify = ctx.taskStatuses.length > 0
          && ctx.taskStatuses.every((s) => s === "done" || s === "closed" || s === "to_verify");
        if (allFinishedOrVerify && ctx.taskStatuses.some((s) => s === "to_verify"))
          return { derivedStatus: "human_conduct_required", badgeHint: "verify_work" };
        return { derivedStatus: "in_progress", badgeHint: "building" };
      }
      if (ctx.hasPendingProposal)
        return { derivedStatus: "human_conduct_required", badgeHint: "review_proposal" };
      // draft or rejected — agent still drafting proposal
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
    select: { uuid: true, status: true },
  });

  const approvedProposal = proposals.find((p) => p.status === "approved");
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
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

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
  // Also track which ideas have a pending proposal
  const ideaToLatestApproved = new Map<string, { uuid: string; createdAt: Date }>();
  const ideasWithPendingProposal = new Set<string>();

  for (const proposal of proposals) {
    const inputUuids = proposal.inputUuids as string[];
    if (!Array.isArray(inputUuids)) continue;
    for (const ideaUuid of inputUuids) {
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
    if (ds === "closed") continue;

    const formatted: TrackerIdeaItem = {
      uuid: idea.uuid,
      title: idea.title,
      status: idea.status,
      derivedStatus: ds,
      badgeHint: idea.badgeHint,
      createdAt: idea.createdAt.toISOString(),
    };

    if (groups[ds]) {
      groups[ds].push(formatted);
      counts[ds]++;
    }
  }

  return { groups, counts };
}
