import { prisma } from "@/lib/prisma";

export type ResearchDb = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export const RESEARCH_INSTRUCTION_PREFIX = "[Chorus Tracker Research]";
export const EXECUTED_TASK_STATUSES = ["in_progress", "to_verify", "done"];
export type ResearchReason = "development_started" | "idea_completed" | "already_running" | "idea_not_found";
export type ResearchEligibility = { eligible: true } | { eligible: false; reason: ResearchReason };

/**
 * Project-scoped row lock deliberately covers overlapping theme subtrees and proposals
 * with multiple input ideas. All execution acceptance paths take this same lock before
 * recording their durable execution fact. No global-client calls inside the transaction.
 */
export async function lockResearchProject(tx: ResearchDb, companyUuid: string, projectUuid: string) {
  await tx.$queryRaw`SELECT uuid FROM "Project" WHERE uuid = ${projectUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
}

function provesExecution(action: string, value: unknown): boolean {
  if (["execution_started", "submitted", "verified", "completed"].includes(action)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Current writers use `status`, `statusUpdated`, and force_status_change's from/to.
  return ["status", "statusUpdated", "from", "to", "oldStatus", "newStatus"].some(
    (key) => typeof record[key] === "string" && EXECUTED_TASK_STATUSES.includes(record[key] as string),
  );
}

export async function getResearchEligibility(
  companyUuid: string,
  ideaUuid: string,
  db: ResearchDb = prisma,
  options: { ignoreTurnUuid?: string; stageOnly?: boolean } = {},
): Promise<ResearchEligibility> {
  const idea = await db.idea.findFirst({ where: { companyUuid, uuid: ideaUuid } });
  if (!idea) return { eligible: false, reason: "idea_not_found" };
  const ideas = await db.idea.findMany({
    where: { companyUuid, projectUuid: idea.projectUuid },
    select: { uuid: true, parentUuid: true, status: true, isContainer: true },
  });
  const related = new Set([ideaUuid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const child of ideas) {
      if (child.parentUuid && related.has(child.parentUuid) && !related.has(child.uuid)) {
        related.add(child.uuid);
        grew = true;
      }
    }
  }
  const ids = [...related];
  if (ideas.some((i) => related.has(i.uuid) && i.status === "done")) {
    return { eligible: false, reason: "development_started" };
  }
  const proposals = await db.proposal.findMany({
    where: { companyUuid, projectUuid: idea.projectUuid, inputType: "idea",
      OR: ids.map((id) => ({ inputUuids: { array_contains: [id] } })) },
    select: { uuid: true, status: true, inputUuids: true },
    orderBy: { createdAt: "desc" },
  });
  const tasks = proposals.length ? await db.task.findMany({
    where: { companyUuid, proposalUuid: { in: proposals.map((p) => p.uuid) } },
    select: { uuid: true, status: true, proposalUuid: true },
  }) : [];
  if (tasks.some((t) => EXECUTED_TASK_STATUSES.includes(t.status))) {
    return { eligible: false, reason: "development_started" };
  }
  // Completion is derived, not stored on Idea. Match the Tracker's latest approved
  // proposal + all-finished predicate, and roll up themes through their children.
  // A closed task on its own is not execution; ALL closed tasks may complete an Idea.
  const completed = new Map<string, boolean>();
  for (const item of ideas) {
    if (!related.has(item.uuid)) continue;
    const ownProposals = proposals.filter((p) => Array.isArray(p.inputUuids) && p.inputUuids.includes(item.uuid));
    const approved = ownProposals.find((p) => p.status === "approved");
    const statuses = tasks.filter((t) => t.proposalUuid === approved?.uuid).map((t) => t.status);
    completed.set(item.uuid, item.status === "done" || (
      item.status === "elaborated" && !ownProposals.some((p) => p.status === "pending") &&
      !!approved && statuses.length > 0 && statuses.every((s) => s === "closed" || s === "done")
    ));
  }
  // Bounded fixed point also tolerates malformed legacy lineage without recursion.
  for (let pass = 0; pass < related.size; pass++) {
    for (const item of ideas) {
      if (!related.has(item.uuid) || !item.isContainer) continue;
      const children = ideas.filter((child) => child.parentUuid === item.uuid);
      if (children.length) completed.set(item.uuid, children.every((child) => completed.get(child.uuid)));
    }
  }
  if (completed.get(ideaUuid)) return { eligible: false, reason: "idea_completed" };
  const activities = await db.activity.findMany({
    where: { companyUuid, projectUuid: idea.projectUuid, OR: [
      { targetType: "idea", targetUuid: { in: ids }, action: "start_development" },
      { targetType: "task", targetUuid: { in: tasks.map((t) => t.uuid) } },
    ] },
    select: { action: true, value: true, targetType: true },
  });
  const developmentTurn = await db.daemonSessionTurn.findFirst({
    where: { trigger: "start_development", session: { companyUuid, directIdeaUuid: { in: ids } } },
    select: { uuid: true },
  });
  if (developmentTurn || activities.some((a) => a.targetType === "idea" || provesExecution(a.action, a.value))) {
    return { eligible: false, reason: "development_started" };
  }
  if (!options.stageOnly) {
    const pending = await db.daemonSessionTurn.findFirst({
      where: {
        session: { companyUuid, directIdeaUuid: ideaUuid },
        trigger: "human_instruction", status: { in: ["pending", "running"] },
        promptText: { startsWith: RESEARCH_INSTRUCTION_PREFIX },
        ...(options.ignoreTurnUuid ? { uuid: { not: options.ignoreTurnUuid } } : {}),
      },
      select: { uuid: true },
    });
    if (pending) return { eligible: false, reason: "already_running" };
  }
  return { eligible: true };
}

/** Recheck at delivery/consumption, retiring stale requests so reconnect cannot replay them. */
export async function recheckResearchTurn(companyUuid: string, ideaUuid: string, turnUuid: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const idea = await tx.idea.findFirst({ where: { companyUuid, uuid: ideaUuid }, select: { projectUuid: true } });
    if (idea) await lockResearchProject(tx, companyUuid, idea.projectUuid);
    const result = await getResearchEligibility(companyUuid, ideaUuid, tx, { stageOnly: true });
    if (result.eligible) return true;
    await tx.daemonSessionTurn.updateMany({
      where: { uuid: turnUuid, status: "pending", session: { companyUuid, directIdeaUuid: ideaUuid } },
      data: { status: "interrupted", interruptedReason: "research_stage_changed", endedAt: new Date() },
    });
    return false;
  });
}
