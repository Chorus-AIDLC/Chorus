import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import type { AuthContext } from "@/types/auth";
import type { IdeaTeamActorContext, IdeaTeamContextDto, IdeaTeamRecommendationDto, IdeaTeamRoutingRole } from "@/types/idea-team";
import { computeProjectAccess, levelAtLeast, resolveEntityProjectUuid } from "./project-access.service";
import { getProjectAgentTeam, projectTeamTransaction, type ProjectTeamClient } from "./project-agent-team.service";
import { createActivityInTx } from "./activity.service";
import { createMentions } from "./mention.service";

function forbidden(reason: string): never {
  throw new ApiError("FORBIDDEN", reason, 403);
}

async function actorAuth(companyUuid: string, actor: IdeaTeamActorContext | undefined, client: ProjectTeamClient): Promise<AuthContext | null> {
  if (!actor) return null;
  if (actor.actorType === "user") {
    const user = await client.user.findFirst({ where: { uuid: actor.actorUuid, companyUuid, status: "active", deletedAt: null } });
    return user ? { type: "user", actorUuid: user.uuid, companyUuid } : null;
  }
  if (actor.actorType === "agent") {
    const agent = await client.agent.findFirst({ where: { uuid: actor.actorUuid, companyUuid } });
    return agent ? { type: "agent", actorUuid: agent.uuid, companyUuid, ownerUuid: agent.ownerUuid ?? undefined } : null;
  }
  return null;
}

async function logicalAgent(companyUuid: string, type: string | null, uuid: string | null, client: ProjectTeamClient) {
  if (!uuid) return null;
  if (type === "agent") return uuid;
  if (type !== "agent_instance") return null;
  return (await client.agentInstance.findFirst({ where: { uuid, companyUuid }, select: { agentUuid: true } }))?.agentUuid ?? null;
}

async function loadIdea(companyUuid: string, ideaUuid: string, client: ProjectTeamClient) {
  const idea = await client.idea.findFirst({ where: { uuid: ideaUuid, companyUuid } });
  if (!idea) throw new ApiError("NOT_FOUND", "Idea not found", 404);
  return idea;
}

async function teamState(companyUuid: string, ideaUuid: string, client: ProjectTeamClient) {
  const idea = await loadIdea(companyUuid, ideaUuid, client);
  const managed = Boolean(idea.teamOwnerUuid || idea.teamLeadAgentUuid);
  const team = idea.teamOwnerUuid ? await getProjectAgentTeam({ type: "user", actorUuid: idea.teamOwnerUuid, companyUuid }, idea.projectUuid, client).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return null;
    throw error;
  }) : null;
  const lead = team?.roles.lead.find((member) => member.agentUuid === idea.teamLeadAgentUuid);
  const assignedAgent = await logicalAgent(companyUuid, idea.assigneeType, idea.assigneeUuid, client);
  const reason = !managed ? null : !team ? "team_unbound" : !lead?.eligible ? "lead_ineligible" : assignedAgent !== idea.teamLeadAgentUuid ? "lead_not_assignee" : null;
  const yoloEvidence = managed ? await client.activity.findMany({ where: {
    companyUuid, projectUuid: idea.projectUuid, targetType: "idea", targetUuid: ideaUuid, action: "yolo_requested", actorType: "user",
  }, select: { actorUuid: true } }) : [];
  const yolo = yoloEvidence.length > 0 && Boolean(await client.user.findFirst({ where: { companyUuid, uuid: { in: yoloEvidence.map((activity) => activity.actorUuid) } }, select: { uuid: true } }));
  return { idea, managed, team, lead, reason, yolo, active: managed && !reason };
}

async function authorizedRead(auth: AuthContext, ideaUuid: string, client: ProjectTeamClient) {
  const identity = await actorAuth(auth.companyUuid, { actorType: auth.type, actorUuid: auth.actorUuid }, client);
  if (!identity) forbidden("Authenticated actor required");
  const idea = await loadIdea(auth.companyUuid, ideaUuid, client);
  if (!levelAtLeast((await computeProjectAccess(identity, idea.projectUuid, client)).level, "viewer")) throw new ApiError("NOT_FOUND", "Idea not found", 404);
  return identity;
}

