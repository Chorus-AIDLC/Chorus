// Idea Team orchestration (Agent Team ③).
//
// Zero-schema design: whether an Idea is Team-managed is DERIVED at read time from
// data that already exists — the Idea's assignment provenance (assignedByType /
// assignedByUuid / assignedAt), the assignee agent's owner, the owner's personal
// ProjectAgentTeam binding, the Idea lineage (parentUuid) and activities
// (yolo_requested, product_delegated). Nothing is enrolled or migrated.
//
// An Idea is managed when its logical agent assignee A (owner O) was assigned
//   - by O themself (a human), or
//   - by one of O's agents, under a managed parent Idea of the same owner
//     (theme/child delegation inherits the root human authorization),
// after O bound a Team to the project. A is then the Idea's orchestrator.
// Unbinding the Team, reassignment to a human, release, or an assignment by anyone
// else returns the Idea to the legacy (unmanaged) workflow.

import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import type { AuthContext } from "@/types/auth";
import type { ProjectAgentTeamDto, ProjectTeamMember } from "@/types/project-agent-team";
import type { IdeaTeamContextDto, IdeaTeamPauseReason, IdeaTeamRecommendationDto, IdeaTeamRoutingRole } from "@/types/idea-team";
import { computeProjectAccess, levelAtLeast } from "./project-access.service";
import { getProjectAgentTeam, type ProjectTeamClient } from "./project-agent-team.service";
import { createActivity } from "./activity.service";
import { createComment } from "./comment.service";

const MAX_LINEAGE_DEPTH = 10;

export interface IdeaTeamActor {
  actorType: string;
  actorUuid: string;
}

interface IdeaTeamState {
  ideaUuid: string;
  projectUuid: string;
  title: string;
  managed: boolean;
  active: boolean;
  reason: IdeaTeamPauseReason | null;
  ownerUuid: string | null;
  orchestratorUuid: string | null;
  team: ProjectAgentTeamDto | null;
  yolo: boolean;
  productAgentUuid: string | null;
}

function forbidden(reason: string): never {
  throw new ApiError("FORBIDDEN", reason, 403);
}

async function logicalAgentUuid(companyUuid: string, type: string | null, uuid: string | null, client: ProjectTeamClient) {
  if (!type || !uuid) return null;
  if (type === "agent") return uuid;
  if (type !== "agent_instance") return null;
  return (await client.agentInstance.findFirst({ where: { uuid, companyUuid }, select: { agentUuid: true } }))?.agentUuid ?? null;
}

async function agentEligibleForIdea(companyUuid: string, agentUuid: string, projectUuid: string, client: ProjectTeamClient) {
  const agent = await client.agent.findFirst({ where: { uuid: agentUuid, companyUuid } });
  if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has("idea:write")) return false;
  const auth: AuthContext = { type: "agent", companyUuid, actorUuid: agent.uuid, ownerUuid: agent.ownerUuid ?? undefined };
  return levelAtLeast((await computeProjectAccess(auth, projectUuid, client)).level, "editor");
}

/** Cheap fast path: a project with no personal Team bindings has no managed Ideas. */
async function projectHasTeams(companyUuid: string, projectUuid: string, client: ProjectTeamClient) {
  return (await client.projectAgentTeam.count({ where: { companyUuid, projectUuid } })) > 0;
}

