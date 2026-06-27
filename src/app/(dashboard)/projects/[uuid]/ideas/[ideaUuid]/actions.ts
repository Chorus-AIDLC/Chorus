"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { assignIdea, releaseIdea, getIdeaByUuid } from "@/services/idea.service";
import { getAssignableAgents, getCompanyUsers } from "@/services/agent.service";
import { listConnectionsForAgent } from "@/services/daemon-connection.service";
import { createActivity } from "@/services/activity.service";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";
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

// Claim idea to a specific agent, optionally pinning a DURABLE AgentInstance (the
// (agent, host, cwd) place). The idea is the authoritative pin ROOT: when
// `instanceUuid` is given the row is persisted as
// assigneeType="agent_instance"/assigneeUuid=<that uuid> (validated company-scoped
// in assignIdea), and proposals/tasks/wakes for the same agent inherit it.
// Omitting it assigns the plain agent — which is also the path that REVERTS a
// prior instance pin back to the plain agent on re-assignment. The InstancePicker
// only offers ONLINE instances, so a pin is always to a reachable place.
export async function claimIdeaToAgentAction(
  ideaUuid: string,
  agentUuid: string,
  instanceUuid?: string | null,
) {
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
      instanceUuid: instanceUuid ?? undefined,
    });

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: idea.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType: "user",
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: {
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        ...(instanceUuid ? { instanceUuid } : {}),
      },
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

// Get assignable agents and users for the assign-idea modal.
// No role gating — any agent the caller owns is selectable. The agent's
// permission set still gates what it can actually do once assigned.
export async function getPmAgentsAction() {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { agents: [], users: [] };
  }

  try {
    const [agents, users] = await Promise.all([
      getAssignableAgents(auth.companyUuid, "idea:write", auth.actorUuid),
      getCompanyUsers(auth.companyUuid),
    ]);
    return { agents, users };
  } catch (error) {
    logger.error({ err: error }, "Failed to get assignable agents");
    return { agents: [], users: [] };
  }
}

// Get one agent's daemon instances so the assign-IDEA modal can pin which ONLINE
// (host, cwd) place roots the conversation. Mirrors the task-side action: returns
// online + offline candidates (each with effectiveStatus + the durable
// agentInstanceUuid); the modal filters to ONLINE before rendering the picker.
// Company-scoped; returns [] for any non-user caller or on error (the picker then
// shows its own "no instances" empty state — never a silent throw).
export async function getAgentInstancesAction(
  agentUuid: string,
): Promise<{ instances: InstanceCandidate[] }> {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { instances: [] };
  }

  try {
    const connections = await listConnectionsForAgent(auth.companyUuid, agentUuid);
    return {
      instances: connections.map((c) => ({
        connectionUuid: c.uuid,
        agentInstanceUuid: c.agentInstanceUuid,
        host: c.host,
        cwd: c.cwd,
        effectiveStatus: c.effectiveStatus,
      })),
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to get agent instances");
    return { instances: [] };
  }
}
