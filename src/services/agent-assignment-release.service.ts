// src/services/agent-assignment-release.service.ts
// Release an agent's unfinished work when the agent is deleted (design D5 of
// fix-idea-move-dangling-assignee). Assignments are polymorphic with no DB
// relation, so deleting an Agent (and cascading its AgentInstances) would
// otherwise leave tasks and ideas pointing at a uuid that no longer exists.
//
// Runs inside the caller's transaction so the release and the agent delete
// commit (or roll back) together. Finished work (to_verify/done/closed tasks,
// ideas whose derived status is done) keeps its assignee for history.

import type { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import * as activityService from "@/services/activity.service";
import {
  computeDerivedStatus,
  normalizeIdeaStatus,
  rollupThemeDerivedStatus,
  type DerivedIdeaStatus,
} from "@/services/idea.service";

type ReleaseDb = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** Task statuses that count as unfinished work and get returned to `open`. */
export const RELEASABLE_TASK_STATUSES = ["assigned", "in_progress"] as const;

export interface AgentAssignmentReleaseResult {
  releasedTaskUuids: string[];
  releasedIdeaUuids: string[];
  /** Emit SSE changes + activity events. Call only AFTER the transaction commits. */
  publish: () => void;
}

// Same field set releaseTask clears.
const TASK_RELEASE_DATA = {
  status: "open",
  assigneeType: null,
  assigneeUuid: null,
  cwdSource: null,
  cwdHost: null,
  runtimeCwd: null,
  assignedAt: null,
  assignedByType: null,
  assignedByUuid: null,
};

// Same assignee/cwd/provenance fields releaseIdea clears.
const IDEA_ASSIGNEE_CLEAR_DATA = {
  assigneeType: null,
  assigneeUuid: null,
  cwdSource: null,
  cwdHost: null,
  runtimeCwd: null,
  assignedAt: null,
  assignedByType: null,
  assignedByUuid: null,
};

export async function releaseAgentAssignments(
  companyUuid: string,
  agentUuid: string,
  actorUuid: string,
  tx: ReleaseDb,
): Promise<AgentAssignmentReleaseResult> {
  // Instance uuids must be read before the agent delete cascades them away.
  const instances = await tx.agentInstance.findMany({
    where: { companyUuid, agentUuid },
    select: { uuid: true },
  });
  const instanceUuids = instances.map((i) => i.uuid);

  const assigneeMatch = [
    { assigneeType: "agent", assigneeUuid: agentUuid },
    ...(instanceUuids.length > 0
      ? [{ assigneeType: "agent_instance", assigneeUuid: { in: instanceUuids } }]
      : []),
  ];

  const [tasks, ideas] = await Promise.all([
    tx.task.findMany({
      where: { companyUuid, status: { in: [...RELEASABLE_TASK_STATUSES] }, OR: assigneeMatch },
      select: { uuid: true, projectUuid: true },
    }),
    tx.idea.findMany({
      where: { companyUuid, OR: assigneeMatch },
      select: { uuid: true, projectUuid: true, status: true },
    }),
  ]);

  // Derived status is computed on `tx` (not through the global client, which
  // would need a second pool connection while this transaction holds one), and
  // before any idea write, so "done" reflects the pre-release state.
  const derivedByIdea = await computeDerivedStatusesInTx(
    tx, companyUuid, [...new Set(ideas.map((i) => i.projectUuid))],
  );
  const ideasToRelease = ideas.filter((i) => derivedByIdea.get(i.uuid) !== "done");

  if (tasks.length > 0) {
    await tx.task.updateMany({
      where: {
        companyUuid,
        uuid: { in: tasks.map((t) => t.uuid) },
        status: { in: [...RELEASABLE_TASK_STATUSES] },
      },
      data: TASK_RELEASE_DATA,
    });
  }

  // releaseIdea semantics: an elaborated Idea keeps its status; anything else
  // returns to open with elaboration state cleared.
  const elaboratedUuids = ideasToRelease
    .filter((i) => normalizeIdeaStatus(i.status) === "elaborated")
    .map((i) => i.uuid);
  const resetUuids = ideasToRelease
    .filter((i) => normalizeIdeaStatus(i.status) !== "elaborated")
    .map((i) => i.uuid);
  if (elaboratedUuids.length > 0) {
    await tx.idea.updateMany({
      where: { companyUuid, uuid: { in: elaboratedUuids } },
      data: IDEA_ASSIGNEE_CLEAR_DATA,
    });
  }
  if (resetUuids.length > 0) {
    await tx.idea.updateMany({
      where: { companyUuid, uuid: { in: resetUuids } },
      data: {
        ...IDEA_ASSIGNEE_CLEAR_DATA,
        status: "open",
        elaborationDepth: null,
        elaborationStatus: null,
      },
    });
  }

  const publishers: Array<() => void> = [];
  const released = [
    ...tasks.map((t) => ({ targetType: "task" as const, ...t })),
    ...ideasToRelease.map((i) => ({ targetType: "idea" as const, uuid: i.uuid, projectUuid: i.projectUuid })),
  ];
  for (const entity of released) {
    const { publish } = await activityService.createActivityInTx(tx, {
      companyUuid,
      projectUuid: entity.projectUuid,
      targetType: entity.targetType,
      targetUuid: entity.uuid,
      actorType: "user",
      actorUuid,
      action: "released",
    });
    publishers.push(publish);
  }

  return {
    releasedTaskUuids: tasks.map((t) => t.uuid),
    releasedIdeaUuids: ideasToRelease.map((i) => i.uuid),
    publish: () => {
      for (const entity of released) {
        eventBus.emitChange({
          companyUuid,
          projectUuid: entity.projectUuid,
          entityType: entity.targetType,
          entityUuid: entity.uuid,
          action: "updated",
        });
      }
      for (const publish of publishers) publish();
    },
  };
}

/**
 * Batched derived status for every Idea in the given projects, mirroring
 * getIdeasWithDerivedStatus (own status from the latest approved / any pending
 * proposal and its tasks, then theme rollup over same-project direct children)
 * but reading through the caller's transaction client. Three queries total.
 */
async function computeDerivedStatusesInTx(
  tx: ReleaseDb,
  companyUuid: string,
  projectUuids: string[],
): Promise<Map<string, DerivedIdeaStatus>> {
  const result = new Map<string, DerivedIdeaStatus>();
  if (projectUuids.length === 0) return result;

  const [ideas, proposals] = await Promise.all([
    tx.idea.findMany({
      where: { companyUuid, projectUuid: { in: projectUuids } },
      select: { uuid: true, projectUuid: true, status: true, elaborationStatus: true, parentUuid: true, isContainer: true },
    }),
    tx.proposal.findMany({
      where: { companyUuid, projectUuid: { in: projectUuids }, status: { in: ["approved", "pending"] } },
      select: { uuid: true, projectUuid: true, status: true, inputUuids: true, createdAt: true },
    }),
  ]);

  // Proposal inputs are only honored within the proposal's own project, as in
  // the per-project tracker query.
  const latestApproved = new Map<string, { uuid: string; createdAt: Date }>();
  const hasPending = new Set<string>();
  for (const proposal of proposals) {
    const inputUuids = proposal.inputUuids as string[];
    if (!Array.isArray(inputUuids)) continue;
    for (const ideaUuid of inputUuids) {
      const key = `${proposal.projectUuid}:${ideaUuid}`;
      if (proposal.status === "pending") {
        hasPending.add(key);
      } else if (proposal.status === "approved") {
        const existing = latestApproved.get(key);
        if (!existing || proposal.createdAt > existing.createdAt) {
          latestApproved.set(key, { uuid: proposal.uuid, createdAt: proposal.createdAt });
        }
      }
    }
  }

  const approvedUuids = [...new Set([...latestApproved.values()].map((p) => p.uuid))];
  const taskStatusesByProposal = new Map<string, string[]>();
  if (approvedUuids.length > 0) {
    const tasks = await tx.task.findMany({
      where: { companyUuid, proposalUuid: { in: approvedUuids } },
      select: { proposalUuid: true, status: true },
    });
    for (const task of tasks) {
      if (!task.proposalUuid) continue;
      const statuses = taskStatusesByProposal.get(task.proposalUuid) ?? [];
      statuses.push(task.status);
      taskStatusesByProposal.set(task.proposalUuid, statuses);
    }
  }

  type IdeaNode = (typeof ideas)[number];
  const base = new Map<string, DerivedIdeaStatus>();
  const byUuid = new Map<string, IdeaNode>(ideas.map((i) => [i.uuid, i]));
  const childrenByParent = new Map<string, string[]>();
  for (const idea of ideas) {
    const key = `${idea.projectUuid}:${idea.uuid}`;
    const approved = latestApproved.get(key);
    base.set(idea.uuid, computeDerivedStatus({
      ideaStatus: idea.status,
      elaborationStatus: idea.elaborationStatus,
      hasPendingProposal: hasPending.has(key),
      hasApprovedProposal: !!approved,
      taskStatuses: approved ? taskStatusesByProposal.get(approved.uuid) ?? [] : [],
    }).derivedStatus);
    const parent = idea.parentUuid ? byUuid.get(idea.parentUuid) : undefined;
    if (parent && parent.projectUuid === idea.projectUuid) {
      const siblings = childrenByParent.get(parent.uuid) ?? [];
      siblings.push(idea.uuid);
      childrenByParent.set(parent.uuid, siblings);
    }
  }

  // Malformed parent cycles keep their own status, as in the tracker query.
  // Each Idea has at most one parent, so a parent-chain walk finds every cycle.
  const cyclic = new Set<string>();
  const scanned = new Set<string>();
  for (const idea of ideas) {
    const path: string[] = [];
    const index = new Map<string, number>();
    let current: string | undefined = idea.uuid;
    while (current && !scanned.has(current)) {
      const start = index.get(current);
      if (start !== undefined) {
        for (const member of path.slice(start)) cyclic.add(member);
        break;
      }
      index.set(current, path.length);
      path.push(current);
      const node: IdeaNode = byUuid.get(current)!;
      const parent: IdeaNode | undefined = node.parentUuid ? byUuid.get(node.parentUuid) : undefined;
      current = parent && parent.projectUuid === node.projectUuid ? parent.uuid : undefined;
    }
    for (const member of path) scanned.add(member);
  }

  // Theme rollup: a container with children takes its status from its direct
  // children, resolved recursively (acyclic by construction above).
  const resolve = (uuid: string): DerivedIdeaStatus => {
    const cached = result.get(uuid);
    if (cached) return cached;
    const own = base.get(uuid)!;
    const children = childrenByParent.get(uuid) ?? [];
    const status = !byUuid.get(uuid)!.isContainer || children.length === 0 || cyclic.has(uuid)
      ? own
      : rollupThemeDerivedStatus(children.map(resolve)).derivedStatus;
    result.set(uuid, status);
    return status;
  };
  for (const idea of ideas) result.set(idea.uuid, resolve(idea.uuid));
  return result;
}
