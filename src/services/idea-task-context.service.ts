// src/services/idea-task-context.service.ts
// Shared, batched loader for the proposal/task state that drives an Idea's
// derived status (design D4 of link-quick-task-to-idea).
//
// Every surface that reports an Idea's derived status (Idea detail, tracker,
// get_my_assignments / checkin, theme rollup, Team handoff, agent-assignment
// release, research eligibility) reads its Idea → task chain through here so
// the "which tasks count" rule lives in exactly one place:
//   - tasks of the Idea's LATEST approved proposal (pending/approved proposals
//     whose inputUuids cite the Idea, honored only within the Idea's project)
//   - ∪ tasks linked directly to the Idea via Task.ideaUuid (Quick Tasks)
//
// Query budget: 2 queries regardless of idea count (proposals, then one task
// query covering both the latest-approved proposals and the linked tasks). The
// db parameter accepts the global client or a transaction client.

import type { prisma } from "@/lib/prisma";

export type IdeaTaskDb = Pick<typeof prisma, "proposal" | "task">;

export interface IdeaTaskContextIdea {
  uuid: string;
  projectUuid: string;
}

export interface IdeaTaskContext {
  hasPendingProposal: boolean;
  hasApprovedProposal: boolean;
  /** UUID of the latest approved proposal citing the Idea, if any. */
  latestApprovedProposalUuid: string | null;
  /** Task statuses of the latest approved proposal (existing rule). */
  proposalTaskStatuses: string[];
  /** Task statuses of tasks linked directly via Task.ideaUuid. */
  linkedTaskStatuses: string[];
  /** Count of pending + approved proposals citing the Idea. */
  proposalCount: number;
}

export interface IdeaTaskProposalRow {
  uuid: string;
  projectUuid?: string;
  status: string;
  inputUuids: unknown;
  createdAt: Date;
}

export interface IdeaTaskTaskRow {
  uuid: string;
  proposalUuid: string | null;
  ideaUuid?: string | null;
  status: string;
}

export interface IdeaTaskData {
  contexts: Map<string, IdeaTaskContext>;
  /** Raw rows in deterministic order (proposals: createdAt desc, uuid asc; tasks: uuid asc). */
  proposals: IdeaTaskProposalRow[];
  tasks: IdeaTaskTaskRow[];
}

export function emptyIdeaTaskContext(): IdeaTaskContext {
  return {
    hasPendingProposal: false,
    hasApprovedProposal: false,
    latestApprovedProposalUuid: null,
    proposalTaskStatuses: [],
    linkedTaskStatuses: [],
    proposalCount: 0,
  };
}

/** The union task set that counts toward the Idea: (approved proposal tasks) ∪ (linked tasks). */
export function ideaTaskStatuses(ctx: IdeaTaskContext | undefined): string[] {
  if (!ctx) return [];
  return [
    ...(ctx.hasApprovedProposal ? ctx.proposalTaskStatuses : []),
    ...ctx.linkedTaskStatuses,
  ];
}

/**
 * Load proposals + tasks for the given ideas and return the raw rows plus a
 * per-idea context. Every input idea gets an entry (empty when it has nothing).
 */
export async function loadIdeaTaskData(
  db: IdeaTaskDb,
  companyUuid: string,
  ideas: IdeaTaskContextIdea[],
): Promise<IdeaTaskData> {
  const contexts = new Map<string, IdeaTaskContext>();
  for (const idea of ideas) contexts.set(idea.uuid, emptyIdeaTaskContext());
  if (ideas.length === 0) return { contexts, proposals: [], tasks: [] };

  const projectByIdea = new Map(ideas.map((idea) => [idea.uuid, idea.projectUuid]));
  const projectUuids = [...new Set(ideas.map((idea) => idea.projectUuid))];

  // Query 1: pending + approved proposals in the ideas' projects, newest first.
  const proposals = ((await db.proposal.findMany({
    where: { companyUuid, projectUuid: { in: projectUuids }, status: { in: ["approved", "pending"] } },
    select: { uuid: true, projectUuid: true, status: true, inputUuids: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { uuid: "asc" }],
  })) ?? []) as IdeaTaskProposalRow[];

  const latestApprovedAt = new Map<string, Date>();
  for (const proposal of proposals) {
    if (!Array.isArray(proposal.inputUuids)) continue;
    const cited = new Set<string>();
    for (const ideaUuid of proposal.inputUuids) {
      if (typeof ideaUuid !== "string" || cited.has(ideaUuid)) continue;
      const ctx = contexts.get(ideaUuid);
      if (!ctx) continue;
      // Proposal inputs are only honored within the idea's own project.
      if (proposal.projectUuid !== undefined && proposal.projectUuid !== projectByIdea.get(ideaUuid)) continue;
      cited.add(ideaUuid);
      ctx.proposalCount += 1;
      if (proposal.status === "pending") {
        ctx.hasPendingProposal = true;
      } else if (proposal.status === "approved") {
        // Latest approved wins; on a createdAt tie the first row (uuid asc) wins.
        const existing = latestApprovedAt.get(ideaUuid);
        if (!existing || proposal.createdAt > existing) {
          latestApprovedAt.set(ideaUuid, proposal.createdAt);
          ctx.hasApprovedProposal = true;
          ctx.latestApprovedProposalUuid = proposal.uuid;
        }
      }
    }
  }

  // Query 2: tasks of those latest-approved proposals ∪ tasks linked directly.
  const approvedUuids = [
    ...new Set([...contexts.values()].map((c) => c.latestApprovedProposalUuid).filter((u): u is string => !!u)),
  ];
  const ideaUuids = [...contexts.keys()];
  const tasks = ((await db.task.findMany({
    where: {
      companyUuid,
      OR: [
        ...(approvedUuids.length > 0 ? [{ proposalUuid: { in: approvedUuids } }] : []),
        { ideaUuid: { in: ideaUuids } },
      ],
    },
    select: { uuid: true, proposalUuid: true, ideaUuid: true, status: true },
    orderBy: { uuid: "asc" },
  })) ?? []) as IdeaTaskTaskRow[];

  const statusesByProposal = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.proposalUuid) continue;
    const arr = statusesByProposal.get(task.proposalUuid) ?? [];
    arr.push(task.status);
    statusesByProposal.set(task.proposalUuid, arr);
  }
  for (const ctx of contexts.values()) {
    if (ctx.latestApprovedProposalUuid) {
      ctx.proposalTaskStatuses = [...(statusesByProposal.get(ctx.latestApprovedProposalUuid) ?? [])];
    }
  }
  for (const task of tasks) {
    if (!task.ideaUuid) continue;
    const ctx = contexts.get(task.ideaUuid);
    // A task already counted via the idea's latest approved proposal is not
    // double-counted (Task.ideaUuid and proposalUuid are exclusive in practice).
    if (!ctx || (task.proposalUuid && task.proposalUuid === ctx.latestApprovedProposalUuid)) continue;
    ctx.linkedTaskStatuses.push(task.status);
  }

  return { contexts, proposals, tasks };
}

/** Per-idea task contexts — see loadIdeaTaskData. */
export async function loadIdeaTaskContexts(
  db: IdeaTaskDb,
  companyUuid: string,
  ideas: IdeaTaskContextIdea[],
): Promise<Map<string, IdeaTaskContext>> {
  return (await loadIdeaTaskData(db, companyUuid, ideas)).contexts;
}
