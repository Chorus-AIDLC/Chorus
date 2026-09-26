import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { resolveAssigneeAgentUuid } from "@/lib/uuid-resolver";
import { resolveProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";
import { createPendingTurn, resolveOrCreateSession, publishTranscriptEvent, STALE_THRESHOLD_MS } from "@/services/daemon-session.service";
import { deliverTurnPing } from "@/services/daemon-instruction.service";
import { getResearchEligibility, lockResearchProject, RESEARCH_INSTRUCTION_PREFIX, type ResearchReason } from "@/services/research-eligibility.service";

export type ResearchErrorCode = ResearchReason | "unauthorized" | "assignment_required" |
  "permission_denied" | "agent_offline" | "origin_conflict" | "target_changed" | "unknown";
export class ResearchError extends Error {
  constructor(public readonly code: ResearchErrorCode) {
    super(code);
  }
}

async function retryTurnConflict<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || typeof error !== "object" || !error ||
        !("code" in error) || error.code !== "P2002") throw error;
      // The entire previous transaction has rolled back. Reacquire the project
      // lock and repeat eligibility as well as session/turn allocation.
      // Give the competing wake time to finish before contending for its session again.
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export function composeResearchInstruction(ideaUuid: string): string {
  return [
    `${RESEARCH_INSTRUCTION_PREFIX} Explicit, one-time research request for ideaUuid: ${ideaUuid}.`,
    "This is the existing Idea's root conversation. Before research and again before saving, re-read the Idea, ALL related proposals/tasks and execution history including theme descendants. If development has begun, report that the stage changed and STOP without research or edits.",
    "Invoke the shared research skill for ONE bounded pass (approximately 2–5 minutes, at most 5 deeply read sources). Reuse existing evidence. An explicit user instruction to skip research takes precedence. Tools unavailable, empty results, or exhausted budget: record the limitation and stop.",
    "Attach useful sources through existing references and obtain real UUIDs. Read the latest Idea content immediately before saving and MERGE concise findings, source citations using ref:UUID, implications, unknowns, and the stopping reason; preserve user text and existing evidence.",
    "Preserve all elaboration rounds, questions, answers and resolved state. Do not create or claim an Idea, start elaboration, submit or modify a Proposal, change task status, or start development. If findings affect an approved proposal, only record the impact and revision needs in the Idea.",
    "Report the findings and END this turn. This menu invocation does not resume the Idea or Proposal workflow. A later explicit Research request may run another bounded pass.",
  ].join("\n");
}