export async function getIdeaTeamContext(auth: AuthContext, ideaUuid: string, client: ProjectTeamClient = prisma): Promise<IdeaTeamContextDto> {
  const identity = await authorizedRead(auth, ideaUuid, client);
  const state = await teamState(auth.companyUuid, ideaUuid, client);
  const privateAccess = (identity.type === "user" ? identity.actorUuid : identity.ownerUuid) === state.idea.teamOwnerUuid;
  const leadAgent = state.idea.teamLeadAgentUuid ? await client.agent.findFirst({ where: { uuid: state.idea.teamLeadAgentUuid, companyUuid: auth.companyUuid }, select: { name: true } }) : null;
  return {
    ideaUuid, managed: state.managed, state: !state.managed ? "unmanaged" : state.active ? "active" : "paused",
    lead: state.idea.teamLeadAgentUuid ? { agentUuid: state.idea.teamLeadAgentUuid, agentName: leadAgent?.name ?? "Unavailable agent" } : null,
    yolo: state.yolo, proposalGate: state.managed && state.yolo ? "lead" : "human", taskGate: state.managed ? "lead" : "human", reason: state.reason,
    routing: privateAccess && state.team && state.idea.teamOwnerUuid ? { ownerUuid: state.idea.teamOwnerUuid, productAgentUuid: state.idea.teamProductAgentUuid, roles: state.team.roles } : null,
  };
}

export async function ideaTeamEnrollment(companyUuid: string, projectUuid: string, assigneeType: string, assigneeUuid: string, client: ProjectTeamClient = prisma) {
  const agentUuid = await logicalAgent(companyUuid, assigneeType, assigneeUuid, client);
  if (!agentUuid) return {};
  const agent = await client.agent.findFirst({ where: { uuid: agentUuid, companyUuid } });
  if (!agent?.ownerUuid) return {};
  const auth: AuthContext = { type: "agent", actorUuid: agentUuid, companyUuid, ownerUuid: agent.ownerUuid };
  if (!levelAtLeast((await computeProjectAccess(auth, projectUuid, client)).level, "editor")) return {};
  const team = await getProjectAgentTeam(auth, projectUuid, client);
  if (!team?.roles.lead.some((member) => member.agentUuid === agentUuid && member.eligible)) return {};
  return { teamOwnerUuid: agent.ownerUuid, teamLeadAgentUuid: agentUuid, teamProductAgentUuid: null };
}

export async function isIdeaTeamProductDelegate(companyUuid: string, ideaUuid: string, actorUuid: string, client: ProjectTeamClient = prisma): Promise<boolean> {
  const state = await teamState(companyUuid, ideaUuid, client);
  return state.active && state.idea.teamProductAgentUuid === actorUuid && Boolean(state.team?.roles.product.some((member) => member.agentUuid === actorUuid && member.eligible));
}

export async function assertIdeaTeamProductWork(companyUuid: string, ideaUuids: string[], actor: IdeaTeamActorContext | undefined, client: ProjectTeamClient = prisma) {
  for (const ideaUuid of ideaUuids) {
    const state = await teamState(companyUuid, ideaUuid, client);
    if (!state.managed) continue;
    const identity = await actorAuth(companyUuid, actor, client);
    if (!identity) forbidden("Authenticated product actor required");
    if (!levelAtLeast((await computeProjectAccess(identity, state.idea.projectUuid, client)).level, "editor")) forbidden("Project editor access required");
    if (identity.type === "user") continue;
    if (!state.active) forbidden(`Team automation paused: ${state.reason}`);
    if (identity.actorUuid !== state.idea.teamLeadAgentUuid && !await isIdeaTeamProductDelegate(companyUuid, ideaUuid, identity.actorUuid, client)) forbidden("Only the current lead or eligible product delegate can author this Idea's proposal");
  }
}

