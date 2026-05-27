// src/services/document.service.ts
// Document Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma, TransactionClient } from "@/lib/prisma";
import { formatCreatedBy } from "@/lib/uuid-resolver";
import { eventBus } from "@/lib/event-bus";
import * as activityService from "@/services/activity.service";
import logger from "@/lib/logger";

const docLogger = logger.child({ module: "document.service" });

// ===== Type Definitions =====

export interface DocumentListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  type?: string;
}

export interface DocumentCreateParams {
  companyUuid: string;
  projectUuid: string;
  type: string;
  title: string;
  content?: string | null;
  proposalUuid?: string | null;
  createdByUuid: string;
}

export interface DocumentUpdateParams {
  title?: string;
  content?: string | null;
  incrementVersion?: boolean;
}

// API response format
export interface DocumentResponse {
  uuid: string;
  type: string;
  title: string;
  content?: string | null;
  version: number;
  proposalUuid: string | null;
  project?: { uuid: string; name: string };
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ===== Internal Helper Functions =====

// Format a single Document into API response format
async function formatDocumentResponse(
  doc: {
    uuid: string;
    type: string;
    title: string;
    content?: string | null;
    version: number;
    proposalUuid: string | null;
    createdByUuid: string;
    createdAt: Date;
    updatedAt: Date;
    project?: { uuid: string; name: string };
  },
  includeContent = false
): Promise<DocumentResponse> {
  const createdBy = await formatCreatedBy(doc.createdByUuid);

  const response: DocumentResponse = {
    uuid: doc.uuid,
    type: doc.type,
    title: doc.title,
    version: doc.version,
    proposalUuid: doc.proposalUuid,
    createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };

  if (includeContent && doc.content !== undefined) {
    response.content = doc.content;
  }

  if (doc.project) {
    response.project = doc.project;
  }

  return response;
}

// ===== Service Methods =====

// List documents query
export async function listDocuments({
  companyUuid,
  projectUuid,
  skip,
  take,
  type,
}: DocumentListParams): Promise<{ documents: DocumentResponse[]; total: number }> {
  const where = {
    projectUuid,
    companyUuid,
    ...(type && { type }),
  };

  const [rawDocuments, total] = await Promise.all([
    prisma.document.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        type: true,
        title: true,
        version: true,
        proposalUuid: true,
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.document.count({ where }),
  ]);

  const documents = await Promise.all(
    rawDocuments.map((doc) => formatDocumentResponse(doc))
  );
  return { documents, total };
}

// List Documents tied to one or more Proposals (e.g. all reports across an
// Idea's approved Proposals). Returned with content so callers can render
// Markdown without a follow-up `getDocument` per row.
export async function listDocumentsByProposalUuids(
  companyUuid: string,
  proposalUuids: string[],
  type?: string,
): Promise<DocumentResponse[]> {
  if (proposalUuids.length === 0) return [];

  const where = {
    companyUuid,
    proposalUuid: { in: proposalUuids },
    ...(type && { type }),
  };

  const rawDocuments = await prisma.document.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      uuid: true,
      type: true,
      title: true,
      content: true,
      version: true,
      proposalUuid: true,
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return Promise.all(rawDocuments.map((doc) => formatDocumentResponse(doc, true)));
}

// Get Document details
export async function getDocument(
  companyUuid: string,
  uuid: string
): Promise<DocumentResponse | null> {
  const doc = await prisma.document.findFirst({
    where: { uuid, companyUuid },
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  if (!doc) return null;
  return formatDocumentResponse(doc, true);
}

// Get raw Document data by UUID (internal use)
export async function getDocumentByUuid(companyUuid: string, uuid: string) {
  return prisma.document.findFirst({
    where: { uuid, companyUuid },
  });
}

// Get raw Document by UUID without company scoping. Used by callers that need
// to make their own tenant-isolation decision (e.g. Server Actions returning a
// distinct error code for cross-company access vs. true 404).
export async function getDocumentByUuidUnscoped(uuid: string) {
  return prisma.document.findFirst({
    where: { uuid },
  });
}

// Create Document
export async function createDocument(
  params: DocumentCreateParams
): Promise<DocumentResponse> {
  const doc = await prisma.document.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      type: params.type,
      title: params.title,
      content: params.content,
      version: 1,
      proposalUuid: params.proposalUuid,
      createdByUuid: params.createdByUuid,
    },
    select: {
      uuid: true,
      type: true,
      title: true,
      content: true,
      version: true,
      proposalUuid: true,
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Report-only side effects: SSE fan-out (document + idea) and Activity-driven
  // notification. All three are best-effort — the Document insert above is the
  // source of truth, so any failure here is logged and swallowed. See spec
  // `report-realtime` Requirement 1 (failure semantics).
  if (params.type === "report") {
    await emitReportSideEffects(params, doc.uuid);
  }

  return formatDocumentResponse(doc, true);
}

// Encapsulates the report-only fan-out: document/created event, idea/updated
// event, and the report_created Activity. Each step has its own try/catch so a
// later failure cannot suppress an earlier success (and vice versa). Resolving
// the parent Idea is gated on (a) the proposal being idea-rooted and (b) a
// non-empty inputUuids array — anything else skips the idea-scoped events
// without being treated as an error.
async function emitReportSideEffects(
  params: DocumentCreateParams,
  reportUuid: string,
): Promise<void> {
  // Step 1 — document/created. Always fires for report-typed docs, regardless
  // of whether the parent proposal is idea-rooted.
  try {
    eventBus.emitChange({
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      entityType: "document",
      entityUuid: reportUuid,
      action: "created",
      actorUuid: params.createdByUuid,
    });
  } catch (err) {
    docLogger.warn(
      { err, reportUuid, proposalUuid: params.proposalUuid },
      "Failed to emit document/created event for report",
    );
  }

  if (!params.proposalUuid) return;

  // Step 2 — resolve idea. Direct Prisma read instead of going through
  // proposal.service to avoid a service-layer circular import (proposal.service
  // already imports from document.service for createDocumentFromProposal).
  let ideaUuid: string | null = null;
  try {
    const proposal = await prisma.proposal.findFirst({
      where: { uuid: params.proposalUuid, companyUuid: params.companyUuid },
      select: { inputType: true, inputUuids: true },
    });
    if (proposal && proposal.inputType === "idea" && Array.isArray(proposal.inputUuids)) {
      const first = (proposal.inputUuids as string[])[0];
      if (typeof first === "string" && first.length > 0) ideaUuid = first;
    }
  } catch (err) {
    docLogger.warn(
      { err, reportUuid, proposalUuid: params.proposalUuid },
      "Failed to resolve parent Idea for report side effects",
    );
    return;
  }

  if (!ideaUuid) return;

  // Step 3 — idea/updated event. Drives IdeaTrackerList reportCount refresh.
  try {
    eventBus.emitChange({
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      entityType: "idea",
      entityUuid: ideaUuid,
      action: "updated",
      actorUuid: params.createdByUuid,
    });
  } catch (err) {
    docLogger.warn(
      { err, reportUuid, ideaUuid, proposalUuid: params.proposalUuid },
      "Failed to emit idea/updated event for report",
    );
  }

  // Step 4 — Activity event. Routed through activity.service so the existing
  // notification-listener picks it up; the new "report_created" action mapping
  // lives in notification-listener.ts (separate task in this proposal).
  try {
    const actor = await formatCreatedBy(params.createdByUuid);
    const actorType = actor?.type ?? "agent";
    await activityService.createActivity({
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType,
      actorUuid: params.createdByUuid,
      action: "report_created",
      value: {
        reportUuid,
        proposalUuid: params.proposalUuid,
        reportTitle: params.title,
      },
    });
  } catch (err) {
    docLogger.warn(
      { err, reportUuid, ideaUuid, proposalUuid: params.proposalUuid },
      "Failed to record report_created Activity",
    );
  }
}

// Update Document
export async function updateDocument(
  uuid: string,
  { title, content, incrementVersion }: DocumentUpdateParams
): Promise<DocumentResponse> {
  const data: { title?: string; content?: string | null; version?: { increment: number } } = {};

  if (title !== undefined) {
    data.title = title;
  }
  if (content !== undefined) {
    data.content = content;
  }
  if (incrementVersion) {
    data.version = { increment: 1 };
  }

  const doc = await prisma.document.update({
    where: { uuid },
    data,
    include: {
      project: { select: { uuid: true, name: true } },
    },
  });

  return formatDocumentResponse(doc, true);
}

// Delete Document
export async function deleteDocument(uuid: string) {
  return prisma.document.delete({ where: { uuid } });
}

// Create Document from Proposal
export async function createDocumentFromProposal(
  companyUuid: string,
  projectUuid: string,
  proposalUuid: string,
  createdByUuid: string,
  doc: { type: string; title: string; content?: string },
  tx?: TransactionClient
): Promise<DocumentResponse> {
  const db = tx ?? prisma;
  const created = await db.document.create({
    data: {
      companyUuid,
      projectUuid,
      type: doc.type || "prd",
      title: doc.title,
      content: doc.content || null,
      version: 1,
      proposalUuid,
      createdByUuid,
    },
    select: {
      uuid: true,
      type: true,
      title: true,
      content: true,
      version: true,
      proposalUuid: true,
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return formatDocumentResponse(created, true);
}
