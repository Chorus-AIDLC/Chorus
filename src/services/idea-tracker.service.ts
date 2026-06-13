// src/services/idea-tracker.service.ts
// Single source of truth for "what work is on this agent's plate" — used by
// both chorus_checkin (capped) and chorus_get_my_assignments (full).
//
// Idea-tracker logic was originally inlined in checkin.service.ts; the assignment
// service had a parallel, divergent implementation. Both now go through here so
// the two surfaces cannot drift again (see Chorus 0.7.2 idea-tracker proposal).

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import { computeDerivedStatus, type DerivedIdeaStatus } from "@/services/idea.service";

// ===== Idea tracker types =====

export interface IdeaTrackerEntry {
  uuid: string;
  title: string;
  status: DerivedIdeaStatus;
  parentUuid: string | null;
  proposals: number;
  tasks: number;
}

export interface IdeaTrackerProject {
  name: string;
  ideas: IdeaTrackerEntry[];
}

export interface BuildIdeaTrackerOptions {
  /** Restrict to specific project UUIDs. Empty/undefined = all projects. */
  projectUuids?: string[];
  /** Cap total ideas returned across projects. Default: Number.POSITIVE_INFINITY. */
  maxIdeas?: number;
}

// ===== Task tracker types =====

export interface TaskAcceptanceProgress {
  passed: number;
  total: number;
}

export interface TaskTrackerEntry {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  assignedAt: string | null;
  ac: TaskAcceptanceProgress;
}

export interface TaskTrackerProject {
  name: string;
  tasks: TaskTrackerEntry[];
}

export interface BuildTaskTrackerOptions {
  projectUuids?: string[];
}

// ===== Internal helpers =====

// Assignee conditions for the current agent/user. For agents, also match the
// owner-as-assignee path so "owner claims for themselves" shows up under the
// agent's tracker too.
function getAssigneeConditions(
  auth: AuthContext,
): Array<{ assigneeType: string; assigneeUuid: string }> {
  const conditions: Array<{ assigneeType: string; assigneeUuid: string }> = [];
  if (auth.type === "agent") {
    conditions.push({ assigneeType: "agent", assigneeUuid: auth.actorUuid });
    if (auth.ownerUuid) {
      conditions.push({ assigneeType: "user", assigneeUuid: auth.ownerUuid });
    }
  } else {
    conditions.push({ assigneeType: "user", assigneeUuid: auth.actorUuid });
  }
  return conditions;
}

// ===== Idea tracker =====

/**
 * Build the agent's idea tracker — assigned-to-me ideas grouped by project,
 * each carrying derivedStatus + proposal/task counts.
 *
 * Filters: excludes status="closed" (terminal) and derivedStatus="done"
 * (rolled-up completion of the proposal/task chain).
 *
 * Ordering: ideas are visited in `updatedAt desc` so the cap, when applied,
 * keeps the most-recently-touched work.
 *
 * Query budget: 4 prisma calls (ideas → proposals → tasks → projects).
 */
export async function buildIdeaTracker(
  auth: AuthContext,
  options: BuildIdeaTrackerOptions = {},
): Promise<Record<string, IdeaTrackerProject>> {
  const maxIdeas = options.maxIdeas ?? Number.POSITIVE_INFINITY;
  const projectFilter =
    options.projectUuids && options.projectUuids.length > 0
      ? { projectUuid: { in: options.projectUuids } }
      : {};

  // Q1: Ideas assigned to the agent OR to the agent's owner.
  // Exclude legacy "closed" (terminal) — elaborated/completed/etc. still flow
  // through so the agent sees downstream proposal/task work.
  const rawIdeas = await prisma.idea.findMany({
    where: {
      companyUuid: auth.companyUuid,
      OR: getAssigneeConditions(auth),
      status: { not: "closed" },
      ...projectFilter,
    },
    select: {
      uuid: true,
      title: true,
      status: true,
      elaborationStatus: true,
      parentUuid: true,
      projectUuid: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (rawIdeas.length === 0) return {};

  const ideaUuidSet = new Set(rawIdeas.map((i) => i.uuid));
  const projectUuids = [...new Set(rawIdeas.map((i) => i.projectUuid))];

  // Q2: Pending + approved proposals in those projects, filtered in-memory by
  // inputUuids overlap. Scoping by projectUuid keeps the fetch small; JSON
  // overlap filtering in Prisma is awkward.
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

  // Q3: Tasks on the latest-approved proposals
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

  const tracker: Record<string, IdeaTrackerProject> = {};
  let count = 0;

  for (const idea of rawIdeas) {
    if (count >= maxIdeas) break;

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
      parentUuid: idea.parentUuid ?? null,
      proposals: ideaProposalCount.get(idea.uuid) ?? 0,
      tasks: taskStatuses.length,
    });
    count++;
  }

  return tracker;
}

// ===== Task tracker =====

/**
 * Build the agent's task tracker — assigned-to-me tasks grouped by project,
 * each carrying admin-verified acceptance-criteria progress.
 *
 * Filters: excludes status in ["done","closed"].
 *
 * Ordering: [priority desc, assignedAt desc] — preserves the original
 * getMyAssignments ordering so the BREAKING schema change does not also
 * reshuffle the user's mental order.
 *
 * `ac.passed` counts admin-verified passes (`AcceptanceCriterion.status`),
 * not dev self-checks. Tasks without acceptance items return {0,0}.
 */
export async function buildTaskTracker(
  auth: AuthContext,
  options: BuildTaskTrackerOptions = {},
): Promise<Record<string, TaskTrackerProject>> {
  const projectFilter =
    options.projectUuids && options.projectUuids.length > 0
      ? { projectUuid: { in: options.projectUuids } }
      : {};

  const rawTasks = await prisma.task.findMany({
    where: {
      companyUuid: auth.companyUuid,
      OR: getAssigneeConditions(auth),
      status: { notIn: ["done", "closed"] },
      ...projectFilter,
    },
    select: {
      uuid: true,
      title: true,
      status: true,
      priority: true,
      assignedAt: true,
      projectUuid: true,
      project: { select: { uuid: true, name: true } },
      acceptanceCriteriaItems: { select: { status: true } },
    },
    orderBy: [{ priority: "desc" }, { assignedAt: "desc" }],
  });

  if (rawTasks.length === 0) return {};

  const tracker: Record<string, TaskTrackerProject> = {};

  for (const task of rawTasks) {
    const items = task.acceptanceCriteriaItems ?? [];
    const passed = items.filter((i) => i.status === "passed").length;

    const projectUuid = task.projectUuid;
    if (!tracker[projectUuid]) {
      tracker[projectUuid] = {
        name: task.project?.name ?? "",
        tasks: [],
      };
    }

    tracker[projectUuid].tasks.push({
      uuid: task.uuid,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assignedAt: task.assignedAt?.toISOString() ?? null,
      ac: { passed, total: items.length },
    });
  }

  return tracker;
}
