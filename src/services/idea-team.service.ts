import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import type { AuthContext } from "@/types/auth";
import type { IdeaTeamActorContext, IdeaTeamContextDto, IdeaTeamRecommendationDto, IdeaTeamRoutingRole, IdeaTeamTurnFence } from "@/types/idea-team";
import { computeProjectAccess, levelAtLeast, resolveEntityProjectUuid } from "./project-access.service";
import { getProjectAgentTeam, projectTeamTransaction, type ProjectTeamClient } from "./project-agent-team.service";
import { createActivityInTx } from "./activity.service";
import { createMentions, enrichAgentLiveness, type Mentionable } from "./mention.service";
import { parseWakeContext } from "./daemon-wake-context";
import type { WakeContext } from "./daemon-wake-context";
import { ideaTeamSupplementaryTurnsSchema } from "@/lib/idea-team-turn-context";

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
  let lead = team?.roles.lead.find((member) => member.agentUuid === idea.teamLeadAgentUuid);
  if (idea.teamEnrollmentVersion === 1 && idea.teamLeadAgentUuid) {
    const agent = await client.agent.findFirst({ where: { uuid: idea.teamLeadAgentUuid, companyUuid, ownerUuid: idea.teamOwnerUuid } });
    const owner = idea.teamOwnerUuid ? await client.user.findFirst({ where: { uuid: idea.teamOwnerUuid, companyUuid, status: "active", deletedAt: null } }) : null;
    const hasProjectAccess = Boolean(agent && owner && levelAtLeast((await computeProjectAccess({ type: "agent", actorUuid: agent.uuid, companyUuid, ownerUuid: agent.ownerUuid ?? undefined }, idea.projectUuid, client)).level, "editor"));
    const missingPermissions = agent && computeEffectivePermissions(agent.roles, agent.permissions).has("idea:write") ? [] : ["idea:write"];
    const presence: Mentionable[] = agent ? [{ uuid: agent.uuid, name: agent.name, type: "agent" }] : [];
    await enrichAgentLiveness(companyUuid, presence, client);
    lead = agent ? { agentUuid: agent.uuid, agentName: agent.name, eligible: hasProjectAccess && !missingPermissions.length, hasProjectAccess, missingPermissions, online: presence[0]?.online ?? false, activeCount: presence[0]?.activeCount ?? 0 } : undefined;
  }
  const assignedAgent = await logicalAgent(companyUuid, idea.assigneeType, idea.assigneeUuid, client);
  const reason = !managed ? null : idea.teamEnrollmentVersion === 1 && (!idea.teamEnrolledAt || !idea.teamEnrolledByUuid || idea.teamEnrolledByUuid !== idea.teamOwnerUuid) ? "human_assignment_required" : !team ? "team_unbound" : !lead?.eligible ? (idea.teamEnrollmentVersion === 1 ? "orchestrator_ineligible" : "lead_ineligible") : assignedAgent !== idea.teamLeadAgentUuid ? (idea.teamEnrollmentVersion === 1 ? "orchestrator_not_assignee" : "lead_not_assignee") : null;
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
  const assignedAgentUuid = await logicalAgent(auth.companyUuid, state.idea.assigneeType, state.idea.assigneeUuid, client);
  const assignedAgent = assignedAgentUuid ? await client.agent.findFirst({ where: { uuid: assignedAgentUuid, companyUuid: auth.companyUuid } }) : null;
  let reason = state.reason;
  if (!state.managed && state.idea.teamEnrollmentVersion === 1 && assignedAgent) {
    const assignment = await client.activity.findFirst({ where: { companyUuid: auth.companyUuid, projectUuid: state.idea.projectUuid, targetType: "idea", targetUuid: ideaUuid, action: { in: ["assigned", "assignment_recorded"] }, value: { path: ["teamGeneration"], equals: state.idea.teamGeneration } }, orderBy: { createdAt: "desc" }, select: { value: true } });
    const value = assignment?.value;
    const authorizer = value && typeof value === "object" && !Array.isArray(value) && typeof value.humanAuthorizerUuid === "string" ? value.humanAuthorizerUuid : null;
    reason = authorizer && authorizer !== assignedAgent.ownerUuid ? "owner_confirmation_required" : authorizer ? "team_unbound" : "human_assignment_required";
  }
  const permissions = assignedAgent ? computeEffectivePermissions(assignedAgent.roles, assignedAgent.permissions) : new Set<string>();
  const proposalGateReason = state.idea.teamEnrollmentVersion === 1 ? reason ?? (!state.managed ? "human_assignment_required" : !permissions.has("proposal:admin") ? "proposal_permission_required" : !state.yolo ? "human_yolo_required" : null) : null;
  const taskGateReason = state.idea.teamEnrollmentVersion === 1 ? reason ?? (!state.managed ? "human_assignment_required" : !permissions.has("task:admin") ? "task_permission_required" : null) : null;
  return {
    ideaUuid, managed: state.managed, state: !state.managed ? "unmanaged" : state.active ? "active" : "paused",
    lead: state.idea.teamLeadAgentUuid ? { agentUuid: state.idea.teamLeadAgentUuid, agentName: leadAgent?.name ?? "Unavailable agent" } : null,
    orchestrator: assignedAgent ? { agentUuid: assignedAgent.uuid, agentName: assignedAgent.name } : null,
    enrollmentVersion: state.idea.teamEnrollmentVersion, generation: state.idea.teamGeneration,
    canAuthorizeAssignment: identity.type === "user" && assignedAgent?.ownerUuid === identity.actorUuid
      && levelAtLeast((await computeProjectAccess(identity, state.idea.projectUuid, client)).level, "editor"),
    yolo: state.yolo, proposalGate: state.managed && state.yolo && !proposalGateReason ? "lead" : "human", taskGate: state.managed && !taskGateReason ? "lead" : "human", reason,
    proposalGateReason, taskGateReason,
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

export async function isIdeaTeamProductDelegate(companyUuid: string, ideaUuid: string, actorUuid: string, client: ProjectTeamClient = prisma, actor?: IdeaTeamActorContext): Promise<boolean> {
  const state = await teamState(companyUuid, ideaUuid, client);
  if (!state.active || state.idea.teamProductAgentUuid !== actorUuid || !state.team?.roles.product.some((member) => member.agentUuid === actorUuid && member.eligible)) return false;
  if (state.idea.teamEnrollmentVersion === 1) await assertIdeaTeamCurrentTurn(companyUuid, ideaUuid, actor ?? { actorType: "agent", actorUuid }, client);
  return true;
}

export async function readIdeaTeamAdmittedWakeContexts(turn: { uuid: string; sessionUuid: string; admissionTurnUuids: unknown; wakeContext: unknown }, client: ProjectTeamClient = prisma): Promise<(WakeContext | null)[]> {
  const members = turn.admissionTurnUuids ?? [turn.uuid];
  if (!Array.isArray(members) || !members.length || !members.every((member): member is string => typeof member === "string") ||
      new Set(members).size !== members.length || !members.includes(turn.uuid)) forbidden("Invalid Idea Team admitted bundle");
  const bundle = members.length === 1 ? [turn] : await client.daemonSessionTurn.findMany({ where: { uuid: { in: members }, sessionUuid: turn.sessionUuid } });
  if (bundle.length !== members.length || bundle.some((member) => member.uuid !== turn.uuid &&
      (!("status" in member) || member.status !== "merged" || !("admissionUuid" in member) || member.admissionUuid !== null))) forbidden("Idea Team admitted bundle has been replaced");
  const ordered = [turn, ...bundle.filter((member) => member.uuid !== turn.uuid)];
  return ordered.map((member) => {
    const context = parseWakeContext(member.wakeContext);
    if (member.wakeContext && !context) forbidden("Invalid Idea Team admitted wake context");
    return context;
  });
}

export async function assertIdeaTeamCurrentTurn(companyUuid: string, ideaUuid: string, actor: IdeaTeamActorContext, client: ProjectTeamClient = prisma) {
  if (client !== prisma) await client.$queryRaw`SELECT "uuid" FROM "Idea" WHERE "uuid" = ${ideaUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  const idea = await loadIdea(companyUuid, ideaUuid, client);
  if (idea.teamEnrollmentVersion !== 1 || !(idea.teamOwnerUuid || idea.teamLeadAgentUuid) || actor.actorType === "user") return;
  if (!actor.turnUuid || !actor.admissionUuid) forbidden("Upgrade your Chorus client: Idea Team automation requires a generation-fenced admitted turn");
  const supplementary = ideaTeamSupplementaryTurnsSchema.safeParse(actor.supplementaryTurns ?? []);
  if (!supplementary.success) forbidden("Invalid supplementary Idea Team turn proofs");
  let covered = false;
  for (const proof of [{ turnUuid: actor.turnUuid, admissionUuid: actor.admissionUuid }, ...supplementary.data]) {
    const turn = await client.daemonSessionTurn.findFirst({ where: {
      uuid: proof.turnUuid, admissionUuid: proof.admissionUuid, status: "running",
      session: { companyUuid, agentUuid: actor.actorUuid },
    } });
    if (!turn?.admissionConnectionUuid) forbidden("Idea Team turn is stale or is not the current admitted responsibility");
    const connection = await client.daemonConnection.findFirst({ where: { uuid: turn.admissionConnectionUuid, companyUuid, agentUuid: actor.actorUuid, status: "online" } });
    if (!connection || (turn.startedAt && connection.connectedAt > turn.startedAt)) forbidden("Idea Team admission connection has been replaced");
    let fenced = false;
    for (const context of await readIdeaTeamAdmittedWakeContexts(turn, client)) {
      if (!context?.ideaTeam) continue;
      fenced = true;
      if (!await canReceiveIdeaTeamWake(companyUuid, actor.actorUuid, context, null, client)) forbidden("Idea Team turn is stale or is not the current admitted responsibility");
      if ((context.ideaTeams ?? [context.ideaTeam]).some((fence) => fence.ideaUuid === ideaUuid)) covered = true;
    }
    if (!fenced) forbidden("Idea Team turn is stale or is not the current admitted responsibility");
  }
  if (!covered) forbidden("Idea Team source lacks a current admitted turn; supply its proof in X-Chorus-Idea-Team-Turns");
}

export async function assertIdeaTeamElaborationWork(companyUuid: string, ideaUuid: string, actor: IdeaTeamActorContext, allowProduct: boolean, permission: "idea:write" | "idea:admin", client: ProjectTeamClient = prisma) {
  const state = await teamState(companyUuid, ideaUuid, client);
  if (!state.managed || state.idea.teamEnrollmentVersion !== 1) return;
  const identity = await actorAuth(companyUuid, actor, client);
  if (!identity || !levelAtLeast((await computeProjectAccess(identity, state.idea.projectUuid, client)).level, "editor")) forbidden("Project editor access required");
  if (identity.type === "user") return;
  if (!state.active) forbidden("Idea Team automation is paused");
  if (identity.actorUuid !== state.idea.teamLeadAgentUuid && (!allowProduct || !await isIdeaTeamProductDelegate(companyUuid, ideaUuid, identity.actorUuid, client, actor))) forbidden("Only the current Idea orchestrator can perform this action");
  const agent = await client.agent.findFirst({ where: { uuid: identity.actorUuid, companyUuid } });
  if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has(permission)) forbidden(`${permission} required; ask a human to authorize this action`);
  await assertIdeaTeamCurrentTurn(companyUuid, ideaUuid, actor, client);
}

export async function canReceiveIdeaTeamFence(companyUuid: string, agentUuid: string, fence: IdeaTeamTurnFence, client: ProjectTeamClient = prisma): Promise<boolean> {
  if (client !== prisma) await client.$queryRaw`SELECT "uuid" FROM "Idea" WHERE "uuid" = ${fence.ideaUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  const state = await teamState(companyUuid, fence.ideaUuid, client);
  return state.active && state.idea.teamEnrollmentVersion === 1 && state.idea.teamGeneration === fence.generation &&
    state.idea.teamOwnerUuid === fence.ownerUuid && fence.agentUuid === agentUuid &&
    (fence.role === "orchestrator" ? state.idea.teamLeadAgentUuid === agentUuid :
      state.idea.teamProductAgentUuid === agentUuid && Boolean(state.team?.roles.product.some((member) => member.agentUuid === agentUuid && member.eligible)));
}

export async function canReceiveIdeaTeamWake(companyUuid: string, agentUuid: string, context: WakeContext | null, directIdeaUuid?: string | null, client: ProjectTeamClient = prisma): Promise<boolean> {
  if (context?.ideaTeam) {
    if (directIdeaUuid && context.ideaTeam.ideaUuid !== directIdeaUuid) return false;
    if (context.notification.recipientUuid !== agentUuid || context.notification.recipientType !== "agent") return false;
    for (const fence of context.ideaTeams ?? [context.ideaTeam]) {
      if (!await canReceiveIdeaTeamFence(companyUuid, agentUuid, fence, client)) return false;
    }
    return true;
  }
  if (!context) {
    if (!directIdeaUuid) return true;
    const idea = await client.idea.findFirst({ where: { uuid: directIdeaUuid, companyUuid } });
    return !(idea?.teamEnrollmentVersion === 1 && (idea.teamOwnerUuid || idea.teamLeadAgentUuid));
  }
  const notification = context.notification;
  if (["human_instruction", "comment_added"].includes(notification.action)) return true;
  if (notification.action === "mentioned") {
    if (notification.entityType !== "idea") return true;
    const idea = await client.idea.findFirst({ where: { uuid: notification.entityUuid, companyUuid } });
    if (idea?.teamEnrollmentVersion !== 1 || !(idea.teamOwnerUuid || idea.teamLeadAgentUuid)) return true;
    const persisted = await client.notification.findFirst({ where: { uuid: notification.uuid, companyUuid, recipientType: "agent", recipientUuid: agentUuid }, select: { createdAt: true } });
    return Boolean(persisted && idea.teamEnrolledAt && persisted.createdAt > idea.teamEnrolledAt);
  }
  if (notification.entityType === "task" && !["team_lead_handoff", "team_product_handoff"].includes(notification.action)) return true;
  const ideaUuid = directIdeaUuid ?? (notification.entityType === "idea" ? notification.entityUuid : null);
  if (ideaUuid) {
    const idea = await client.idea.findFirst({ where: { uuid: ideaUuid, companyUuid } });
    if (idea?.teamEnrollmentVersion === 1 && (idea.teamOwnerUuid || idea.teamLeadAgentUuid)) return false;
  }
  if (notification.entityType === "proposal") {
    for (const source of await getProposalTeamIdeaUuids(companyUuid, notification.entityUuid, client)) {
      const idea = await client.idea.findFirst({ where: { uuid: source, companyUuid } });
      if (idea?.teamEnrollmentVersion === 1 && (idea.teamOwnerUuid || idea.teamLeadAgentUuid)) return false;
    }
  }
  return true;
}

export async function getIdeaTeamActivityFences(companyUuid: string, targetType: string, targetUuid: string, client: ProjectTeamClient = prisma): Promise<IdeaTeamTurnFence[]> {
  let ideaUuids = targetType === "idea" ? [targetUuid] : [];
  if (targetType === "proposal") ideaUuids = await getProposalTeamIdeaUuids(companyUuid, targetUuid, client);
  if (targetType === "task") {
    const task = await client.task.findFirst({ where: { uuid: targetUuid, companyUuid } });
    if (task?.proposalUuid) ideaUuids = await getProposalTeamIdeaUuids(companyUuid, task.proposalUuid, client);
  }
  const fences: IdeaTeamTurnFence[] = [];
  for (const ideaUuid of ideaUuids) {
    const idea = await loadIdea(companyUuid, ideaUuid, client);
    if (idea.teamEnrollmentVersion !== 1 || !idea.teamOwnerUuid || !idea.teamLeadAgentUuid) continue;
    const fence = { ideaUuid, generation: idea.teamGeneration, ownerUuid: idea.teamOwnerUuid };
    fences.push({ ...fence, agentUuid: idea.teamLeadAgentUuid, role: "orchestrator" });
    if (idea.teamProductAgentUuid) fences.push({ ...fence, agentUuid: idea.teamProductAgentUuid, role: "product" });
  }
  return fences;
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
    if (identity.actorUuid !== state.idea.teamLeadAgentUuid && !await isIdeaTeamProductDelegate(companyUuid, ideaUuid, identity.actorUuid, client, actor)) forbidden("Only the current orchestrator or eligible product delegate can author this Idea's proposal");
    await assertIdeaTeamCurrentTurn(companyUuid, ideaUuid, actor!, client);
    const agent = await client.agent.findFirst({ where: { uuid: identity.actorUuid, companyUuid } });
    if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has("proposal:write")) forbidden("Proposal write permission required; ask a human to authorize this action");
  }
}

