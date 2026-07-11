"use server";

// Server Actions for Reference Artifacts (external evidence linked to a
// proposal/task). Mirrors comment-actions.ts / documents/actions.ts: these
// call the service directly (not the REST layer) after resolving human auth
// via getServerAuthContext. Agents have dedicated MCP tools
// (chorus_add_reference / chorus_update_reference / chorus_remove_reference)
// for the same operations, so these actions only handle dashboard (user) auth.

import { getServerAuthContext } from "@/lib/auth-server";
import {
  listReferences,
  createReference,
  updateReference,
  deleteReference,
  REFERENCE_TARGET_TYPES,
  type ReferenceArtifactResponse,
} from "@/services/reference-artifact.service";
import logger from "@/lib/logger";

const validTargetTypes = REFERENCE_TARGET_TYPES as readonly string[];

type ListResult =
  | { success: true; references: ReferenceArtifactResponse[] }
  | { success: false; error: string };

type MutationResult =
  | { success: true; reference: ReferenceArtifactResponse }
  | { success: false; error: string };

type DeleteResult = { success: true } | { success: false; error: string };

// List references for a proposal/task target (oldest-first, company-scoped).
export async function listReferencesAction(
  targetType: string,
  targetUuid: string,
): Promise<ListResult> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "unauthorized" };
  }
  if (!validTargetTypes.includes(targetType)) {
    return { success: false, error: `Invalid target type: ${targetType}` };
  }

  try {
    const references = await listReferences({
      companyUuid: auth.companyUuid,
      targetType,
      targetUuid,
    });
    return { success: true, references };
  } catch (error) {
    logger.error({ err: error, targetType, targetUuid }, "Failed to list references");
    return { success: false, error: "Failed to load references" };
  }
}

// Create a reference artifact attached to a proposal/task.
export async function createReferenceAction(input: {
  targetType: string;
  targetUuid: string;
  type: string;
  url: string;
  title: string;
  notes?: string | null;
}): Promise<MutationResult> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "unauthorized" };
  }
  if (!validTargetTypes.includes(input.targetType)) {
    return { success: false, error: `Invalid target type: ${input.targetType}` };
  }

  try {
    const reference = await createReference({
      companyUuid: auth.companyUuid,
      targetType: input.targetType,
      targetUuid: input.targetUuid,
      type: input.type,
      url: input.url,
      title: input.title,
      notes: input.notes ?? null,
      createdByType: "user",
      createdByUuid: auth.actorUuid,
    });
    return { success: true, reference };
  } catch (error) {
    logger.error({ err: error }, "Failed to create reference");
    const message = error instanceof Error ? error.message : "Failed to add reference";
    return { success: false, error: message };
  }
}

// Update a reference artifact (partial: type/url/title/notes).
export async function updateReferenceAction(input: {
  uuid: string;
  type?: string;
  url?: string;
  title?: string;
  notes?: string | null;
}): Promise<MutationResult> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "unauthorized" };
  }

  try {
    const reference = await updateReference(auth.companyUuid, input.uuid, {
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    return { success: true, reference };
  } catch (error) {
    logger.error({ err: error, uuid: input.uuid }, "Failed to update reference");
    const message = error instanceof Error ? error.message : "Failed to update reference";
    return { success: false, error: message };
  }
}

// Delete a reference artifact by UUID (company-scoped).
export async function deleteReferenceAction(uuid: string): Promise<DeleteResult> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "unauthorized" };
  }

  try {
    await deleteReference(auth.companyUuid, uuid);
    return { success: true };
  } catch (error) {
    logger.error({ err: error, uuid }, "Failed to delete reference");
    const message = error instanceof Error ? error.message : "Failed to delete reference";
    return { success: false, error: message };
  }
}