export async function requestResearch(params: {
  companyUuid: string; ideaUuid: string; actorUuid: string; actorType: string;
  temporaryCwd?: { host: string; cwd: string } | null;
  temporaryAgentUuid?: string;
  selection?: { agentUuid: string; instanceUuid?: string };
}) {
  if (!["user", "super_admin"].includes(params.actorType)) throw new ResearchError("unauthorized");
  const { companyUuid, ideaUuid, actorUuid } = params;
  const idea = await prisma.idea.findFirst({ where: { companyUuid, uuid: ideaUuid } });
  if (!idea) throw new ResearchError("idea_not_found");
  const assignedAgentUuid = await resolveAssigneeAgentUuid(companyUuid, idea.assigneeType, idea.assigneeUuid);
  const agentUuid = params.selection?.agentUuid ?? assignedAgentUuid;
  if (!agentUuid) throw new ResearchError("assignment_required");
  if (assignedAgentUuid && agentUuid !== assignedAgentUuid) throw new ResearchError("target_changed");
  if (params.temporaryCwd && params.temporaryAgentUuid !== agentUuid) throw new ResearchError("target_changed");
  const agent = await prisma.agent.findFirst({ where: { companyUuid, uuid: agentUuid } });
  if (!agent || (params.actorType !== "super_admin" && agent.ownerUuid !== actorUuid)) {
    throw new ResearchError("permission_denied");
  }
  const permissions = computeEffectivePermissions(agent.roles, agent.permissions);
  const requiredPermissions = ["idea:read", "idea:write", "proposal:read", "task:read", "document:read", "document:write"] as const;
  if (!requiredPermissions.every((p) => permissions.has(p))) {
    throw new ResearchError("permission_denied");
  }
  const targetParams = {
    companyUuid, actorUserUuid: actorUuid, projectUuid: idea.projectUuid, agentUuid,
    registeredInstanceUuid: assignedAgentUuid === agentUuid && idea.assigneeType === "agent_instance" ? idea.assigneeUuid : null,
    registeredSource: assignedAgentUuid === agentUuid && idea.cwdSource === "project_fixed" ? "project_fixed" as const : null,
    registeredHost: assignedAgentUuid === agentUuid ? idea.cwdHost : null,
    registeredRuntimeCwd: assignedAgentUuid === agentUuid ? idea.runtimeCwd : null,
    temporaryTarget: params.temporaryCwd,
  };
  const baseTarget = await resolveProjectAgentCwdTarget(targetParams);
  // A newly selected instance never overrides the project's fixed directory.
  const target = params.selection?.instanceUuid && baseTarget.source !== "project_fixed"
    ? await resolveProjectAgentCwdTarget({
        ...targetParams, registeredInstanceUuid: params.selection.instanceUuid,
        registeredSource: null, registeredHost: null, registeredRuntimeCwd: null,
      })
    : baseTarget;
  // An existing conversation always keeps its origin. A resolved hard cwd must agree.
  const existing = await prisma.daemonSession.findFirst({
    where: { companyUuid, agentUuid, sessionId: ideaUuid },
  });
  if (!existing && target.source === "unconfigured") {
    const onlineCount = await prisma.daemonConnection.count({
      where: { companyUuid, agentUuid, status: "online", lastSeenAt: { gte: new Date(Date.now() - STALE_THRESHOLD_MS) } },
    });
    if (onlineCount > 1) throw new ResearchError("assignment_required");
  }
  const originUuid = existing?.originConnectionUuid ?? target.connectionUuid;
  if (!originUuid) throw new ResearchError("agent_offline");
  if (target.source !== "unconfigured" && (target.availability !== "ready" ||
    (existing && (target.connectionUuid !== existing.originConnectionUuid ||
      (existing.runtimeCwd && target.cwd !== existing.runtimeCwd))))) {
    throw new ResearchError(target.availability !== "ready" ? "agent_offline" : "origin_conflict");
  }
  const instruction = composeResearchInstruction(ideaUuid);
  const result = await retryTurnConflict(() => prisma.$transaction(async (tx) => {
    await lockResearchProject(tx, companyUuid, idea.projectUuid);
    await tx.$queryRaw`SELECT uuid FROM "Idea" WHERE uuid = ${ideaUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
    const current = await tx.idea.findFirst({ where: { companyUuid, uuid: ideaUuid } });
    if (!current) throw new ResearchError("idea_not_found");
    if (["projectUuid", "assigneeType", "assigneeUuid", "cwdSource", "cwdHost", "runtimeCwd"].some(
      (key) => current[key as keyof typeof current] !== idea[key as keyof typeof idea],
    )) throw new ResearchError("target_changed");
    const currentAgent = await tx.agent.findFirst({ where: { companyUuid, uuid: agentUuid } });
    if (!currentAgent || (params.actorType !== "super_admin" && currentAgent.ownerUuid !== actorUuid) ||
      !requiredPermissions.every((p) => computeEffectivePermissions(currentAgent.roles, currentAgent.permissions).has(p))) {
      throw new ResearchError("permission_denied");
    }
    const eligibility = await getResearchEligibility(companyUuid, ideaUuid, tx);
    if (!eligibility.eligible) throw new ResearchError(eligibility.reason);
    const origin = await tx.daemonConnection.findFirst({
      where: { companyUuid, uuid: originUuid, agentUuid, status: "online",
        lastSeenAt: { gte: new Date(Date.now() - STALE_THRESHOLD_MS) } },
    });
    if (!origin) throw new ResearchError("agent_offline");
    if (target.source !== "unconfigured" && (origin.host !== target.host ||
      (target.source === "registered_instance" && !idea.runtimeCwd && origin.cwd !== target.cwd))) {
      throw new ResearchError("target_changed");
    }
    const pinned = await tx.daemonSession.findFirst({ where: { companyUuid, agentUuid, sessionId: ideaUuid } });
    if (pinned && (pinned.originConnectionUuid !== originUuid || pinned.directIdeaUuid !== ideaUuid ||
      (target.source !== "unconfigured" && pinned.runtimeCwd && pinned.runtimeCwd !== target.cwd))) {
      throw new ResearchError("origin_conflict");
    }
    const session = await resolveOrCreateSession({
      companyUuid, agentUuid, sessionId: ideaUuid, directIdeaUuid: ideaUuid,
      originConnectionUuid: originUuid, runtimeCwd: pinned?.runtimeCwd ?? target.cwd ?? origin.cwd,
    }, tx);
    if (session.originConnectionUuid !== originUuid || session.directIdeaUuid !== ideaUuid) {
      throw new ResearchError("origin_conflict");
    }
    // Research writers serialize; the existing unique seq constraint fences other wakes.
    await tx.$queryRaw`SELECT uuid FROM "DaemonSession" WHERE uuid = ${session.uuid} FOR UPDATE`;
    const turn = await createPendingTurn({ sessionUuid: session.uuid, trigger: "human_instruction", promptText: instruction }, tx);
    if (params.selection) {
      // Research's explicit selection is NOT a lifecycle assignment. Preserve status,
      // elaboration and content, and emit no assigned activity/initialization wake.
      const instanceUuid = target.agentInstanceUuid ?? origin.agentInstanceUuid;
      await tx.idea.update({ where: { uuid: ideaUuid, companyUuid }, data: {
        assigneeType: instanceUuid ? "agent_instance" : "agent",
        assigneeUuid: instanceUuid ?? agentUuid,
        assignedByType: "user", assignedByUuid: actorUuid, assignedAt: new Date(),
        cwdSource: target.source === "project_fixed" ? "project_fixed" : null,
        cwdHost: target.host ?? origin.host,
        runtimeCwd: session.runtimeCwd,
      } });
    }
    // Persist the human_instruction notification in the same transaction. The generic
    // notification writer uses global prisma, so cannot see this uncommitted turn.
    const notification = await tx.notification.create({ data: {
      companyUuid, projectUuid: idea.projectUuid, projectName: "", recipientType: "agent", recipientUuid: agentUuid,
      entityType: "idea", entityUuid: ideaUuid, entityTitle: idea.title, action: "human_instruction",
      message: "Human instruction", actorType: "user", actorUuid, actorName: "", instructionText: instruction,
    } });
    return { session, turn, notification };
  }));
  publishTranscriptEvent({ companyUuid, sessionUuid: result.session.uuid, trigger: "turn_created", turn: result.turn, messages: [] });
  // Only the precise origin ping executes this instruction; the notification is its
  // human-visible durable record. Reconnect delivery reads the same pending turn.
  deliverTurnPing({ companyUuid, originConnectionUuid: originUuid, turnUuid: result.turn.uuid, runtimeCwd: result.session.runtimeCwd });
  eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });
  return { session: result.session, sessionUuid: result.session.uuid, turnUuid: result.turn.uuid, agentUuid };
}
