// src/services/proposal.service.ts
// Proposal Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs
// Container Model: Proposal contains documentDrafts and taskDrafts

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { formatCreatedBy, formatReview } from "@/lib/uuid-resolver";
import { eventBus } from "@/lib/event-bus";
import { createDocumentFromProposal } from "./document.service";
import { createTasksFromProposal } from "./task.service";

// ===== UUID Helper Functions =====

// Ensure DocumentDraft has a UUID
export function ensureDocumentDraftUuid(draft: Omit<DocumentDraft, "uuid"> & { uuid?: string }): DocumentDraft {
  return {
    ...draft,
    uuid: draft.uuid || randomUUID(),
  };
}

// Ensure TaskDraft has a UUID
export function ensureTaskDraftUuid(draft: Omit<TaskDraft, "uuid"> & { uuid?: string }): TaskDraft {
  return {
    ...draft,
    uuid: draft.uuid || randomUUID(),
  };
}

// ===== Type Definitions =====

export interface ProposalListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  status?: string;
}

// Document draft type (with UUID for tracking and modification)
export interface DocumentDraft {
  uuid: string;      // Draft UUID for tracking
  type: string;
  title: string;
  content: string;
}

// Acceptance criteria item (stored in taskDrafts JSON)
export interface AcceptanceCriteriaItem {
  description: string;
  required?: boolean;  // defaults to true
}

// Task draft type (with UUID for tracking and modification)
export interface TaskDraft {
  uuid: string;      // Draft UUID for tracking
  title: string;
  description?: string;
  storyPoints?: number;
  priority?: string;
  acceptanceCriteria?: string;  // legacy Markdown (read-only, kept for backward-compatible viewing of old data)
  acceptanceCriteriaItems?: AcceptanceCriteriaItem[];  // structured acceptance criteria items (primary format)
  dependsOnDraftUuids?: string[];  // list of dependent taskDraft UUIDs
}

// Input types (uuid is optional, will be auto-generated)
export type DocumentDraftInput = Omit<DocumentDraft, "uuid"> & { uuid?: string };
export type TaskDraftInput = Omit<TaskDraft, "uuid"> & { uuid?: string };

export interface ProposalCreateParams {
  companyUuid: string;
  projectUuid: string;
  title: string;
  description?: string | null;
  inputType: string;
  inputUuids: string[];  // UUID array
  documentDrafts?: DocumentDraftInput[];  // Optional: used by frontend, not exposed via MCP
  taskDrafts?: TaskDraftInput[];          // Optional: used by frontend, not exposed via MCP
  createdByUuid: string;
  createdByType?: string;  // agent | user
}

