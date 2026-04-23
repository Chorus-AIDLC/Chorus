// src/services/checkin.service.ts
// Checkin service — builds the agent checkin response with ideaTracker + notifications.
// Uses an agent-centric batch (3 queries + project-name lookup) to avoid per-project N+1.

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import { computeDerivedStatus } from "@/services/idea.service";
import type { DerivedIdeaStatus } from "@/services/idea.service";
import * as notificationService from "@/services/notification.service";

// ===== Response shape =====

export interface CheckinAgentInfo {
  uuid: string;
  name: string;
  roles: string[];
  persona: string | null;
  systemPrompt: string | null;
  owner: { uuid: string; name: string | null; email: string | null } | null;
}

export interface CheckinIdea {
  uuid: string;
  title: string;
  status: DerivedIdeaStatus;
  proposals: number;
  tasks: number;
}

export interface CheckinProject {
  name: string;
  ideas: CheckinIdea[];
}

export interface CheckinNotification {
  uuid: string;
  action: string;
  entity: string;
  title: string;
  actor: string;
  at: string;
}

export interface CheckinResponse {
  checkinTime: string;
  agent: CheckinAgentInfo;
  ideaTracker: Record<string, CheckinProject>;
  notifications: {
    unread: number;
    recent: CheckinNotification[];
  };
}

// ===== Service method =====

/**
 * Build the full checkin response for the current agent auth context.
 *
 * Side effects:
 *   - Updates agent.lastActiveAt
 *   - Emits first-checkin notification to owner (once per agent lifetime)
 *   - Marks the 5 returned recent notifications as read
 */
export async function buildCheckinResponse(auth: AuthContext): Promise<CheckinResponse> {
  // Update lastActiveAt + fetch agent info
  const agent = await prisma.agent.update({
    where: { uuid: auth.actorUuid },
    data: { lastActiveAt: new Date() },
    select: {
      uuid: true,
      name: true,
      roles: true,
      persona: true,
      systemPrompt: true,
      ownerUuid: true,
      owner: { select: { uuid: true, name: true, email: true } },
    },
  });

  // Build idea tracker and fetch notification summary in parallel
  const [ideaTracker, notifications] = await Promise.all([
    buildIdeaTracker(auth),
    buildNotificationSummary(auth),
  ]);

  if (agent.ownerUuid) {
    notificationService.emitAgentCheckin({
      agentUuid: agent.uuid,
      agentName: agent.name,
      ownerUuid: agent.ownerUuid,
    });
  }

  return {
    checkinTime: new Date().toISOString(),
    agent: {
      uuid: agent.uuid,
      name: agent.name,
      roles: agent.roles,
      persona: agent.persona,
      systemPrompt: agent.systemPrompt,
      owner: agent.owner
        ? { uuid: agent.owner.uuid, name: agent.owner.name, email: agent.owner.email }
        : null,
    },
    ideaTracker,
    notifications,
  };
}

// ===== Idea tracker (agent-centric 3-query batch) =====