async function resolveState(companyUuid: string, ideaUuid: string, client: ProjectTeamClient, depth = 0): Promise<IdeaTeamState | null> {
  const idea = await client.idea.findFirst({ where: { uuid: ideaUuid, companyUuid } });
  if (!idea) return null;
  const unmanaged: IdeaTeamState = {
    ideaUuid, projectUuid: idea.projectUuid, title: idea.title, managed: false, active: false, reason: null,
    ownerUuid: null, orchestratorUuid: null, team: null, yolo: false, productAgentUuid: null,
  };
  const orchestratorUuid = await logicalAgentUuid(companyUuid, idea.assigneeType, idea.assigneeUuid, client);
  if (!orchestratorUuid || !idea.assignedAt || !idea.assignedByUuid) return unmanaged;
  const agent = await client.agent.findFirst({ where: { uuid: orchestratorUuid, companyUuid }, select: { ownerUuid: true } });
  const ownerUuid = agent?.ownerUuid;
  if (!ownerUuid) return unmanaged;

  let authorized = idea.assignedByType === "user" && idea.assignedByUuid === ownerUuid;
  if (!authorized && idea.assignedByType === "agent" && idea.parentUuid && depth < MAX_LINEAGE_DEPTH) {
    const assigner = await client.agent.findFirst({ where: { uuid: idea.assignedByUuid, companyUuid }, select: { ownerUuid: true } });
    const parent = assigner?.ownerUuid === ownerUuid ? await resolveState(companyUuid, idea.parentUuid, client, depth + 1) : null;
    authorized = Boolean(parent?.managed && parent.ownerUuid === ownerUuid);
  }
  if (!authorized) return unmanaged;

  const binding = await client.projectAgentTeam.findFirst({ where: { companyUuid, projectUuid: idea.projectUuid, ownerUuid }, select: { createdAt: true } });
  // Only assignments made after the owner bound a Team opt into automation; earlier
  // assignments (and every Idea once the Team is unbound) keep the legacy workflow.
  if (!binding || idea.assignedAt < binding.createdAt) return unmanaged;
  const team = await getProjectAgentTeam({ type: "user", companyUuid, actorUuid: ownerUuid }, idea.projectUuid, client);
  if (!team) return unmanaged;

  const eligible = await agentEligibleForIdea(companyUuid, orchestratorUuid, idea.projectUuid, client);
  const yolo = (await client.activity.count({ where: { companyUuid, targetType: "idea", targetUuid: ideaUuid, action: "yolo_requested", actorType: "user" } })) > 0;
  const delegation = await client.activity.findFirst({
    where: { companyUuid, targetType: "idea", targetUuid: ideaUuid, action: "product_delegated", createdAt: { gte: idea.assignedAt } },
    orderBy: { createdAt: "desc" }, select: { value: true },
  });
  const delegated = delegation?.value && typeof delegation.value === "object" && !Array.isArray(delegation.value) && typeof (delegation.value as Record<string, unknown>).agentUuid === "string"
    ? (delegation.value as Record<string, string>).agentUuid : null;
  const productAgentUuid = delegated && team.roles.product.some((member) => member.agentUuid === delegated && member.eligible) ? delegated : null;
  return {
    ...unmanaged, managed: true, active: eligible, reason: eligible ? null : "orchestrator_ineligible",
    ownerUuid, orchestratorUuid, team, yolo, productAgentUuid,
  };
}

async function actorIdentity(companyUuid: string, actor: IdeaTeamActor | undefined, client: ProjectTeamClient): Promise<AuthContext | null> {
  if (!actor) return null;
  if (actor.actorType === "unknown") {
    const isAgent = await client.agent.findFirst({ where: { uuid: actor.actorUuid, companyUuid }, select: { uuid: true } });
    return actorIdentity(companyUuid, { actorType: isAgent ? "agent" : "user", actorUuid: actor.actorUuid }, client);
  }
  if (actor.actorType === "user") {
    const user = await client.user.findFirst({ where: { uuid: actor.actorUuid, companyUuid, status: "active", deletedAt: null }, select: { uuid: true } });
    return user ? { type: "user", companyUuid, actorUuid: user.uuid } : null;
  }
  if (actor.actorType === "agent") {
    const agent = await client.agent.findFirst({ where: { uuid: actor.actorUuid, companyUuid }, select: { uuid: true, ownerUuid: true } });
    return agent ? { type: "agent", companyUuid, actorUuid: agent.uuid, ownerUuid: agent.ownerUuid ?? undefined } : null;
  }
  return null;
}

/**
 * The source Ideas behind a proposal, following document inputs back to the
 * proposals that produced them. Returns null when the ancestry is broken/ambiguous.
 */
