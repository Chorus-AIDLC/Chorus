"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import {
  moveIdea,
  moveIdeaPreview,
  getIdeaWithDerivedStatus,
  getIdeaByUuid,
} from "@/services/idea.service";
import { getProposalsByIdeaUuid } from "@/services/proposal.service";
import { getTask, listTasks } from "@/services/task.service";
import { listProjects } from "@/services/project.service";
import { listProjectGroups } from "@/services/project-group.service";
import { getElaboration } from "@/services/elaboration.service";
import type { ElaborationResponse } from "@/types/elaboration";
import logger from "@/lib/logger";

export async function getIdeaAction(ideaUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const idea = await getIdeaWithDerivedStatus(auth.companyUuid, ideaUuid);
  if (!idea) {
    return { success: false as const, error: "Not found" };
  }

  return { success: true as const, data: idea };
}

export async function getTaskAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const task = await getTask(auth.companyUuid, taskUuid);
  if (!task) {
    return { success: false as const, error: "Not found" };
  }

  return { success: true as const, data: task };
}

export async function moveIdeaAction(ideaUuid: string, targetProjectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  try {
    const result = await moveIdea(
      auth.companyUuid,
      ideaUuid,
      targetProjectUuid,
      auth.actorUuid,
      auth.type,
    );
    // Surface the cascade counts so the dialog can render an accurate
    // success toast ("moved 2 proposals, 3 tasks, ...") rather than a
    // generic confirmation.
    return { success: true as const, moved: result.moved };
  } catch (e) {
    return { success: false as const, error: e instanceof Error ? e.message : "Failed to move idea" };
  }
}

// Preview the cascade for the move dialog — non-mutating count of what would
// migrate. Mirrors GET /api/ideas/[uuid]/move/preview but as a server action so
// the client doesn't have to deal with auth headers.
export async function moveIdeaPreviewAction(ideaUuid: string, targetProjectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  try {
    // Same-project guard mirrors REST so the dialog can't render counts
    // for a no-op move.
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { success: false as const, error: "Idea not found" };
    }
    if (idea.projectUuid === targetProjectUuid) {
      return { success: false as const, error: "Idea is already in the target project" };
    }

    const result = await moveIdeaPreview(auth.companyUuid, ideaUuid, targetProjectUuid);
    return { success: true as const, moved: result.moved };
  } catch (e) {
    logger.error({ err: e }, "Failed to preview idea move");
    return { success: false as const, error: e instanceof Error ? e.message : "Failed to preview move" };
  }
}

export async function getProposalsForIdeaAction(
  projectUuid: string,
  ideaUuid: string,
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const proposals = await getProposalsByIdeaUuid(
    auth.companyUuid,
    projectUuid,
    ideaUuid,
  );

  return { success: true as const, data: proposals };
}

export async function getTasksForProposalAction(
  projectUuid: string,
  proposalUuid: string,
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const { tasks } = await listTasks({
    companyUuid: auth.companyUuid,
    projectUuid,
    proposalUuids: [proposalUuid],
    skip: 0,
    take: 100,
  });

  return { success: true as const, data: tasks };
}

export async function getProjectsAndGroupsAction() {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const [{ projects }, { groups }] = await Promise.all([
    listProjects({ companyUuid: auth.companyUuid, skip: 0, take: 100 }),
    listProjectGroups(auth.companyUuid),
  ]);

  return { success: true as const, data: { projects, groups } };
}

export async function getElaborationAction(
  ideaUuid: string,
): Promise<{ success: true; data: ElaborationResponse } | { success: false; error: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  try {
    const data = await getElaboration({
      companyUuid: auth.companyUuid,
      ideaUuid,
    });
    return { success: true as const, data };
  } catch (error) {
    logger.error({ err: error }, "Failed to get elaboration");
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "Failed to get elaboration",
    };
  }
}