export async function delegateIdeaTeamProduct(auth: AuthContext, ideaUuid: string, agentUuid: string): Promise<IdeaTeamContextDto> {
  const committed = await projectTeamTransaction(async (client) => {
    const identity = await authorizedRead(auth, ideaUuid, client);
    const state = await teamState(auth.companyUuid, ideaUuid, client);
    if (!state.active) forbidden(state.reason ?? "Idea is not Team managed");
    if (identity.type === "agent") {
      const agent = await client.agent.findFirst({ where: { uuid: identity.actorUuid, companyUuid: auth.companyUuid } });
      if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has("idea:write")) forbidden("Idea write permission required");
      await assertIdeaTeamCurrentTurn(auth.companyUuid, ideaUuid, { actorType: identity.type, actorUuid: identity.actorUuid, ...auth.ideaTeamTurn }, client);
    }
    if (identity.type === "agent" ? identity.actorUuid !== state.idea.teamLeadAgentUuid : !levelAtLeast((await computeProjectAccess(identity, state.idea.projectUuid, client)).level, identity.actorUuid === state.idea.teamOwnerUuid ? "editor" : "admin")) forbidden("Only the current lead, Team owner or a project admin can delegate product work");
    const member = state.team?.roles.product.find((candidate) => candidate.agentUuid === agentUuid && candidate.eligible);
    if (!member) forbidden("Product delegate is not eligible");
    if (state.idea.teamProductAgentUuid === agentUuid && state.idea.teamEnrollmentVersion !== 1) return null;
    await client.idea.update({ where: { uuid: ideaUuid }, data: { teamProductAgentUuid: agentUuid, ...(state.idea.teamEnrollmentVersion === 1 ? { teamGeneration: { increment: 1 } } : {}) } });
    const content = `@[${member.agentName}](agent:${agentUuid}) Product delegation for this Idea: fetch its Team context, elaborate and author/submit the proposal without claiming the Idea. Preserve lead ownership; do not resolve elaboration, approve proposals or verify tasks.`;
    const comment = await client.comment.create({ data: { companyUuid: auth.companyUuid, targetType: "idea", targetUuid: ideaUuid, content, authorType: identity.type, authorUuid: identity.actorUuid } });
    const activity = await createActivityInTx(client, { companyUuid: auth.companyUuid, projectUuid: state.idea.projectUuid, targetType: "idea", targetUuid: ideaUuid, actorType: identity.type, actorUuid: identity.actorUuid, action: "product_delegated", value: { agentUuid, commentUuid: comment.uuid } });
    return { comment, activity, projectUuid: state.idea.projectUuid, title: state.idea.title, legacy: state.idea.teamEnrollmentVersion !== 1 };
  });
  if (committed) {
    committed.activity.publish();
    if (committed.legacy) await createMentions({ companyUuid: auth.companyUuid, projectUuid: committed.projectUuid, sourceType: "comment", sourceUuid: committed.comment.uuid, content: committed.comment.content, actorType: auth.type, actorUuid: auth.actorUuid, entityTitle: committed.title });
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
    await assertIdeaTeamCurrentTurn(companyUuid, ideaUuid, actor!, client);
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
  if (!online.length) {
    if (!state.lead?.eligible || !state.lead.online) return result("manual", "role_and_lead_offline", eligible);
    const agent = await prisma.agent.findFirst({ where: { uuid: state.lead.agentUuid, companyUuid: auth.companyUuid, ownerUuid: state.idea.teamOwnerUuid } });
    const roleEligibility = getAgentTeamRoleEligibility(role, agent ? computeEffectivePermissions(agent.roles, agent.permissions) : []);
    const hasProjectAccess = Boolean(agent && levelAtLeast((await computeProjectAccess({ type: "agent", actorUuid: agent.uuid, companyUuid: auth.companyUuid, ownerUuid: agent.ownerUuid ?? undefined }, state.idea.projectUuid, prisma)).level, "editor"));
    const fallback = { ...state.lead, ...roleEligibility, hasProjectAccess, eligible: roleEligibility.eligible && hasProjectAccess };
    if (!fallback.eligible) return result("manual", "role_offline_orchestrator_ineligible", [...eligible, fallback]);
    return result("recommended", "role_offline_lead_fallback", [fallback], fallback.agentUuid);
  }
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