// API response format
export interface ProposalResponse {
  uuid: string;
  title: string;
  description: string | null;
  inputType: string;
  inputUuids: string[];
  documentDrafts: DocumentDraft[] | null;
  taskDrafts: TaskDraft[] | null;
  status: string;
  project?: { uuid: string; name: string };
  createdBy: { type: string; uuid: string; name: string } | null;
  createdByType: string;
  review: {
    reviewedBy: { type: string; uuid: string; name: string };
    reviewNote: string | null;
    reviewedAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// ===== Internal Helper Functions =====

// Format a single Proposal into API response format
async function formatProposalResponse(
  proposal: {
    uuid: string;
    title: string;
    description: string | null;
    inputType: string;
    inputUuids: unknown;  // JSON field - array of UUID strings
    documentDrafts: unknown;
    taskDrafts: unknown;
    status: string;
    createdByUuid: string;
    createdByType: string;
    reviewedByUuid: string | null;
    reviewNote: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    project?: { uuid: string; name: string };
  }
): Promise<ProposalResponse> {
  const creatorType = proposal.createdByType === "user" ? "user" : "agent";
  const [createdBy, review] = await Promise.all([
    formatCreatedBy(proposal.createdByUuid, creatorType),
    formatReview(proposal.reviewedByUuid, proposal.reviewNote, proposal.reviewedAt),
  ]);

  const response: ProposalResponse = {
    uuid: proposal.uuid,
    title: proposal.title,
    description: proposal.description,
    inputType: proposal.inputType,
    inputUuids: proposal.inputUuids as string[],
    documentDrafts: proposal.documentDrafts as DocumentDraft[] | null,
    taskDrafts: proposal.taskDrafts as TaskDraft[] | null,
    status: proposal.status,
    createdBy,
    createdByType: proposal.createdByType,
    review,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
  };

  if (proposal.project) {
    response.project = proposal.project;
  }

  return response;
}

// ===== Validation Functions =====

export interface ValidationIssue {
  id: string;       // e.g. "E1", "W2"
  level: "error" | "warning" | "info";
  message: string;  // Human-readable English message
  field?: string;   // Optional: which draft/field has the issue
}

export interface ValidationResult {
  valid: boolean;           // true if no errors
  issues: ValidationIssue[];
}

// Validate Proposal completeness before submission
export async function validateProposal(
  companyUuid: string,
  proposalUuid: string
): Promise<ValidationResult> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  const issues: ValidationIssue[] = [];
  const documentDrafts = (proposal.documentDrafts as unknown as DocumentDraft[]) || [];
  const taskDrafts = (proposal.taskDrafts as unknown as TaskDraft[]) || [];
  const inputUuids = (proposal.inputUuids as string[]) || [];

  // --- Error Level ---

  // E1: Must have at least one document draft (any type)
  if (documentDrafts.length === 0) {
    issues.push({
      id: "E1",
      level: "error",
      message: "Proposal must contain at least one document draft",
    });
  }

  // E2: Every document draft must have content >= 100 characters
  for (const draft of documentDrafts) {
    if (!draft.content || draft.content.length < 100) {
      issues.push({
        id: "E2",
        level: "error",
        message: `Document draft "${draft.title}" must have content with at least 100 characters`,
        field: draft.title,
      });
    }
  }

  // E3: Must have at least one task draft
  if (taskDrafts.length === 0) {
    issues.push({
      id: "E3",
      level: "error",
      message: "Proposal must contain at least one task draft",
    });
  }

  // E4: inputUuids must be non-empty
  if (inputUuids.length === 0) {
    issues.push({
      id: "E4",
      level: "error",
      message: "Proposal must have at least one input (idea or other source)",
    });
  }

  // E5: All input Ideas must have elaborationStatus === "resolved"
  if (proposal.inputType === "idea" && inputUuids.length > 0) {
    const ideas = await prisma.idea.findMany({
      where: { uuid: { in: inputUuids }, companyUuid },
      select: { uuid: true, title: true, elaborationStatus: true },
    });
    for (const idea of ideas) {
      if (idea.elaborationStatus !== "resolved") {
        issues.push({
          id: "E5",
          level: "error",
          message: `Input idea "${idea.title}" has unresolved elaboration (status: ${idea.elaborationStatus})`,
          field: idea.title,
        });
      }
    }
  }

  // --- Warning Level ---

  // W1: Should have at least one tech_design document draft
  if (!documentDrafts.some((d) => d.type === "tech_design")) {
    issues.push({
      id: "W1",
      level: "warning",
      message: "Proposal should contain at least one tech design document draft",
    });
  }

  // W2: Every task draft should have a non-empty description
  for (const draft of taskDrafts) {
    if (!draft.description || draft.description.trim().length === 0) {
      issues.push({
        id: "W2",
        level: "warning",
        message: `Task draft "${draft.title}" is missing a description`,
        field: draft.title,
      });
    }
  }

  // E-AC: Every task draft must have structured acceptance criteria items
  for (const draft of taskDrafts) {
    if (!draft.acceptanceCriteriaItems || draft.acceptanceCriteriaItems.length === 0) {
      issues.push({
        id: "E-AC",
        level: "error",
        message: `Task draft "${draft.title}" is missing acceptance criteria (structured items required)`,
        field: draft.title,
      });
    }
  }

  // W4: When >= 2 task drafts, at least one should have dependsOnDraftUuids
  if (taskDrafts.length >= 2) {
    const hasDeps = taskDrafts.some(
      (d) => d.dependsOnDraftUuids && d.dependsOnDraftUuids.length > 0
    );
    if (!hasDeps) {
      issues.push({
        id: "W4",
        level: "warning",
        message: "When there are multiple tasks, at least one should declare dependencies",
      });
    }
  }

  // W5: Proposal description should be non-empty
  if (!proposal.description || proposal.description.trim().length === 0) {
    issues.push({
      id: "W5",
      level: "warning",
      message: "Proposal description should not be empty",
    });
  }

  // --- Info Level ---

  // I1: Every task draft should have priority set
  for (const draft of taskDrafts) {
    if (!draft.priority) {
      issues.push({
        id: "I1",
        level: "info",
        message: `Task draft "${draft.title}" does not have a priority set`,
        field: draft.title,
      });
    }
  }

  // I2: Every task draft should have storyPoints set
  for (const draft of taskDrafts) {
    if (draft.storyPoints == null) {
      issues.push({
        id: "I2",
        level: "info",
        message: `Task draft "${draft.title}" does not have story points set`,
        field: draft.title,
      });
    }
  }

  const hasErrors = issues.some((i) => i.level === "error");
  return {
    valid: !hasErrors,
    issues,
  };
}

// Check if Ideas are already used by other Proposals
export async function checkIdeasAvailability(
  companyUuid: string,
  ideaUuids: string[]
): Promise<{ available: boolean; usedIdeas: { uuid: string; proposalUuid: string; proposalTitle: string }[] }> {
  // Find all proposals that use any of the given ideas
  const proposals = await prisma.proposal.findMany({
    where: {
      companyUuid,
      inputType: "idea",
    },
    select: {
      uuid: true,
      title: true,
      inputUuids: true,
    },
  });

  const usedIdeas: { uuid: string; proposalUuid: string; proposalTitle: string }[] = [];

  for (const proposal of proposals) {
    const proposalInputUuids = proposal.inputUuids as string[];
    for (const ideaUuid of ideaUuids) {
      if (proposalInputUuids.includes(ideaUuid)) {
        usedIdeas.push({
          uuid: ideaUuid,
          proposalUuid: proposal.uuid,
          proposalTitle: proposal.title,
        });
      }
    }
  }

  return {
    available: usedIdeas.length === 0,
    usedIdeas,
  };
}

// Check if the current user is the assignee of the Ideas
export async function checkIdeasAssignee(
  companyUuid: string,
  ideaUuids: string[],
  actorUuid: string,
  actorType: string
): Promise<{ valid: boolean; unassignedIdeas: string[] }> {
  const ideas = await prisma.idea.findMany({
    where: {
      uuid: { in: ideaUuids },
      companyUuid,
    },
    select: {
      uuid: true,
      assigneeType: true,
      assigneeUuid: true,
    },
  });

  const unassignedIdeas: string[] = [];

  for (const idea of ideas) {
    // Check if current actor is the assignee
    const isAssignee =
      idea.assigneeType === actorType && idea.assigneeUuid === actorUuid;

    if (!isAssignee) {
      unassignedIdeas.push(idea.uuid);
    }
  }

  return {
    valid: unassignedIdeas.length === 0,
    unassignedIdeas,
  };
}

// ===== Service Methods =====

// Get proposals that reference a specific idea UUID
export async function getProposalsByIdeaUuid(
  companyUuid: string,
  projectUuid: string,
  ideaUuid: string,
): Promise<ProposalResponse[]> {
  const rawProposals = await prisma.proposal.findMany({
    where: { projectUuid, companyUuid },
    orderBy: { createdAt: "desc" },
    select: {
      uuid: true,
      title: true,
      description: true,
      inputType: true,
      inputUuids: true,
      documentDrafts: true,
      taskDrafts: true,
      status: true,
      createdByUuid: true,
      createdByType: true,
      reviewedByUuid: true,
      reviewNote: true,
      reviewedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Filter by ideaUuid in the JSON inputUuids array (Prisma JSON filtering is DB-dependent)
  const matching = rawProposals.filter(
    (p) => Array.isArray(p.inputUuids) && (p.inputUuids as string[]).includes(ideaUuid),
  );

  return Promise.all(matching.map((p) => formatProposalResponse(p)));
}

// List proposals query
export async function listProposals({
  companyUuid,
  projectUuid,
  skip,
  take,
  status,
}: ProposalListParams): Promise<{ proposals: ProposalResponse[]; total: number }> {
  const where = {
    projectUuid,
    companyUuid,
    ...(status && { status }),
  };

  const [rawProposals, total] = await Promise.all([
    prisma.proposal.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        uuid: true,
        title: true,
        description: true,
        inputType: true,
        inputUuids: true,
        documentDrafts: true,
        taskDrafts: true,
        status: true,
        createdByUuid: true,
        createdByType: true,
        reviewedByUuid: true,
        reviewNote: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.proposal.count({ where }),
  ]);

  const proposals = await Promise.all(
    rawProposals.map((p) => formatProposalResponse(p))
  );
  return { proposals, total };
}

// Get Proposal details
export async function getProposal(
  companyUuid: string,
  uuid: string
): Promise<ProposalResponse | null> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid, companyUuid },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  if (!proposal) return null;
  return formatProposalResponse(proposal);
}

// Get raw Proposal data by UUID (internal use)
export async function getProposalByUuid(companyUuid: string, uuid: string) {
  return prisma.proposal.findFirst({
    where: { uuid, companyUuid },
  });
}

// Create Proposal (container)
export async function createProposal(
  params: ProposalCreateParams
): Promise<ProposalResponse> {
  // Ensure all drafts have UUIDs (frontend may still pass drafts at creation time)
  const documentDraftsWithUuids = params.documentDrafts?.map(ensureDocumentDraftUuid);
  const taskDraftsWithUuids = params.taskDrafts?.map(ensureTaskDraftUuid);

  const proposal = await prisma.proposal.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      title: params.title,
      description: params.description,
      inputType: params.inputType,
      inputUuids: params.inputUuids as unknown as Prisma.InputJsonValue,
      ...(documentDraftsWithUuids && { documentDrafts: documentDraftsWithUuids as unknown as Prisma.InputJsonValue }),
      ...(taskDraftsWithUuids && { taskDrafts: taskDraftsWithUuids as unknown as Prisma.InputJsonValue }),
      status: "draft",
      createdByUuid: params.createdByUuid,
      createdByType: params.createdByType || "agent",
    },
    select: {
      uuid: true,
      title: true,
      description: true,
      inputType: true,
      inputUuids: true,
      documentDrafts: true,
      taskDrafts: true,
      status: true,
      createdByUuid: true,
      createdByType: true,
      reviewedByUuid: true,
      reviewNote: true,
      reviewedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: params.projectUuid, entityType: "proposal", entityUuid: proposal.uuid, action: "created" });

