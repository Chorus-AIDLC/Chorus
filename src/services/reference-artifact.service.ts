// src/services/reference-artifact.service.ts
// Reference Artifact Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs.
//
// A ReferenceArtifact is first-class external evidence (GH #399 point 2) linked
// polymorphically to an idea, proposal, or task — same idiom as Comment. This
// service captures a URL + optional notes ONLY: it performs NO network fetch,
// download, or snapshot of the referenced content (q5: URL + notes capture only).

import { prisma } from "@/lib/prisma";
import { formatCreatedBy } from "@/lib/uuid-resolver";
import { eventBus, type RealtimeEvent } from "@/lib/event-bus";
import * as activityService from "@/services/activity.service";
import logger from "@/lib/logger";

const refLogger = logger.child({ module: "reference-artifact.service" });

// ===== Constants / allowed sets =====

// Allowed reference types (q4: web links only). Validated at every write boundary
// because `type` is a bare String column (matches Document.type / Comment.targetType).
export const REFERENCE_TYPES = ["docs", "repo", "issue_pr", "paper_blog"] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

// Allowed link targets. V2 (idea 4504808c q2) adds `idea`; still NOT acceptance
// criteria. `idea` needs no migration — `targetType` is a bare String column
// covered by @@index([targetType, targetUuid]).
export const REFERENCE_TARGET_TYPES = ["proposal", "task", "idea"] as const;
export type ReferenceTargetType = (typeof REFERENCE_TARGET_TYPES)[number];

// ===== Type Definitions =====

export interface ReferenceListParams {
  companyUuid: string;
  targetType: string;
  targetUuid: string;
}

export interface ReferenceCreateParams {
  companyUuid: string;
  targetType: string;
  targetUuid: string;
  type: string;
  url: string;
  title: string;
  notes?: string | null;
  createdByType: "user" | "agent";
  createdByUuid: string;
}

export interface ReferenceUpdateParams {
  type?: string;
  url?: string;
  title?: string;
  notes?: string | null;
}

// A single inline reference item as accepted by the batch helper (the shape the
// MCP create tools pass through). `createdBy` is supplied once at the batch
// level, so an item carries only the reference payload.
export interface ReferenceCreateItem {
  type: string;
  url: string;
  title: string;
  notes?: string | null;
}

// Who authored an inline batch of references (resolved once by the caller).
export interface ReferenceCreatedBy {
  type: "user" | "agent";
  uuid: string;
}

// Per-item failure surfaced by the fail-soft batch helper.
export interface ReferenceCreateError {
  index: number;
  url?: string;
  title?: string;
  error: string;
}

// Outcome of a fail-soft batch: the created DTOs plus any per-item errors.
export interface CreateReferencesResult {
  created: ReferenceArtifactResponse[];
  errors: ReferenceCreateError[];
}