async function proposalSourceIdeas(companyUuid: string, proposalUuid: string, client: ProjectTeamClient): Promise<string[] | null> {
  const ideas = new Set<string>();
  const visited = new Set<string>();
  const pending = [proposalUuid];
  while (pending.length) {
    const uuid = pending.pop()!;
    if (visited.has(uuid)) continue;
    visited.add(uuid);
    const proposal = await client.proposal.findFirst({ where: { uuid, companyUuid }, select: { inputType: true, inputUuids: true } });
    const inputs = proposal?.inputUuids;
    if (!proposal || !Array.isArray(inputs) || inputs.some((input) => typeof input !== "string")) return null;
    if (proposal.inputType === "idea") {
      const found = await client.idea.count({ where: { companyUuid, uuid: { in: inputs as string[] } } });
      if (found !== new Set(inputs).size) return null;
      for (const input of inputs as string[]) ideas.add(input);
    } else if (proposal.inputType === "document") {
      const documents = await client.document.findMany({ where: { companyUuid, uuid: { in: inputs as string[] } }, select: { proposalUuid: true } });
      if (documents.length !== new Set(inputs).size) return null;
      for (const document of documents) if (document.proposalUuid) pending.push(document.proposalUuid);
    } else return null;
  }
  return [...ideas];
}

/**
 * Server-enforced Team gate for proposal approval and task verification/close.
 * Humans with editor access always pass (they keep existing control). For an agent,
 * every managed source Idea must be active and the agent must be its current
 * orchestrator with the action permission; proposal approval also needs human YOLO.
 */
export async function assertIdeaTeamGate(companyUuid: string, proposalUuid: string, gate: "proposal" | "task", actor: IdeaTeamActor | undefined, client: ProjectTeamClient = prisma) {
  const proposal = await client.proposal.findFirst({ where: { uuid: proposalUuid, companyUuid }, select: { projectUuid: true } });
  if (!proposal || !await projectHasTeams(companyUuid, proposal.projectUuid, client)) return;
  if (actor?.actorType === "super_admin") return;
  const identity = await actorIdentity(companyUuid, actor, client);
  if (identity?.type === "user") return;
  const sources = await proposalSourceIdeas(companyUuid, proposalUuid, client);
  if (!sources) forbidden("Idea Team gate: proposal ancestry is missing or ambiguous; a human must act");
  for (const ideaUuid of sources) {
    const state = await resolveState(companyUuid, ideaUuid, client);
    if (!state?.managed) continue;
    if (!identity) forbidden("Idea Team gate: an authenticated actor is required");
    if (!state.active) forbidden(`Idea Team gate: automation is paused (${state.reason}); a human must act`);
    if (identity.actorUuid !== state.orchestratorUuid) forbidden("Idea Team gate: only the Idea's current assignee can pass this gate");
    const agent = await client.agent.findFirst({ where: { uuid: identity.actorUuid, companyUuid }, select: { roles: true, permissions: true } });
    if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has(gate === "proposal" ? "proposal:admin" : "task:admin")) forbidden("Idea Team gate: action permission required");
    if (gate === "proposal" && !state.yolo) forbidden("Idea Team gate: proposal approval requires a human unless a human requested YOLO for this Idea");
  }
}

/** True when the agent is the current, eligible product delegate of an active managed Idea. */
export async function isIdeaTeamProductDelegate(companyUuid: string, ideaUuid: string, agentUuid: string, client: ProjectTeamClient = prisma) {
  const state = await resolveState(companyUuid, ideaUuid, client);
  return Boolean(state?.active && state.productAgentUuid === agentUuid);
}

