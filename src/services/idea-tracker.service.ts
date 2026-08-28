// src/services/idea-tracker.service.ts
// Single source of truth for "what work is on this agent's plate" — used by
// both chorus_checkin (capped) and chorus_get_my_assignments (full).
//
// Idea-tracker logic was originally inlined in checkin.service.ts; the assignment
// service had a parallel, divergent implementation. Both now go through here so
// the two surfaces cannot drift again (see Chorus 0.7.2 idea-tracker proposal).

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import { buildAssigneeMatch } from "@/lib/uuid-resolver";
import {
  computeDerivedStatus,
  getIdeasWithDerivedStatus,
  type DerivedIdeaStatus,
} from "@/services/idea.service";

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

// ===== Idea tracker =====

/**
 * Build the agent's idea tracker — assigned-to-me ideas grouped by project,
 * each carrying derivedStatus + proposal/task counts.
 *
 * Filters: excludes status="closed" (terminal) and derivedStatus="done"
 * (rolled-up completion of the proposal/task chain). A container (theme) idea's
 * derivedStatus is rolled up from its children — so a theme whose children are
 * all done is dropped like any other completed idea, rather than lingering
 * forever (containers have no proposal/task chain of their own).
 *
 * Ordering: ideas are visited in `updatedAt desc` so the cap, when applied,
 * keeps the most-recently-touched work.
 *
 * Query budget: 4 prisma calls (ideas → proposals → tasks → projects), plus —
 * ONLY when the agent has a container idea on their plate — one
 * getIdeasWithDerivedStatus (itself ~3-4 queries over the whole project) per
 * distinct project that holds a container. This container rollup runs before the
 * maxIdeas cap, so it is bounded by the agent's container-bearing projects, not
 * by the cap. Skipped entirely when there are no containers.
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

  // Q1: Ideas assigned to the agent OR to the agent's owner. The assignee match
  // routes through buildAssigneeMatch so an `agent_instance` assignment (whose
  // assigneeUuid is an instance uuid, not the agent uuid) is also matched —
  // otherwise instance-pinned ideas would be silently dropped from the tracker.
  const assigneeMatch = await buildAssigneeMatch(auth);
  // Exclude legacy "closed" (terminal) — elaborated/completed/etc. still flow
  // through so the agent sees downstream proposal/task work.
  const rawIdeas = await prisma.idea.findMany({
    where: {
      companyUuid: auth.companyUuid,
      OR: assigneeMatch,
      status: { not: "closed" },
      ...projectFilter,
    },
    select: {
      uuid: true,
      title: true,
      status: true,
      elaborationStatus: true,
      parentUuid: true,
      isContainer: true,
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

  // Q5 (containers only): a theme (container) idea has no proposal/task chain of
  // its own, so computeDerivedStatus would stall it at "in_progress" forever —
  // even when every child is done. Its real status must roll up from its
  // children, which may be assigned to other actors and thus absent from the
  // assignee-matched set above. Resolve the rolled-up status from the same
  // project-wide board builder the UI uses, so this surface can't drift from it.
  // Only fires when the agent actually has a container on their plate.
  const containerProjectUuids = [
    ...new Set(rawIdeas.filter((i) => i.isContainer).map((i) => i.projectUuid)),
  ];
  const containerDerivedStatus = new Map<string, DerivedIdeaStatus>();
  if (containerProjectUuids.length > 0) {
    const rolled = await Promise.all(
      containerProjectUuids.map((projectUuid) =>
        getIdeasWithDerivedStatus(auth.companyUuid, projectUuid),
      ),
    );
    for (const item of rolled.flat()) {
      if (item.isContainer) containerDerivedStatus.set(item.uuid, item.derivedStatus);
    }
  }

  const tracker: Record<string, IdeaTrackerProject> = {};
  let count = 0;

  for (const idea of rawIdeas) {
    if (count >= maxIdeas) break;

    const latestApproved = ideaLatestApproved.get(idea.uuid);
    const taskStatuses = latestApproved
      ? proposalToTaskStatuses.get(latestApproved.uuid) ?? []
      : [];

    const own = computeDerivedStatus({
      ideaStatus: idea.status,
      elaborationStatus: idea.elaborationStatus,
      hasPendingProposal: ideaHasPending.has(idea.uuid),
      hasApprovedProposal: !!latestApproved,
      taskStatuses,
    });

    // A container idea takes its children's rolled-up status; everything else
    // uses the status derived from its own proposal/task chain. The board query
    // is company+project scoped with no status/assignee filter, so any container
    // in rawIdeas is guaranteed to reappear in its project's board result (a
    // childless theme included — it just carries its own base status there).
    // The `?? own` fallback is therefore belt-and-suspenders for the impossible
    // case where the two queries disagree on company/project.
    const derivedStatus = idea.isContainer
      ? containerDerivedStatus.get(idea.uuid) ?? own.derivedStatus
      : own.derivedStatus;

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

// ===== Active-project distribution (checkin / session-start) =====

export interface ActiveProjectDistributionEntry {
  name: string;
  /** Count of the agent's active ideas in this project (always >= 1). */
  activeIdeaCount: number;
}