export async function delegateIdeaTeamProduct(auth: AuthContext, ideaUuid: string, agentUuid: string): Promise<IdeaTeamContextDto> {
  const committed = await projectTeamTransaction(async (client) => {
    const identity = await authorizedRead(auth, ideaUuid, client);
    const state = await teamState(auth.companyUuid, ideaUuid, client);
    if (!state.active) forbidden(state.reason ?? "Idea is not Team managed");
    if (identity.type === "agent" ? identity.actorUuid !== state.idea.teamLeadAgentUuid : !levelAtLeast((await computeProjectAccess(identity, state.idea.projectUuid, client)).level, identity.actorUuid === state.idea.teamOwnerUuid ? "editor" : "admin")) forbidden("Only the current lead, Team owner or a project admin can delegate product work");
    const member = state.team?.roles.product.find((candidate) => candidate.agentUuid === agentUuid && candidate.eligible);
    if (!member) forbidden("Product delegate is not eligible");
    if (state.idea.teamProductAgentUuid === agentUuid) return null;
    await client.idea.update({ where: { uuid: ideaUuid }, data: { teamProductAgentUuid: agentUuid } });
    const content = `@[${member.agentName}](agent:${agentUuid}) Product delegation for this Idea: fetch its Team context, elaborate and author/submit the proposal without claiming the Idea. Preserve lead ownership; do not resolve elaboration, approve proposals or verify tasks.`;
    const comment = await client.comment.create({ data: { companyUuid: auth.companyUuid, targetType: "idea", targetUuid: ideaUuid, content, authorType: identity.type, authorUuid: identity.actorUuid } });
    const activity = await createActivityInTx(client, { companyUuid: auth.companyUuid, projectUuid: state.idea.projectUuid, targetType: "idea", targetUuid: ideaUuid, actorType: identity.type, actorUuid: identity.actorUuid, action: "product_delegated", value: { agentUuid, commentUuid: comment.uuid } });
    return { comment, activity, projectUuid: state.idea.projectUuid, title: state.idea.title };
  });
  if (committed) {
    committed.activity.publish();
    await createMentions({ companyUuid: auth.companyUuid, projectUuid: committed.projectUuid, sourceType: "comment", sourceUuid: committed.comment.uuid, content: committed.comment.content, actorType: auth.type, actorUuid: auth.actorUuid, entityTitle: committed.title });
  }
  return getIdeaTeamContext(auth, ideaUuid);
}

export async function getProposalTeamIdeaUuids(companyUuid: string, proposalUuid: string, client: ProjectTeamClient = prisma): Promise<string[]> {
  const proposal = await client.proposal.findFirst({ where: { uuid: proposalUuid, companyUuid } });
  if (!proposal) forbidden("Proposal ancestry is missing");
  return resolveIdeaTeamInputs(companyUuid, proposal.inputType, proposal.inputUuids, client, [proposalUuid]);
}

export async function resolveIdeaTeamInputs(companyUuid: string, inputType: string, inputUuids: unknown, client: ProjectTeamClient = prisma, ancestors: string[] = []): Promise<string[]> {
  const ideas = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set(ancestors);
  async function visit(uuid: string) {
    if (visiting.has(uuid)) forbidden("Proposal ancestry contains a cycle");
    if (visited.has(uuid)) return;
    const proposal = await client.proposal.findFirst({ where: { uuid, companyUuid } });
    if (!proposal) forbidden("Proposal ancestry is missing");
    visiting.add(uuid);
    await inputs(proposal.inputType, proposal.inputUuids);
    visiting.delete(uuid);
    visited.add(uuid);
  }
  async function inputs(type: string, uuids: unknown) {
    if (!Array.isArray(uuids) || uuids.some((uuid) => typeof uuid !== "string")) forbidden("Proposal ancestry is ambiguous");
    if (type === "idea") {
      for (const ideaUuid of uuids as string[]) {
        const idea = await client.idea.findFirst({ where: { uuid: ideaUuid, companyUuid } });
        if (!idea) forbidden("Idea ancestry is missing");
        ideas.add(ideaUuid);
      }
    } else if (type === "document") {
      for (const documentUuid of uuids as string[]) {
        const document = await client.document.findFirst({ where: { uuid: documentUuid, companyUuid } });
        if (!document) forbidden("Document ancestry is missing");
        if (document.proposalUuid) await visit(document.proposalUuid);
      }
    } else forbidden("Proposal ancestry is ambiguous");
  }
  await inputs(inputType, inputUuids);
  return [...ideas];
}