/** Current orchestrators of the managed Ideas behind an idea/proposal/task (for lifecycle handoff wakes). */
export async function getIdeaTeamOrchestrators(companyUuid: string, targetType: string, targetUuid: string, client: ProjectTeamClient = prisma): Promise<{ ideaUuid: string; agentUuid: string }[]> {
  let ideaUuids: string[] = [];
  if (targetType === "idea") ideaUuids = [targetUuid];
  else {
    const proposalUuid = targetType === "proposal" ? targetUuid
      : targetType === "task" ? (await client.task.findFirst({ where: { uuid: targetUuid, companyUuid }, select: { proposalUuid: true } }))?.proposalUuid : null;
    if (!proposalUuid) return [];
    const proposal = await client.proposal.findFirst({ where: { uuid: proposalUuid, companyUuid }, select: { projectUuid: true } });
    if (!proposal || !await projectHasTeams(companyUuid, proposal.projectUuid, client)) return [];
    ideaUuids = await proposalSourceIdeas(companyUuid, proposalUuid, client) ?? [];
  }
  const result: { ideaUuid: string; agentUuid: string }[] = [];
  for (const ideaUuid of ideaUuids) {
    const state = await resolveState(companyUuid, ideaUuid, client);
    if (state?.active && state.orchestratorUuid) result.push({ ideaUuid, agentUuid: state.orchestratorUuid });
  }
  return result;
}

async function readableState(auth: AuthContext, ideaUuid: string) {
  const idea = await prisma.idea.findFirst({ where: { uuid: ideaUuid, companyUuid: auth.companyUuid }, select: { projectUuid: true } });
  if (!idea || !levelAtLeast((await computeProjectAccess(auth, idea.projectUuid)).level, "viewer")) throw new ApiError("NOT_FOUND", "Idea not found", 404);
  const state = await resolveState(auth.companyUuid, ideaUuid, prisma);
  if (!state) throw new ApiError("NOT_FOUND", "Idea not found", 404);
  return state;
}

function callerOwnerUuid(auth: AuthContext) {
  return auth.type === "user" ? auth.actorUuid : auth.type === "agent" ? auth.ownerUuid ?? null : null;
}

export async function getIdeaTeamContext(auth: AuthContext, ideaUuid: string): Promise<IdeaTeamContextDto> {
  const state = await readableState(auth, ideaUuid);
  const orchestrator = state.orchestratorUuid && state.managed
    ? await prisma.agent.findFirst({ where: { uuid: state.orchestratorUuid, companyUuid: auth.companyUuid }, select: { uuid: true, name: true } })
    : null;
  const owner = state.managed && callerOwnerUuid(auth) === state.ownerUuid;
  return {
    ideaUuid,
    managed: state.managed,
    state: !state.managed ? "unmanaged" : state.active ? "active" : "paused",
    reason: state.reason,
    orchestrator: orchestrator ? { agentUuid: orchestrator.uuid, agentName: orchestrator.name } : null,
    yolo: state.yolo,
    proposalGate: state.managed && state.active && state.yolo ? "orchestrator" : "human",
    taskGate: state.managed && state.active ? "orchestrator" : "human",
    routing: owner && state.team && state.ownerUuid ? { ownerUuid: state.ownerUuid, productAgentUuid: state.productAgentUuid, roles: state.team.roles } : null,
  };
}

/**
 * The current orchestrator (or its owner) records a product delegation for an
 * active managed Idea and @mentions the delegate, which wakes it. The orchestrator
 * stays the Idea's sole assignee.
 */
export async function delegateIdeaTeamProduct(auth: AuthContext, ideaUuid: string, agentUuid: string): Promise<IdeaTeamContextDto> {
  const state = await readableState(auth, ideaUuid);
  if (!state.active) forbidden(state.managed ? `Idea Team automation is paused (${state.reason})` : "Idea is not Team-managed");
  if (!(auth.type === "agent" ? auth.actorUuid === state.orchestratorUuid : auth.type === "user" && auth.actorUuid === state.ownerUuid)) {
    forbidden("Only the Idea's current assignee or its Team owner can delegate product work");
  }
  const member = state.team?.roles.product.find((candidate) => candidate.agentUuid === agentUuid && candidate.eligible);
  if (!member) forbidden("Product delegate must be an eligible product member of the owner's Team");
  if (state.productAgentUuid !== agentUuid) {
    await createActivity({ companyUuid: auth.companyUuid, projectUuid: state.projectUuid, targetType: "idea", targetUuid: ideaUuid,
      actorType: auth.type, actorUuid: auth.actorUuid, action: "product_delegated", value: { agentUuid } });
    await createComment({ companyUuid: auth.companyUuid, targetType: "idea", targetUuid: ideaUuid, authorType: auth.type === "agent" ? "agent" : "user", authorUuid: auth.actorUuid,
      content: `@[${member.agentName}](agent:${agentUuid}) Product delegation: call chorus_get_idea_team_context, elaborate this Idea and author/submit its proposal. Do not claim, release or reassign the Idea, resolve elaboration, approve proposals or verify tasks.` });
  }
  return getIdeaTeamContext(auth, ideaUuid);
}

