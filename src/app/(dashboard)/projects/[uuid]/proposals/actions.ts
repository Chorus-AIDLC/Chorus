"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  listProposals,
  createProposal,
  checkIdeasAssignee,
  type DocumentDraftInput,
  type TaskDraftInput,
} from "@/services/proposal.service";
import { projectExists } from "@/services/project.service";

// Create Proposal
export async function createProposalAction(
  projectUuid: string,
  data: {
    title: string;
    description?: string;
    inputType: "idea" | "document";
    inputUuids: string[];
    documentDrafts?: DocumentDraftInput[];
    taskDrafts?: TaskDraftInput[];
  }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return { success: false, error: "Project not found" };
    }

    // Validate required fields
    if (!data.title || data.title.trim() === "") {
      return { success: false, error: "Title is required" };
    }
    if (!data.inputUuids || data.inputUuids.length === 0) {
      return { success: false, error: "Input sources are required" };
    }

    // If input type is idea, additional validation is needed
    if (data.inputType === "idea") {
      // Validate if user is the assignee of these Ideas
      const assigneeCheck = await checkIdeasAssignee(
        auth.companyUuid,
        data.inputUuids,
        auth.actorUuid,
        auth.type
      );
      if (!assigneeCheck.valid) {
        return {
          success: false,
          error: "You can only create proposals from ideas assigned to you",
        };
      }

      // Note: Ideas can be reused across multiple Proposals (no availability check blocking)
    }

    const proposal = await createProposal({
      companyUuid: auth.companyUuid,
      projectUuid,
      title: data.title.trim(),
      description: data.description?.trim() || null,
      inputType: data.inputType,
      inputUuids: data.inputUuids,
      documentDrafts: data.documentDrafts,
      taskDrafts: data.taskDrafts,
      createdByUuid: auth.actorUuid,
      createdByType: "user",
    });

    revalidatePath(`/projects/${projectUuid}/proposals`);

    return { success: true, proposal };
  } catch (error) {
    console.error("Failed to create proposal:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to create proposal" };
  }
}

/**
 * Fetch proposals for client-side refetch (SSE-driven updates).
 */
export async function fetchProposalsAction(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  try {
    const { proposals } = await listProposals({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 1000,
    });
    return { success: true as const, data: proposals };
  } catch (error) {
    console.error("Failed to fetch proposals:", error);
    return { success: false as const, error: "Failed to fetch proposals" };
  }
}
