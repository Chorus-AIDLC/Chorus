"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  createDocument,
  deleteDocument,
  getDocumentByUuidUnscoped,
} from "@/services/document.service";
import { createActivity } from "@/services/activity.service";
import { projectExists } from "@/services/project.service";
import logger from "@/lib/logger";

export async function createDocumentAction(input: {
  projectUuid: string;
  title: string;
  type: string;
  content: string;
}) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    if (!(await projectExists(auth.companyUuid, input.projectUuid))) {
      return { success: false, error: "Project not found" };
    }

    const doc = await createDocument({
      companyUuid: auth.companyUuid,
      projectUuid: input.projectUuid,
      type: input.type,
      title: input.title,
      content: input.content,
      createdByUuid: auth.actorUuid,
    });

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: input.projectUuid,
      targetType: "document",
      targetUuid: doc.uuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "document_created",
    });

    revalidatePath(`/projects/${input.projectUuid}/documents`);
    return { success: true, documentUuid: doc.uuid };
  } catch (error) {
    logger.error({ err: error }, "Failed to create document");
    return { success: false, error: "Failed to create document" };
  }
}

type DeleteDocumentResult =
  | { success: true; projectUuid: string }
  | { success: false; error: string };

// Delete a Document from the dashboard. Agents have a dedicated MCP tool
// (`chorus_admin_delete_document`) for the same operation, so this Server
// Action only needs to handle dashboard auth (human user / super-admin).
export async function deleteDocumentAction(
  documentUuid: string,
): Promise<DeleteDocumentResult> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "unauthorized" };
  }

  try {
    const document = await getDocumentByUuidUnscoped(documentUuid);
    if (!document) {
      return { success: false, error: "not_found" };
    }
    if (document.companyUuid !== auth.companyUuid) {
      return { success: false, error: "forbidden" };
    }

    await deleteDocument(document.uuid);
    revalidatePath(`/projects/${document.projectUuid}/documents`);
    return { success: true, projectUuid: document.projectUuid };
  } catch (error) {
    logger.error({ err: error, documentUuid }, "Failed to delete document");
    const message = error instanceof Error ? error.message : "Failed to delete document";
    return { success: false, error: message };
  }
}
