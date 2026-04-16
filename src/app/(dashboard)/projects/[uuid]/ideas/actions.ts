"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { listIdeas, createIdea, updateIdea, deleteIdea } from "@/services/idea.service";
import { checkIdeasAvailability } from "@/services/proposal.service";
import { batchCommentCounts } from "@/services/comment.service";
import logger from "@/lib/logger";

interface Attachment {
  type: string;
  name: string;
  url: string;
  content?: string; // For text-based files like .md
}

interface CreateIdeaInput {
  projectUuid: string;
  title: string;
  content?: string;
  attachments?: Attachment[];
}

export async function createIdeaAction(input: CreateIdeaInput) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const idea = await createIdea({
      companyUuid: auth.companyUuid,
      projectUuid: input.projectUuid,
      title: input.title,
      content: input.content || null,
      attachments: input.attachments || null,
      createdByUuid: auth.actorUuid,
    });

    revalidatePath(`/projects/${input.projectUuid}/ideas`);
    return { success: true, ideaUuid: idea.uuid };
  } catch (error) {
    logger.error({ err: error }, "Failed to create idea");
    return { success: false, error: "Failed to create idea" };
  }
}

interface UpdateIdeaInput {
  ideaUuid: string;
  projectUuid: string;
  title: string;
  content: string | null;
}

export async function updateIdeaAction(input: UpdateIdeaInput) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const idea = await updateIdea(input.ideaUuid, auth.companyUuid, {
      title: input.title,
      content: input.content,
    });

    revalidatePath(`/projects/${input.projectUuid}/ideas`);
    return { success: true, idea };
  } catch (error) {
    logger.error({ err: error }, "Failed to update idea");
    return { success: false, error: "Failed to update idea" };
  }
}

export async function deleteIdeaAction(ideaUuid: string, projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    await deleteIdea(ideaUuid);
    revalidatePath(`/projects/${projectUuid}/ideas`);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to delete idea");
    return { success: false, error: "Failed to delete idea" };
  }
}

/**
 * Fetch enriched ideas data for client-side refetch (SSE-driven updates).
 * Mirrors the data enrichment in ideas-page-content.tsx server component.
 */
export async function fetchIdeasAction(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  try {
    const { ideas: allIdeas } = await listIdeas({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 1000,
    });

    const allIdeaUuids = allIdeas.map((idea) => idea.uuid);

    const [availabilityCheck, commentCounts] = await Promise.all([
      allIdeaUuids.length > 0
        ? checkIdeasAvailability(auth.companyUuid, allIdeaUuids)
        : Promise.resolve({ usedIdeas: [] as { uuid: string; proposalUuid: string }[] }),
      allIdeaUuids.length > 0
        ? batchCommentCounts(auth.companyUuid, "idea", allIdeaUuids)
        : Promise.resolve({} as Record<string, number>),
    ]);

    const usedIdeaUuids = availabilityCheck.usedIdeas.map((u) => u.uuid);
    const ideaProposalMap: Record<string, string> = {};
    for (const u of availabilityCheck.usedIdeas) {
      ideaProposalMap[u.uuid] = u.proposalUuid;
    }

    const ideas = allIdeas.map((idea) => ({
      ...idea,
      commentCount: commentCounts[idea.uuid] || 0,
    }));

    return { success: true as const, data: { ideas, usedIdeaUuids, ideaProposalMap } };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch ideas");
    return { success: false as const, error: "Failed to fetch ideas" };
  }
}
