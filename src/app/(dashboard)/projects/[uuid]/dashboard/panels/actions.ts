"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { getIdea, moveIdea, computeDerivedStatus } from "@/services/idea.service";
import { getProposalsByIdeaUuid } from "@/services/proposal.service";
import { getTask, listTasks } from "@/services/task.service";
import { prisma } from "@/lib/prisma";
import { listProjects } from "@/services/project.service";
import { listProjectGroups } from "@/services/project-group.service";

export async function getIdeaAction(ideaUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false as const, error: "Unauthorized" };
  }

  const idea = await getIdea(auth.companyUuid, ideaUuid);
  if (!idea) {
    return { success: false as const, error: "Not found" };
  }

  // Compute derived status with full context (proposal + task states)
  const proposals = await prisma.proposal.findMany({
    where: { projectUuid: idea.project?.uuid, companyUuid: auth.companyUuid, inputUuids: { array_contains: [ideaUuid] } },
    select: { status: true, uuid: true },
  });
  const approvedProposal = proposals.find((p) => p.status === "approved");
  let taskStatuses: string[] = [];
  if (approvedProposal) {
    const tasks = await prisma.task.findMany({
      where: { proposalUuid: approvedProposal.uuid, companyUuid: auth.companyUuid },
      select: { status: true },
    });
    taskStatuses = tasks.map((t) => t.status);
  }

  const { derivedStatus, badgeHint } = computeDerivedStatus({
    ideaStatus: idea.status,
    elaborationStatus: idea.elaborationStatus,
    hasPendingProposal: proposals.some((p) => p.status === "pending"),
    hasApprovedProposal: !!approvedProposal,
    taskStatuses,
  });

  return { success: true as const, data: { ...idea, derivedStatus, badgeHint } };
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
    await moveIdea(auth.companyUuid, ideaUuid, targetProjectUuid, auth.actorUuid, auth.type);
    return { success: true as const };
  } catch (e) {
    return { success: false as const, error: e instanceof Error ? e.message : "Failed to move idea" };
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
