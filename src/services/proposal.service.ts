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
function ensureDocumentDraftUuid(draft: Omit<DocumentDraft, "uuid"> & { uuid?: string }): DocumentDraft {
  return {
    ...draft,
    uuid: draft.uuid || randomUUID(),
  };
}

// Ensure TaskDraft has a UUID
function ensureTaskDraftUuid(draft: Omit<TaskDraft, "uuid"> & { uuid?: string }): TaskDraft {
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
  acceptanceCriteria?: string;  // acceptance criteria (legacy Markdown)
  acceptanceCriteriaItems?: AcceptanceCriteriaItem[];  // structured acceptance criteria items
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
  documentDrafts?: DocumentDraftInput[];  // UUID optional, will be auto-generated
  taskDrafts?: TaskDraftInput[];          // UUID optional, will be auto-generated
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

  // E1: Must have at least one PRD document draft
  if (!documentDrafts.some((d) => d.type === "prd")) {
    issues.push({
      id: "E1",
      level: "error",
      message: "Proposal must contain at least one PRD document draft",
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

  // E-AC: Every task draft must have acceptance criteria (structured items or legacy Markdown)
  for (const draft of taskDrafts) {
    const hasLegacy = draft.acceptanceCriteria && draft.acceptanceCriteria.trim().length > 0;
    const hasStructured = draft.acceptanceCriteriaItems && draft.acceptanceCriteriaItems.length > 0;
    if (!hasLegacy && !hasStructured) {
      issues.push({
        id: "E-AC",
        level: "error",
        message: `Task draft "${draft.title}" is missing acceptance criteria`,
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
  // Ensure all drafts have UUIDs
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
      // Cast JSON arrays through unknown for proper type compatibility
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
export async function approveProposal(
  proposalUuid: string,
  companyUuid: string,
  reviewedByUuid: string,
  reviewNote?: string | null
): Promise<ProposalResponse> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid },
  });

  if (!proposal) {
    throw new Error("Proposal not found");
  }

  // Start transaction
  const updatedProposal = await prisma.$transaction(async (tx) => {
    // Update Proposal status
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

    // Create artifacts from container content
    const documentDrafts = proposal.documentDrafts as DocumentDraft[] | null;
    const taskDrafts = proposal.taskDrafts as TaskDraft[] | null;

    // Create documents (if document drafts exist)
    if (documentDrafts && documentDrafts.length > 0) {
      for (const draft of documentDrafts) {
        await createDocumentFromProposal(
          proposal.companyUuid,
          proposal.projectUuid,
          proposal.uuid,
          proposal.createdByUuid,
          draft
        );
      }
    }

    // Create tasks (if task drafts exist)
    if (taskDrafts && taskDrafts.length > 0) {
      // Validate acceptanceCriteriaItems before materializing
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

      const { draftToTaskUuidMap } = await createTasksFromProposal(
        proposal.companyUuid,
        proposal.projectUuid,
        proposal.uuid,
        proposal.createdByUuid,
        taskDrafts
      );

      // Materialize dependencies: convert draftUuid references to real taskUuids
      for (const draft of taskDrafts) {
        if (draft.dependsOnDraftUuids && draft.dependsOnDraftUuids.length > 0) {
          const taskUuid = draftToTaskUuidMap.get(draft.uuid);
          if (!taskUuid) continue;

          for (const depDraftUuid of draft.dependsOnDraftUuids) {
            const depTaskUuid = draftToTaskUuidMap.get(depDraftUuid);
            if (!depTaskUuid) continue;

            await tx.taskDependency.create({
              data: { taskUuid, dependsOnUuid: depTaskUuid },
            });
          }
        }

        // Materialize acceptance criteria items
        if (draft.acceptanceCriteriaItems && draft.acceptanceCriteriaItems.length > 0) {
          const taskUuid = draftToTaskUuidMap.get(draft.uuid);
          if (!taskUuid) continue;

          await tx.acceptanceCriterion.createMany({
            data: draft.acceptanceCriteriaItems.map((item, index) => ({
              taskUuid,
              description: item.description.trim(),
              required: item.required ?? true,
              sortOrder: index,
            })),
          });
        }
      }
    }

    return updated;
  });

  eventBus.emitChange({ companyUuid: proposal.companyUuid, projectUuid: proposal.projectUuid, entityType: "proposal", entityUuid: proposalUuid, action: "updated" });

  // Auto-complete input Ideas when proposal is approved
  if (proposal.inputType === "idea") {
    const inputUuids = (proposal.inputUuids as string[]) || [];
    if (inputUuids.length > 0) {
      await prisma.idea.updateMany({
        where: { uuid: { in: inputUuids }, companyUuid, status: "proposal_created" },
        data: { status: "completed" },
      });
    }
  }

  return formatProposalResponse(updatedProposal);
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

  // Auto-transition input Ideas to proposal_created
  if (proposal.inputType === "idea") {
    const inputUuids = (proposal.inputUuids as string[]) || [];
    if (inputUuids.length > 0) {
      await prisma.idea.updateMany({
        where: { uuid: { in: inputUuids }, companyUuid, status: "elaborating" },
        data: { status: "proposal_created" },
      });
    }
  }

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

  return formatProposalResponse(updated);
}