export async function assertIdeaTeamGate(companyUuid: string, proposalUuid: string, gate: "proposal" | "task", actor: IdeaTeamActorContext | undefined, client: ProjectTeamClient = prisma) {
  const ideaUuids = await getProposalTeamIdeaUuids(companyUuid, proposalUuid, client);
  for (const ideaUuid of ideaUuids) {
    const state = await teamState(companyUuid, ideaUuid, client);
    if (!state.managed) continue;
    const identity = await actorAuth(companyUuid, actor, client);
    if (!identity) forbidden("An authenticated actor is required for a Team gate");
    const access = await computeProjectAccess(identity, state.idea.projectUuid, client);
    if (identity.type === "user") {
      if (!levelAtLeast(access.level, "editor")) forbidden("Project editor access required");
      continue;
    }
    if (!state.active) forbidden(`Team automation paused: ${state.reason}`);
    if (identity.actorUuid !== state.idea.teamLeadAgentUuid || !levelAtLeast(access.level, "editor")) forbidden("Only the current eligible Team lead can pass this gate");
    const agent = await client.agent.findFirst({ where: { uuid: identity.actorUuid, companyUuid } });
    if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has(gate === "proposal" ? "proposal:admin" : "task:admin")) forbidden("Action permission required");
    if (gate === "proposal" && !state.yolo) forbidden("Human approval required for a non-YOLO Idea");
  }
}

export async function getIdeaTeamLeadRecipients(companyUuid: string, targetType: string, targetUuid: string, client: ProjectTeamClient = prisma) {
  let ideaUuids: string[] = [];
  if (targetType === "idea") ideaUuids = [targetUuid];
  if (targetType === "proposal") ideaUuids = await getProposalTeamIdeaUuids(companyUuid, targetUuid, client);
  if (targetType === "task") {
    const task = await client.task.findFirst({ where: { uuid: targetUuid, companyUuid } });
    if (task?.proposalUuid) ideaUuids = await getProposalTeamIdeaUuids(companyUuid, task.proposalUuid, client);
  }
  const leads = new Set<string>();
  for (const ideaUuid of ideaUuids) {
    const state = await teamState(companyUuid, ideaUuid, client);
    if (state.active && state.idea.teamLeadAgentUuid) leads.add(state.idea.teamLeadAgentUuid);
  }
  return [...leads].map((uuid) => ({ type: "agent", uuid }));
}

