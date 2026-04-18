// src/services/document.service.ts
// Document Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma, TransactionClient } from "@/lib/prisma";
import { formatCreatedBy } from "@/lib/uuid-resolver";

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

  return formatDocumentResponse(doc, true);
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