export async function recommendIdeaTeamRole(auth: AuthContext, ideaUuid: string, role: IdeaTeamRoutingRole, taskUuid?: string): Promise<IdeaTeamRecommendationDto> {
  const state = await readableState(auth, ideaUuid);
  const result = (decision: IdeaTeamRecommendationDto["decision"], reason: string, candidates: ProjectTeamMember[] = [], agentUuid: string | null = null) => ({ decision, reason, candidates, agentUuid });
  if (!state.managed) return result("manual", "unmanaged");
  if (callerOwnerUuid(auth) !== state.ownerUuid) forbidden("Private Team routing is owner-only");
  if (!state.active || !state.team) return result("paused", state.reason ?? "paused");
  const task = taskUuid ? await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid: auth.companyUuid, projectUuid: state.projectUuid } }) : null;
  if (taskUuid && (!task?.proposalUuid || !(await proposalSourceIdeas(auth.companyUuid, task.proposalUuid, prisma))?.includes(ideaUuid))) forbidden("Task does not belong to this Idea");

  const eligible = state.team.roles[role].filter((member) => member.eligible);
  if (!eligible.length) return result("manual", "role_empty_or_ineligible");
  const online = eligible.filter((member) => member.online);
  if (!online.length) {
    // Offline role members fall back to the orchestrator only when it is online and qualifies for the role.
    const orchestrator = state.orchestratorUuid ? await prisma.agent.findFirst({ where: { uuid: state.orchestratorUuid, companyUuid: auth.companyUuid } }) : null;
    const qualifies = orchestrator && getAgentTeamRoleEligibility(role, computeEffectivePermissions(orchestrator.roles, orchestrator.permissions)).eligible;
    const fallback = qualifies ? state.team.roles.lead.concat(state.team.roles[role]).find((member) => member.agentUuid === orchestrator!.uuid && member.online) : null;
    return fallback ? result("recommended", "role_offline_orchestrator_fallback", [fallback], fallback.agentUuid) : result("manual", "role_offline", eligible);
  }
  if (role === "development" && task) {
    const reopened = await prisma.activity.findFirst({ where: { companyUuid: auth.companyUuid, targetType: "task", targetUuid: task.uuid, action: "reopened" } });
    const original = await logicalAgentUuid(auth.companyUuid, task.assigneeType, task.assigneeUuid, prisma);
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
      const edges = await prisma.taskDependency.findMany({ where: { taskUuid: { in: frontier } }, include: { dependsOn: true } });
      frontier = [];
      for (const { dependsOn } of edges) {
        if (dependsOn.companyUuid !== auth.companyUuid || visited.has(dependsOn.uuid)) continue;
        visited.add(dependsOn.uuid);
        frontier.push(dependsOn.uuid);
        const agentUuid = await logicalAgentUuid(auth.companyUuid, dependsOn.assigneeType, dependsOn.assigneeUuid, prisma);
        if (agentUuid) related.add(agentUuid);
      }
    }
    const affinity = candidates.filter((member) => related.has(member.agentUuid));
    if (affinity.length) candidates = affinity;
  }
  return candidates.length === 1
    ? result("recommended", "minimum_load_then_dependency_affinity", candidates, candidates[0].agentUuid)
    : result("lead_decision", "equal_candidates", candidates);
}