  return formatProposalResponse(proposal);
}

// Update Proposal content (add/modify document drafts and tasks)
export async function updateProposalContent(
  proposalUuid: string,
  companyUuid: string,
  updates: {
    title?: string;
    description?: string | null;
    documentDrafts?: DocumentDraft[] | null;
    taskDrafts?: TaskDraft[] | null;
  }
): Promise<ProposalResponse> {
  // Build update data with proper JSON null handling
  const updateData: Prisma.ProposalUpdateInput = {};

  if (updates.title) {
    updateData.title = updates.title;
  }
  if (updates.description !== undefined) {
    updateData.description = updates.description;
  }
  if (updates.documentDrafts !== undefined) {
    updateData.documentDrafts = updates.documentDrafts === null
      ? Prisma.JsonNull
      : (updates.documentDrafts as unknown as Prisma.InputJsonValue);
  }
  if (updates.taskDrafts !== undefined) {
    updateData.taskDrafts = updates.taskDrafts === null
      ? Prisma.JsonNull
      : (updates.taskDrafts as unknown as Prisma.InputJsonValue);
  }

  const proposal = await prisma.proposal.update({
    where: { uuid: proposalUuid, companyUuid },
    data: updateData,
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  return formatProposalResponse(proposal);
}

// Approve Proposal
export interface ApprovalResult extends ProposalResponse {
  materializedTasks?: Array<{ draftUuid: string; taskUuid: string; title: string }>;
  materializedDocuments?: Array<{ draftUuid: string; documentUuid: string; title: string }>;
}

export interface RevokeResult {
  proposalUuid: string;
  closedTasks: { uuid: string; title: string }[];
  deletedDocuments: { uuid: string; title: string }[];
}

export async function approveProposal(
  proposalUuid: string,
  companyUuid: string,
  reviewedByUuid: string,
  reviewNote?: string | null
): Promise<ApprovalResult> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  // Start transaction
  const { updatedProposal, materializedTasks, materializedDocuments } = await prisma.$transaction(async (tx) => {
    // 1. Update Proposal status
    const updated = await tx.proposal.update({
      where: { uuid: proposalUuid },
      data: {
        status: "approved",
        reviewedByUuid,
        reviewNote: reviewNote || null,
        reviewedAt: new Date(),
      },
      include: {
        project: { select: { uuid: true, name: true } },
      },
    });

    const documentDrafts = proposal.documentDrafts as DocumentDraft[] | null;
    const taskDrafts = proposal.taskDrafts as TaskDraft[] | null;

    const matTasks: Array<{ draftUuid: string; taskUuid: string; title: string }> = [];
    const matDocs: Array<{ draftUuid: string; documentUuid: string; title: string }> = [];

    // 2. Batch create documents (1 SQL)
    if (documentDrafts && documentDrafts.length > 0) {
      const createdDocs = await tx.document.createManyAndReturn({
        data: documentDrafts.map((draft) => ({
          companyUuid: proposal.companyUuid,
          projectUuid: proposal.projectUuid,
          type: draft.type || "prd",
          title: draft.title,
          content: draft.content || null,
          version: 1,
          proposalUuid: proposal.uuid,
          createdByUuid: proposal.createdByUuid,
        })),
        select: { uuid: true, title: true },
      });
      for (let i = 0; i < documentDrafts.length; i++) {
        matDocs.push({ draftUuid: documentDrafts[i].uuid, documentUuid: createdDocs[i].uuid, title: createdDocs[i].title });
      }
    }

    // 3. Batch create tasks (1 SQL)
    if (taskDrafts && taskDrafts.length > 0) {
      // Validate AC items before materializing
      for (const draft of taskDrafts) {
        if (draft.acceptanceCriteriaItems && draft.acceptanceCriteriaItems.length > 0) {
          for (let i = 0; i < draft.acceptanceCriteriaItems.length; i++) {
            const item = draft.acceptanceCriteriaItems[i];
            if (!item.description || typeof item.description !== "string" || item.description.trim().length === 0) {
              throw new Error(
                `Task draft "${draft.title}": acceptanceCriteriaItems[${i}] has an empty or invalid description`
              );
            }
          }
        }
      }

      const createdTasks = await tx.task.createManyAndReturn({
        data: taskDrafts.map((draft) => ({
          companyUuid: proposal.companyUuid,
          projectUuid: proposal.projectUuid,
          title: draft.title,
          description: draft.description || null,
          status: "open",
          priority: draft.priority || "medium",
          storyPoints: draft.storyPoints || null,
          acceptanceCriteria: draft.acceptanceCriteria || null,
          proposalUuid: proposal.uuid,
          createdByUuid: proposal.createdByUuid,
        })),
        select: { uuid: true, title: true },
      });

      // Build draftUuid -> taskUuid mapping
      const draftToTaskUuidMap = new Map<string, string>();
      for (let i = 0; i < taskDrafts.length; i++) {
        draftToTaskUuidMap.set(taskDrafts[i].uuid, createdTasks[i].uuid);
        matTasks.push({ draftUuid: taskDrafts[i].uuid, taskUuid: createdTasks[i].uuid, title: createdTasks[i].title });
      }

      // 4. Batch create dependencies (1 SQL)
      const allDeps: Array<{ taskUuid: string; dependsOnUuid: string }> = [];
      for (const draft of taskDrafts) {
        if (draft.dependsOnDraftUuids && draft.dependsOnDraftUuids.length > 0) {
          const taskUuid = draftToTaskUuidMap.get(draft.uuid);
          if (!taskUuid) continue;
          for (const depDraftUuid of draft.dependsOnDraftUuids) {
            const depTaskUuid = draftToTaskUuidMap.get(depDraftUuid);
            if (!depTaskUuid) continue;
            allDeps.push({ taskUuid, dependsOnUuid: depTaskUuid });
          }
        }
      }
      if (allDeps.length > 0) {
        await tx.taskDependency.createMany({ data: allDeps });
      }

      // 5. Batch create ALL acceptance criteria (1 SQL)
      const allAC: Array<{ taskUuid: string; description: string; required: boolean; sortOrder: number }> = [];
      for (const draft of taskDrafts) {
        if (draft.acceptanceCriteriaItems && draft.acceptanceCriteriaItems.length > 0) {
          const taskUuid = draftToTaskUuidMap.get(draft.uuid);
          if (!taskUuid) continue;
          for (let i = 0; i < draft.acceptanceCriteriaItems.length; i++) {
            const item = draft.acceptanceCriteriaItems[i];
            allAC.push({
              taskUuid,
              description: item.description.trim(),
              required: item.required ?? true,
              sortOrder: i,
            });
          }
        }
      }
      if (allAC.length > 0) {
        await tx.acceptanceCriterion.createMany({ data: allAC });
      }
    }

    return { updatedProposal: updated, materializedTasks: matTasks, materializedDocuments: matDocs };
  }, { timeout: 15000 });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });

  // Note: We do NOT auto-complete input Ideas here.
  // The Idea's derived status is computed from its linked Tasks' progress:
  //   proposal_created + approved proposal → in_review (tasks not started)
  //   proposal_created + tasks to_verify   → verifying
  //   All tasks done                       → idea auto-completed by task completion flow
  // See computeDerivedStatus() in idea.service.ts.

  const response: ApprovalResult = await formatProposalResponse(updatedProposal);
  if (materializedTasks.length > 0) response.materializedTasks = materializedTasks;
  if (materializedDocuments.length > 0) response.materializedDocuments = materializedDocuments;
  return response;
}

