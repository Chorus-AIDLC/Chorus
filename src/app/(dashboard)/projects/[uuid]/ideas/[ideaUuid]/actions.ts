"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { assignIdea, releaseIdea, getIdeaByUuid } from "@/services/idea.service";
import { getAgentsByRole, getCompanyUsers } from "@/services/agent.service";
import { createActivity } from "@/services/activity.service";
import logger from "@/lib/logger";

export async function claimIdeaAction(ideaUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate idea exists and belongs to this company
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { success: false, error: "Idea not found" };
    }

    // Elaborated ideas cannot be reassigned (lifecycle is done)
    if (idea.status === "elaborated") {
      return { success: false, error: "Idea is not available for assignment" };
    }

    await assignIdea({
      ideaUuid,
      companyUuid: auth.companyUuid,
      assigneeType: auth.type,
      assigneeUuid: auth.actorUuid,
      assignedByUuid: auth.actorUuid,
    });

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: idea.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: { assigneeType: auth.type, assigneeUuid: auth.actorUuid },
    });

    revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
    revalidatePath(`/projects/${idea.projectUuid}/ideas`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to claim idea");
    return { success: false, error: "Failed to claim idea" };
  }
}

// Claim idea to a specific agent
export async function claimIdeaToAgentAction(ideaUuid: string, agentUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { success: false, error: "Idea not found" };
    }

    // Elaborated ideas cannot be reassigned (lifecycle is done)
    if (idea.status === "elaborated") {
      return { success: false, error: "Idea is not available for assignment" };
    }

    await assignIdea({
      ideaUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "agent",
      assigneeUuid: agentUuid,
      assignedByUuid: auth.actorUuid,
    });

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: idea.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType: "user",
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: { assigneeType: "agent", assigneeUuid: agentUuid },
    });

    revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
    revalidatePath(`/projects/${idea.projectUuid}/ideas`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to claim idea to agent");
    return { success: false, error: "Failed to claim idea" };
  }
}

// Claim idea to a specific user (all their PM agents can see it)
export async function claimIdeaToUserAction(ideaUuid: string, userUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { success: false, error: "Idea not found" };
    }

    // Elaborated ideas cannot be reassigned (lifecycle is done)
    if (idea.status === "elaborated") {
      return { success: false, error: "Idea is not available for assignment" };
    }

    await assignIdea({
      ideaUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "user",
      assigneeUuid: userUuid,
      assignedByUuid: auth.actorUuid,
    });

    revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
    revalidatePath(`/projects/${idea.projectUuid}/ideas`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to claim idea to user");
    return { success: false, error: "Failed to claim idea" };
  }
}

// Release idea (clear assignee, back to open)
export async function releaseIdeaAction(ideaUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { success: false, error: "Idea not found" };
    }

    // Elaborated ideas cannot be released (lifecycle is done)
    if (idea.status === "elaborated") {
      return { success: false, error: "Idea cannot be released from current status" };
    }

    await releaseIdea(idea.uuid);

    revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
    revalidatePath(`/projects/${idea.projectUuid}/ideas`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to release idea");
    return { success: false, error: "Failed to release idea" };
  }
}

// Get PM agents for assignment (Ideas can only be assigned to PM agents)
export async function getPmAgentsAction() {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { agents: [], users: [] };
  }

  try {
    const [agents, users] = await Promise.all([
      getAgentsByRole(auth.companyUuid, "pm", auth.actorUuid),
      getCompanyUsers(auth.companyUuid),
    ]);
    return { agents, users };
  } catch (error) {
    logger.error({ err: error }, "Failed to get PM agents");
    return { agents: [], users: [] };
  }
}
