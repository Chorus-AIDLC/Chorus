"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  approveProposal,
  rejectProposal,
  closeProposal,
  submitProposal,
  getProposalByUuid,
  addDocumentDraft,
  addTaskDraft,
  updateDocumentDraft,
  updateTaskDraft,
  removeDocumentDraft,
  removeTaskDraft,
} from "@/services/proposal.service";
import { createActivity } from "@/services/activity.service";

export async function approveProposalAction(proposalUuid: string, reviewNote?: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate proposal exists and belongs to this company
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    // Only pending proposals can be approved
    if (proposal.status !== "pending") {
      return { success: false, error: "Proposal is not pending review" };
    }

    await approveProposal(proposalUuid, auth.companyUuid, auth.actorUuid, reviewNote || null);

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: proposal.projectUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "approved",
      value: reviewNote ? { reviewNote } : undefined,
    });

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);
    revalidatePath(`/projects/${proposal.projectUuid}/proposals`);

    return { success: true };
  } catch (error) {
    console.error("Failed to approve proposal:", error);
    return { success: false, error: "Failed to approve proposal" };
  }
}

export async function submitProposalAction(proposalUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate proposal exists and belongs to this company
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    // Only draft proposals can be submitted for review
    if (proposal.status !== "draft") {
      return { success: false, error: "Proposal is not in draft status" };
    }

    await submitProposal(proposalUuid, auth.companyUuid);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);
    revalidatePath(`/projects/${proposal.projectUuid}/proposals`);

    return { success: true };
  } catch (error) {
    console.error("Failed to submit proposal:", error);
    return { success: false, error: "Failed to submit proposal" };
  }
}

export async function rejectProposalAction(proposalUuid: string, reviewNote?: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate proposal exists and belongs to this company
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    // Only pending proposals can be rejected
    if (proposal.status !== "pending") {
      return { success: false, error: "Proposal is not pending review" };
    }

    await rejectProposal(proposalUuid, auth.actorUuid, reviewNote || "");

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: proposal.projectUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "rejected_to_draft",
      value: reviewNote ? { reviewNote } : undefined,
    });

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);
    revalidatePath(`/projects/${proposal.projectUuid}/proposals`);

    return { success: true };
  } catch (error) {
    console.error("Failed to reject proposal:", error);
    return { success: false, error: "Failed to reject proposal" };
  }
}

export async function closeProposalAction(proposalUuid: string, reviewNote: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    if (proposal.status !== "pending") {
      return { success: false, error: "Proposal is not pending review" };
    }

    await closeProposal(proposalUuid, auth.actorUuid, reviewNote);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);
    revalidatePath(`/projects/${proposal.projectUuid}/proposals`);

    return { success: true };
  } catch (error) {
    console.error("Failed to close proposal:", error);
    return { success: false, error: "Failed to close proposal" };
  }
}

// ===== Draft Management Actions =====

// Add document draft
export async function addDocumentDraftAction(
  proposalUuid: string,
  draft: { type: string; title: string; content: string }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await addDocumentDraft(proposalUuid, auth.companyUuid, draft);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to add document draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to add document draft" };
  }
}

// Add task draft
export async function addTaskDraftAction(
  proposalUuid: string,
  draft: {
    title: string;
    description?: string;
    storyPoints?: number;
    priority?: string;
    acceptanceCriteria?: string;
    acceptanceCriteriaItems?: Array<{ description: string; required?: boolean }>;
    dependsOnDraftUuids?: string[];
  }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await addTaskDraft(proposalUuid, auth.companyUuid, draft);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to add task draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to add task draft" };
  }
}

// Update document draft
export async function updateDocumentDraftAction(
  proposalUuid: string,
  draftUuid: string,
  updates: { type?: string; title?: string; content?: string }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await updateDocumentDraft(proposalUuid, auth.companyUuid, draftUuid, updates);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to update document draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to update document draft" };
  }
}

// Update task draft
export async function updateTaskDraftAction(
  proposalUuid: string,
  draftUuid: string,
  updates: {
    title?: string;
    description?: string;
    storyPoints?: number;
    priority?: string;
    acceptanceCriteria?: string;
    acceptanceCriteriaItems?: Array<{ description: string; required?: boolean }>;
    dependsOnDraftUuids?: string[];
  }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await updateTaskDraft(proposalUuid, auth.companyUuid, draftUuid, updates);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to update task draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to update task draft" };
  }
}

// Remove document draft
export async function removeDocumentDraftAction(proposalUuid: string, draftUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await removeDocumentDraft(proposalUuid, auth.companyUuid, draftUuid);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to remove document draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to remove document draft" };
  }
}

// Remove task draft
export async function removeTaskDraftAction(proposalUuid: string, draftUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return { success: false, error: "Proposal not found" };
    }

    const updated = await removeTaskDraft(proposalUuid, auth.companyUuid, draftUuid);

    revalidatePath(`/projects/${proposal.projectUuid}/proposals/${proposalUuid}`);

    return { success: true, proposal: updated };
  } catch (error) {
    console.error("Failed to remove task draft:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to remove task draft" };
  }
}