export async function getMaterializedEntities(companyUuid: string, proposalUuid: string) {
  const [tasks, documents] = await Promise.all([
    prisma.task.findMany({
      where: { companyUuid, proposalUuid },
      select: { uuid: true, title: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.document.findMany({
      where: { companyUuid, proposalUuid },
      select: { uuid: true, title: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { tasks, documents };
}

// Revoke Proposal (approved -> draft, undo materialization)
// Cascade-closes tasks, deletes documents, cleans up related records
export async function revokeProposal(
  proposalUuid: string,
  companyUuid: string,
  revokedByUuid: string,
  reviewNote?: string
): Promise<RevokeResult> {
  // 1. Validate proposal exists, belongs to company, status === 'approved'
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  if (proposal.status !== "approved") {
    throw new Error("Only approved proposals can be revoked");
  }

  // 2. Find all materialized Tasks and Documents before the transaction
  const [tasksToClose, docsToDelete] = await Promise.all([
    prisma.task.findMany({
      where: { proposalUuid: proposal.uuid },
      select: { uuid: true, title: true },
    }),
    prisma.document.findMany({
      where: { proposalUuid: proposal.uuid },
      select: { uuid: true, title: true },
    }),
  ]);

  const closedTasks = tasksToClose.map((t) => ({ uuid: t.uuid, title: t.title }));
  const deletedDocuments = docsToDelete.map((d) => ({ uuid: d.uuid, title: d.title }));

  // 3. Execute all cleanup within a transaction
  await prisma.$transaction(async (tx) => {
    const taskUuids = closedTasks.map((t) => t.uuid);
    const docUuids = deletedDocuments.map((d) => d.uuid);

    if (taskUuids.length > 0) {
      await tx.sessionTaskCheckin.deleteMany({
        where: { taskUuid: { in: taskUuids } },
      });

      // Remove external dependencies (other tasks depending on revoked tasks)
      // Internal deps (both sides in taskUuids) are kept for history
      await tx.taskDependency.deleteMany({
        where: {
          dependsOnUuid: { in: taskUuids },
          taskUuid: { notIn: taskUuids },
        },
      });

      await tx.task.updateMany({
        where: { proposalUuid: proposal.uuid },
        data: { status: "closed" },
      });
    }

    if (docUuids.length > 0) {
      await tx.comment.deleteMany({
        where: { targetType: "document", targetUuid: { in: docUuids } },
      });

      await tx.document.deleteMany({
        where: { proposalUuid: proposal.uuid },
      });
    }

    // 4h. Update proposal: revert to draft, clear review info, set reviewNote
    await tx.proposal.update({
      where: { uuid: proposalUuid },
      data: {
        status: "draft",
        reviewedByUuid: revokedByUuid,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      },
    });
  }, { timeout: 15000 });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });

  return { proposalUuid, closedTasks, deletedDocuments };
}

// Reject Proposal (reject -> draft, can be re-edited)
// Preserve reviewedByUuid/reviewedAt/reviewNote as revision reference
export async function rejectProposal(
  proposalUuid: string,
  reviewedByUuid: string,
  reviewNote: string
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      status: "draft",
      reviewedByUuid,
      reviewNote,
      reviewedAt: new Date(),
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposal.uuid, action: "updated" });

  return formatProposalResponse(proposal);
}

// Close Proposal (terminal state)
export async function closeProposal(
  proposalUuid: string,
  closedByUuid: string,
  reviewNote: string
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      status: "closed",
      reviewedByUuid: closedByUuid,
      reviewNote,
      reviewedAt: new Date(),
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposal.uuid, action: "updated" });

  return formatProposalResponse(proposal);
}

// Delete Proposal (only draft or closed)
export async function deleteProposal(
  proposalUuid: string,
  companyUuid: string
): Promise<void> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  await prisma.proposal.delete({ where: { uuid: proposalUuid } });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposal.uuid, action: "deleted" });
}