// API response format — UUID-only, never leaks the serial `id`.
export interface ReferenceArtifactResponse {
  uuid: string;
  targetType: string;
  targetUuid: string;
  type: string;
  url: string;
  title: string;
  notes: string | null;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// Shared column projection so every read returns the same UUID-only shape (never
// selects `id`, so the serial can never leak into a DTO).
const REFERENCE_SELECT = {
  uuid: true,
  targetType: true,
  targetUuid: true,
  type: true,
  url: true,
  title: true,
  notes: true,
  createdByType: true,
  createdByUuid: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RawReference = {
  uuid: string;
  targetType: string;
  targetUuid: string;
  type: string;
  url: string;
  title: string;
  notes: string | null;
  createdByType: string;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
};

// ===== Internal Helper Functions =====

// Format a single ReferenceArtifact row into API response format, resolving the
// creator display name. `notes` is passed through verbatim (q5) — the DTO never
// fetches the URL.
async function formatReferenceResponse(
  row: RawReference
): Promise<ReferenceArtifactResponse> {
  const createdBy = await formatCreatedBy(
    row.createdByUuid,
    row.createdByType === "user" || row.createdByType === "agent"
      ? row.createdByType
      : undefined
  );

  return {
    uuid: row.uuid,
    targetType: row.targetType,
    targetUuid: row.targetUuid,
    type: row.type,
    url: row.url,
    title: row.title,
    notes: row.notes ?? null,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Validate the reference `type` is one of the four supported web-link types.
function assertValidType(type: string): void {
  if (!(REFERENCE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid reference type: ${type}`);
  }
}

// Validate the `url` is a non-blank web URL beginning with http:// or https://.
// Rejects file:// and blank/whitespace-only strings (q4: web-links only).
function assertValidUrl(url: string): void {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid reference url: ${url}`);
  }
}

// Resolve + validate that an idea/proposal/task target exists in the company,
// returning its projectUuid for SSE fan-out. Mirrors the target-resolution
// switch in comment.service.resolveProjectUuid, but scoped to the supported
// target types. Throws "… not found" when the targetType is unsupported or the
// target does not resolve within the company.
async function resolveTargetProjectUuid(
  companyUuid: string,
  targetType: string,
  targetUuid: string
): Promise<string> {
  switch (targetType) {
    case "proposal": {
      const proposal = await prisma.proposal.findFirst({
        where: { uuid: targetUuid, companyUuid },
        select: { projectUuid: true },
      });
      if (!proposal) {
        throw new Error(`Target proposal with UUID ${targetUuid} not found`);
      }
      return proposal.projectUuid;
    }
    case "task": {
      const task = await prisma.task.findFirst({
        where: { uuid: targetUuid, companyUuid },
        select: { projectUuid: true },
      });
      if (!task) {
        throw new Error(`Target task with UUID ${targetUuid} not found`);
      }
      return task.projectUuid;
    }
    case "idea": {
      const idea = await prisma.idea.findFirst({
        where: { uuid: targetUuid, companyUuid },
        select: { projectUuid: true },
      });
      if (!idea) {
        throw new Error(`Target idea with UUID ${targetUuid} not found`);
      }
      return idea.projectUuid;
    }
    default:
      throw new Error(`Unsupported reference targetType: ${targetType}`);
  }
}

// ===== Service Methods =====

// List reference artifacts for a target, oldest-first. Company-scoped.
export async function listReferences({
  companyUuid,
  targetType,
  targetUuid,
}: ReferenceListParams): Promise<ReferenceArtifactResponse[]> {
  const rows = await prisma.referenceArtifact.findMany({
    where: { companyUuid, targetType, targetUuid },
    orderBy: { createdAt: "asc" },
    select: REFERENCE_SELECT,
  });

  return Promise.all(rows.map((row) => formatReferenceResponse(row)));
}

// Create a reference artifact. Validates type + url, then resolves/validates the
// target exists in the same company (throws "… not found" otherwise). Best-effort
// activity + SSE side effects (swallowed + logged). Stores `notes` verbatim and
// performs NO network fetch of the url.
export async function createReference(
  params: ReferenceCreateParams
): Promise<ReferenceArtifactResponse> {
  const { companyUuid, targetType, targetUuid, type, url, title, notes } = params;

  assertValidType(type);
  assertValidUrl(url);

  // Resolve + validate the target exists within the company. Throws "… not found"
  // (or "Unsupported … targetType") which routes translate to 404 / 400.
  const projectUuid = await resolveTargetProjectUuid(
    companyUuid,
    targetType,
    targetUuid
  );

  const row = await prisma.referenceArtifact.create({
    data: {
      companyUuid,
      targetType,
      targetUuid,
      type,
      url,
      title,
      notes: notes ?? null,
      createdByType: params.createdByType,
      createdByUuid: params.createdByUuid,
    },
    select: REFERENCE_SELECT,
  });

  // Best-effort side effects — the insert above is the source of truth, so any
  // failure here is logged and swallowed (same failure semantics as
  // document.service report side effects).
  try {
    eventBus.emitChange({
      companyUuid,
      projectUuid,
      entityType: targetType as RealtimeEvent["entityType"],
      entityUuid: targetUuid,
      action: "updated",
      actorUuid: params.createdByUuid,
    });
  } catch (err) {
    refLogger.warn(
      { err, referenceUuid: row.uuid, targetType, targetUuid },
      "Failed to emit change event for reference artifact"
    );
  }

  try {
    await activityService.createActivity({
      companyUuid,
      projectUuid,
      targetType: targetType as activityService.TargetType,
      targetUuid,
      actorType: params.createdByType,
      actorUuid: params.createdByUuid,
      action: "reference_added",
      value: {
        referenceUuid: row.uuid,
        type: row.type,
        url: row.url,
        title: row.title,
      },
    });
  } catch (err) {
    refLogger.warn(
      { err, referenceUuid: row.uuid, targetType, targetUuid },
      "Failed to record reference_added Activity"
    );
  }

  return formatReferenceResponse(row);
}

// Batch-create references inline at entity creation (Thread C). Called by the
// MCP create tools AFTER the host entity row exists so `targetUuid` is the real
// DB-generated uuid. FAIL-SOFT per item: each item is created independently and
// a bad one (invalid url/type, unresolved target, DB error) is caught, recorded
// in `errors`, and does NOT abort the rest — so one bad URL never loses the
// whole idea/proposal/task creation (V2 Tech Design "Partial inline-create
// failure"). Returns { created, errors }; a null/empty `items` yields both
// empty. Never throws for a bad item.
export async function createReferences(
  companyUuid: string,
  targetType: string,
  targetUuid: string,
  items: ReferenceCreateItem[] | null | undefined,
  createdBy: ReferenceCreatedBy
): Promise<CreateReferencesResult> {
  const created: ReferenceArtifactResponse[] = [];
  const errors: ReferenceCreateError[] = [];

  const list = items ?? [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    try {
      const reference = await createReference({
        companyUuid,
        targetType,
        targetUuid,
        type: it.type,
        url: it.url,
        title: it.title,
        notes: it.notes ?? null,
        createdByType: createdBy.type,
        createdByUuid: createdBy.uuid,
      });
      created.push(reference);
    } catch (err) {
      errors.push({
        index: i,
        url: it?.url,
        title: it?.title,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { created, errors };
}

// Get a single reference artifact, company-scoped. Returns null when absent or
// cross-tenant.
export async function getReference(
  companyUuid: string,
  uuid: string
): Promise<ReferenceArtifactResponse | null> {
  const row = await prisma.referenceArtifact.findFirst({
    where: { uuid, companyUuid },
    select: REFERENCE_SELECT,
  });

  if (!row) return null;
  return formatReferenceResponse(row);
}

// Update a reference artifact (partial). Re-validates type/url when present.
// Throws "… not found" when the uuid is absent or cross-tenant.
export async function updateReference(
  companyUuid: string,
  uuid: string,
  { type, url, title, notes }: ReferenceUpdateParams
): Promise<ReferenceArtifactResponse> {
  if (type !== undefined) assertValidType(type);
  if (url !== undefined) assertValidUrl(url);

  // Tenant-scoped existence check — `update` alone matches only by unique uuid,
  // so this guards cross-tenant writes and yields the "… not found" contract.
  const existing = await prisma.referenceArtifact.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true },
  });
  if (!existing) {
    throw new Error(`Reference with UUID ${uuid} not found`);
  }

  const data: {
    type?: string;
    url?: string;
    title?: string;
    notes?: string | null;
  } = {};
  if (type !== undefined) data.type = type;
  if (url !== undefined) data.url = url;
  if (title !== undefined) data.title = title;
  if (notes !== undefined) data.notes = notes;

  const row = await prisma.referenceArtifact.update({
    where: { uuid },
    data,
    select: REFERENCE_SELECT,
  });

  return formatReferenceResponse(row);
}

// Delete a reference artifact, company-scoped. Throws "… not found" when the
// uuid is absent or cross-tenant.
export async function deleteReference(
  companyUuid: string,
  uuid: string
): Promise<void> {
  const existing = await prisma.referenceArtifact.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true },
  });
  if (!existing) {
    throw new Error(`Reference with UUID ${uuid} not found`);
  }

  await prisma.referenceArtifact.delete({ where: { uuid } });
}