/**
 * Max projects surfaced in the checkin overview. This is an *overview* injected
 * into every session's context, not the full list — so it is bounded to avoid
 * polluting the agent's context. Excess projects (beyond the cap) and
 * duplicate-named projects are dropped; use chorus_get_my_assignments for the
 * complete set.
 */
const MAX_ACTIVE_PROJECTS = 10;

/**
 * Collapse the agent's idea tracker into a per-project active-idea *count* —
 * "which projects am I advancing ideas in, and how many" — with no per-idea
 * payload. Backs chorus_checkin / session-start, which surfaces the distribution
 * rather than a per-idea list.
 *
 * Derived from `buildIdeaTracker` (the single source of truth) rather than a
 * second count query, so the count can never drift from what
 * chorus_get_my_assignments reports. Do NOT re-implement the active-idea filter
 * or add a divergent query here — the 0.7.2 single-source refactor (see the file
 * header) exists precisely to prevent that drift.
 *
 * Ordering + bounding (overview semantics):
 *   - `buildIdeaTracker` visits ideas in `updatedAt desc` and creates each
 *     project on first appearance, so `Object.entries(tracker)` is already
 *     ordered by each project's most-recently-active idea (most recent first).
 *   - Duplicate-named projects are dropped, keeping the most-recent one.
 *   - The result is truncated to `MAX_ACTIVE_PROJECTS` (10) — it is an overview,
 *     not the full list. Per-project `activeIdeaCount` is NOT truncated (it
 *     still reflects every active idea in that project), so callers still MUST
 *     NOT pass `maxIdeas`.
 */
export async function buildActiveProjectDistribution(
  auth: AuthContext,
  options: BuildIdeaTrackerOptions = {},
): Promise<Record<string, ActiveProjectDistributionEntry>> {
  const tracker = await buildIdeaTracker(auth, options);
  const distribution: Record<string, ActiveProjectDistributionEntry> = {};
  const seenNames = new Set<string>();
  for (const [projectUuid, project] of Object.entries(tracker)) {
    if (seenNames.has(project.name)) continue; // no duplicate-named projects
    seenNames.add(project.name);
    distribution[projectUuid] = {
      name: project.name,
      activeIdeaCount: project.ideas.length,
    };
    if (Object.keys(distribution).length >= MAX_ACTIVE_PROJECTS) break; // overview: truncate at the cap
  }
  return distribution;
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

  // Route the assignee match through buildAssigneeMatch so `agent_instance`
  // task assignments resolve to the agent and are not dropped from the tracker.
  const assigneeMatch = await buildAssigneeMatch(auth);
  const rawTasks = await prisma.task.findMany({
    where: {
      companyUuid: auth.companyUuid,
      OR: assigneeMatch,
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