// ===== Draft Management Functions =====

// Submit Proposal for review (draft -> pending)
export async function submitProposal(
  proposalUuid: string,
  companyUuid: string
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  if (proposal.status !== "draft") {
    throw new Error("Only draft proposals can be submitted for review");
  }

  // Run full validation (includes elaboration gate E5 and all other checks)
  const validation = await validateProposal(companyUuid, proposalUuid);
  if (!validation.valid) {
    const lines = validation.issues.map(
      (i) => `[${i.level}] ${i.message}`
    );
    throw new Error(`Proposal validation failed:\n${lines.join("\n")}`);
  }

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      status: "pending",
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid: updated.companyUuid, projectUuid: updated.projectUuid, entityType: "proposal", entityUuid: updated.uuid, action: "updated" });

  return formatProposalResponse(updated);
}

// Add document draft to Proposal
export async function addDocumentDraft(
  proposalUuid: string,
  companyUuid: string,
  draft: Omit<DocumentDraft, "uuid"> & { uuid?: string }
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.documentDrafts as unknown as DocumentDraft[]) || [];
  const newDraft = ensureDocumentDraftUuid(draft);
  const updatedDrafts = [...existingDrafts, newDraft];

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      documentDrafts: updatedDrafts as unknown as Prisma.InputJsonValue,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Add task draft to Proposal
export async function addTaskDraft(
  proposalUuid: string,
  companyUuid: string,
  draft: Omit<TaskDraft, "uuid"> & { uuid?: string }
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.taskDrafts as unknown as TaskDraft[]) || [];
  const newDraft = ensureTaskDraftUuid(draft);
  const updatedDrafts = [...existingDrafts, newDraft];

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      taskDrafts: updatedDrafts as unknown as Prisma.InputJsonValue,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Update document draft
export async function updateDocumentDraft(
  proposalUuid: string,
  companyUuid: string,
  draftUuid: string,
  updates: Partial<Omit<DocumentDraft, "uuid">>
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.documentDrafts as unknown as DocumentDraft[]) || [];
  const draftIndex = existingDrafts.findIndex(d => d.uuid === draftUuid);

  if (draftIndex === -1) {
    throw new Error("Document draft not found");
  }

  existingDrafts[draftIndex] = { ...existingDrafts[draftIndex], ...updates };

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      documentDrafts: existingDrafts as unknown as Prisma.InputJsonValue,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Update task draft
export async function updateTaskDraft(
  proposalUuid: string,
  companyUuid: string,
  draftUuid: string,
  updates: Partial<Omit<TaskDraft, "uuid">>
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.taskDrafts as unknown as TaskDraft[]) || [];
  const draftIndex = existingDrafts.findIndex(d => d.uuid === draftUuid);

  if (draftIndex === -1) {
    throw new Error("Task draft not found");
  }

  existingDrafts[draftIndex] = { ...existingDrafts[draftIndex], ...updates };

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      taskDrafts: existingDrafts as unknown as Prisma.InputJsonValue,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Remove document draft
export async function removeDocumentDraft(
  proposalUuid: string,
  companyUuid: string,
  draftUuid: string
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.documentDrafts as unknown as DocumentDraft[]) || [];
  const updatedDrafts = existingDrafts.filter(d => d.uuid !== draftUuid);

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      documentDrafts: updatedDrafts.length > 0
        ? (updatedDrafts as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Remove task draft
export async function removeTaskDraft(
  proposalUuid: string,
  companyUuid: string,
  draftUuid: string
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid, status: "draft" },
  });

  if (!proposal) {
    throw new Error("Proposal not found or not in draft status");
  }

  const existingDrafts = (proposal.taskDrafts as unknown as TaskDraft[]) || [];
  const updatedDrafts = existingDrafts
    .filter(d => d.uuid !== draftUuid)
    .map(d => ({
      ...d,
      dependsOnDraftUuids: d.dependsOnDraftUuids?.filter(uuid => uuid !== draftUuid),
    }));

  const updated = await prisma.proposal.update({
    where: { uuid: proposalUuid },
    data: {
      taskDrafts: updatedDrafts.length > 0
        ? (updatedDrafts as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });
  return formatProposalResponse(updated);
}

// Get lightweight proposal list with task counts (for filter dropdown)
export async function getProjectProposals(
  companyUuid: string,
  projectUuid: string,
): Promise<Array<{ uuid: string; title: string; sequenceNumber: number; taskCount: number }>> {
  const proposals = await prisma.proposal.findMany({
    where: { companyUuid, projectUuid, status: "approved" },
    select: {
      uuid: true,
      title: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Count tasks per proposal
  const taskCounts = await prisma.task.groupBy({
    by: ["proposalUuid"],
    where: {
      companyUuid,
      projectUuid,
      proposalUuid: { in: proposals.map(p => p.uuid) },
    },
    _count: true,
  });

  const countMap = new Map(taskCounts.map(tc => [tc.proposalUuid, tc._count]));

  return proposals.map((p, index) => ({
    uuid: p.uuid,
    title: p.title,
    sequenceNumber: index + 1,
    taskCount: countMap.get(p.uuid) ?? 0,
  }));
}