async function buildIdeaTracker(auth: AuthContext): Promise<Record<string, CheckinProject>> {
  // Q1: Ideas assigned to the agent OR to the agent's owner.
  // Exclude legacy "closed" status (terminal) — elaborated/completed/etc. still flow to
  // ideaTracker so the agent sees downstream proposal/task work.
  const assigneeConditions: Array<{ assigneeType: string; assigneeUuid: string }> = [
    { assigneeType: "agent", assigneeUuid: auth.actorUuid },
  ];
  if (auth.ownerUuid) {
    assigneeConditions.push({ assigneeType: "user", assigneeUuid: auth.ownerUuid });
  }

  const rawIdeas = await prisma.idea.findMany({
    where: {
      companyUuid: auth.companyUuid,
      OR: assigneeConditions,
      status: { not: "closed" },
    },
    select: {
      uuid: true,
      title: true,
      status: true,
      elaborationStatus: true,
      projectUuid: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (rawIdeas.length === 0) return {};

  const ideaUuidSet = new Set(rawIdeas.map((i) => i.uuid));
  const projectUuidSet = new Set(rawIdeas.map((i) => i.projectUuid));
  const projectUuids = [...projectUuidSet];

  // Q2: Pending + approved proposals in those projects, filtered in-memory by inputUuids overlap.
  // Scoping by projectUuid keeps the fetch small; JSON overlap filtering in Prisma is awkward.
  const rawProposals = await prisma.proposal.findMany({
    where: {
      companyUuid: auth.companyUuid,
      projectUuid: { in: projectUuids },
      status: { in: ["pending", "approved"] },
      inputType: "idea",
    },
    select: {
      uuid: true,
      status: true,
      inputUuids: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Map ideaUuid → { proposalCount, latestApproved, hasPending }
  const ideaProposalCount = new Map<string, number>();
  const ideaHasPending = new Set<string>();
  const ideaLatestApproved = new Map<string, { uuid: string; createdAt: Date }>();

  for (const proposal of rawProposals) {
    const inputUuids = proposal.inputUuids as unknown;
    if (!Array.isArray(inputUuids)) continue;
    for (const ideaUuid of inputUuids) {
      if (typeof ideaUuid !== "string" || !ideaUuidSet.has(ideaUuid)) continue;
      ideaProposalCount.set(ideaUuid, (ideaProposalCount.get(ideaUuid) ?? 0) + 1);
      if (proposal.status === "pending") {
        ideaHasPending.add(ideaUuid);
      } else if (proposal.status === "approved") {
        const existing = ideaLatestApproved.get(ideaUuid);
        if (!existing || proposal.createdAt > existing.createdAt) {
          ideaLatestApproved.set(ideaUuid, { uuid: proposal.uuid, createdAt: proposal.createdAt });
        }
      }
    }
  }

  const approvedProposalUuids = [
    ...new Set([...ideaLatestApproved.values()].map((p) => p.uuid)),
  ];

  // Q3: Tasks on the approved proposals
  const proposalToTaskStatuses = new Map<string, string[]>();
  if (approvedProposalUuids.length > 0) {
    const tasks = await prisma.task.findMany({
      where: {
        companyUuid: auth.companyUuid,
        proposalUuid: { in: approvedProposalUuids },
      },
      select: { proposalUuid: true, status: true },
    });

    for (const task of tasks) {
      if (!task.proposalUuid) continue;
      const statuses = proposalToTaskStatuses.get(task.proposalUuid) ?? [];
      statuses.push(task.status);
      proposalToTaskStatuses.set(task.proposalUuid, statuses);
    }
  }

  // Q4: Project names (only for projects that have surviving ideas)
  const projects = await prisma.project.findMany({
    where: {
      companyUuid: auth.companyUuid,
      uuid: { in: projectUuids },
    },
    select: { uuid: true, name: true },
  });
  const projectNames = new Map(projects.map((p) => [p.uuid, p.name]));

  // Compute derivedStatus + group by project, filter out "done", cap at 10 ideas
  const MAX_IDEAS = 10;
  const tracker: Record<string, CheckinProject> = {};
  let count = 0;

  for (const idea of rawIdeas) {
    if (count >= MAX_IDEAS) break;

    const latestApproved = ideaLatestApproved.get(idea.uuid);
    const taskStatuses = latestApproved
      ? proposalToTaskStatuses.get(latestApproved.uuid) ?? []
      : [];

    const { derivedStatus } = computeDerivedStatus({
      ideaStatus: idea.status,
      elaborationStatus: idea.elaborationStatus,
      hasPendingProposal: ideaHasPending.has(idea.uuid),
      hasApprovedProposal: !!latestApproved,
      taskStatuses,
    });

    if (derivedStatus === "done") continue;

    const projectUuid = idea.projectUuid;
    if (!tracker[projectUuid]) {
      tracker[projectUuid] = {
        name: projectNames.get(projectUuid) ?? "",
        ideas: [],
      };
    }

    tracker[projectUuid].ideas.push({
      uuid: idea.uuid,
      title: idea.title,
      status: derivedStatus,
      proposals: ideaProposalCount.get(idea.uuid) ?? 0,
      tasks: taskStatuses.length,
    });
    count++;
  }

  return tracker;
}

// ===== Notification summary (fetch 5 unread, mark read) =====

async function buildNotificationSummary(auth: AuthContext): Promise<CheckinResponse["notifications"]> {
  const list = await notificationService.list({
    companyUuid: auth.companyUuid,
    recipientType: auth.type,
    recipientUuid: auth.actorUuid,
    readFilter: "unread",
    take: 5,
  });

  const recent: CheckinNotification[] = list.notifications.map((n) => ({
    uuid: n.uuid,
    action: n.action,
    entity: n.entityType,
    title: n.entityTitle,
    actor: n.actorName,
    at: n.createdAt,
  }));

  // Mark the fetched items as read. Errors (e.g. stale UUID) should not fail checkin.
  let markedCount = 0;
  if (recent.length > 0) {
    const results = await Promise.all(
      recent.map((n) =>
        notificationService
          .markRead(n.uuid, auth.companyUuid, auth.type, auth.actorUuid)
          .then(() => true)
          .catch(() => false),
      ),
    );
    markedCount = results.filter(Boolean).length;
  }

  return {
    unread: Math.max(0, list.unreadCount - markedCount),
    recent,
  };
}