export async function getIdeaTeamHandoffIdeaUuid(companyUuid: string, agentUuid: string, entityType: string, entityUuid: string, projectUuid: string | null | undefined, client: ProjectTeamClient = prisma): Promise<string | null> {
  if (!projectUuid || !["idea", "proposal", "task"].includes(entityType)) return null;
  try {
    if (await resolveEntityProjectUuid(companyUuid, entityType, entityUuid, client) !== projectUuid) return null;
    const identity = await actorAuth(companyUuid, { actorType: "agent", actorUuid: agentUuid }, client);
    if (!identity || !levelAtLeast((await computeProjectAccess(identity, projectUuid, client)).level, "editor")) return null;
    let ideaUuids = entityType === "idea" ? [entityUuid] : [];
    if (entityType === "proposal") ideaUuids = await getProposalTeamIdeaUuids(companyUuid, entityUuid, client);
    if (entityType === "task") {
      const task = await client.task.findFirst({ where: { uuid: entityUuid, companyUuid, projectUuid } });
      if (task?.proposalUuid) ideaUuids = await getProposalTeamIdeaUuids(companyUuid, task.proposalUuid, client);
    }
    for (const ideaUuid of [...ideaUuids].sort()) {
      const state = await teamState(companyUuid, ideaUuid, client);
      if (state.active && state.idea.teamLeadAgentUuid === agentUuid) return ideaUuid;
    }
    return null;
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

export async function recommendIdeaTeamRole(auth: AuthContext, ideaUuid: string, role: IdeaTeamRoutingRole, taskUuid?: string): Promise<IdeaTeamRecommendationDto> {
  if (role !== "product" && role !== "development") throw new ApiError("VALIDATION_ERROR", "Only product and development routing is supported", 400);
  const identity = await authorizedRead(auth, ideaUuid, prisma);
  const state = await teamState(auth.companyUuid, ideaUuid, prisma);
  const ownerUuid = identity.type === "user" ? identity.actorUuid : identity.ownerUuid;
  if (!ownerUuid || ownerUuid !== state.idea.teamOwnerUuid) forbidden("Private Team routing is owner-only");
  const task = taskUuid ? await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid: auth.companyUuid, projectUuid: state.idea.projectUuid } }) : null;
  if (taskUuid && (!task?.proposalUuid || !(await getProposalTeamIdeaUuids(auth.companyUuid, task.proposalUuid)).includes(ideaUuid))) forbidden("Task does not belong to this Idea");
  const result = (decision: IdeaTeamRecommendationDto["decision"], reason: string, candidates: IdeaTeamRecommendationDto["candidates"] = [], agentUuid: string | null = null): IdeaTeamRecommendationDto => ({ decision, reason, candidates, agentUuid });
  if (!state.active) return result("paused", state.reason ?? "unmanaged");
  const eligible = state.team!.roles[role].filter((member) => member.eligible);
  if (!eligible.length) return result("manual", "role_empty_or_ineligible");
  const online = eligible.filter((member) => member.online);
  if (!online.length) return state.lead?.eligible && state.lead.online ? result("recommended", "role_offline_lead_fallback", [state.lead], state.lead.agentUuid) : result("manual", "role_and_lead_offline", eligible);
  if (role === "development" && task) {
    const reopenHistory = await prisma.activity.findFirst({ where: {
      companyUuid: auth.companyUuid, projectUuid: task.projectUuid, targetType: "task", targetUuid: task.uuid, action: "execution_started",
      AND: [{ value: { path: ["from"], equals: "to_verify" } }, { value: { path: ["to"], equals: "in_progress" } }],
    }, orderBy: { createdAt: "desc" } });
    const reopened = reopenHistory ?? await prisma.activity.findFirst({ where: { companyUuid: auth.companyUuid, projectUuid: task.projectUuid, targetType: "task", targetUuid: task.uuid, action: "reopened" }, orderBy: { createdAt: "desc" } });
    const value = reopenHistory?.value;
    const originalType = value && typeof value === "object" && !Array.isArray(value) && typeof value.originalAssigneeType === "string" ? value.originalAssigneeType : task.assigneeType;
    const originalUuid = value && typeof value === "object" && !Array.isArray(value) && typeof value.originalAssigneeUuid === "string" ? value.originalAssigneeUuid : task.assigneeUuid;
    const original = await logicalAgent(auth.companyUuid, originalType, originalUuid, prisma);
    const preferred = reopened && online.find((member) => member.agentUuid === original);
    if (preferred) return result("recommended", "reopen_affinity", [preferred], preferred.agentUuid);
  }
  const minimumLoad = Math.min(...online.map((member) => member.activeCount));
  let candidates = online.filter((member) => member.activeCount === minimumLoad);
  if (role === "development" && task && candidates.length > 1) {
    const related = new Set<string>();
    const visited = new Set([task.uuid]);
    let frontier = [task.uuid];
    while (frontier.length) {
      const edges = await prisma.taskDependency.findMany({ where: { taskUuid: { in: frontier }, dependsOn: { companyUuid: auth.companyUuid, projectUuid: task.projectUuid, proposalUuid: task.proposalUuid } }, include: { dependsOn: true } });
      frontier = [];
      for (const edge of edges) {
        const dependency = edge.dependsOn;
        if (visited.has(dependency.uuid)) continue;
        visited.add(dependency.uuid);
        frontier.push(dependency.uuid);
        const agentUuid = await logicalAgent(auth.companyUuid, dependency.assigneeType, dependency.assigneeUuid, prisma);
        if (agentUuid) related.add(agentUuid);
      }
    }
    const affinity = candidates.filter((member) => related.has(member.agentUuid));
    if (affinity.length) candidates = affinity;
  }
  candidates.sort((left, right) => left.agentUuid.localeCompare(right.agentUuid));
  return candidates.length === 1 ? result("recommended", "minimum_load_then_dependency_affinity", candidates, candidates[0].agentUuid) : result("lead_decision", "equal_candidates", candidates);
}
