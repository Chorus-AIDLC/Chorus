"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { updateDocument, getDocumentByUuid } from "@/services/document.service";
import logger from "@/lib/logger";

export async function updateDocumentAction(
  documentUuid: string,
  projectUuid: string,
  content: string
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate document exists and belongs to this company
    const document = await getDocumentByUuid(auth.companyUuid, documentUuid);
    if (!document) {
      return { success: false, error: "Document not found" };
    }

    await updateDocument(documentUuid, { content });

    revalidatePath(`/projects/${projectUuid}/documents/${documentUuid}`);
    revalidatePath(`/projects/${projectUuid}/documents`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to update document");
    return { success: false, error: "Failed to update document" };
  }
}
