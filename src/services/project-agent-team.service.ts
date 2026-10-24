import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AGENT_TEAM_ROLES, getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import type { ErrorCodeType } from "@/lib/api-response";
import type { AuthContext } from "@/types/auth";
import type { ProjectAgentTeamDto, ProjectTeamOverrides } from "@/types/project-agent-team";
import { computeProjectAccess, levelAtLeast } from "@/services/project-access.service";
import { enrichAgentLiveness, type Mentionable } from "@/services/mention.service";
import { effectiveProjectTeamRoles, projectTeamRoles, projectTeamOverridesSchema as overridesSchema, projectTeamUuid as uuid } from "@/lib/project-team-roles";

export type ProjectTeamClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export class ProjectTeamError extends Error {
  constructor(public code: ErrorCodeType, message: string, public details?: unknown) {
    super(message);
  }
}

const saveSchema = z.object({ templateUuid: uuid.nullable(), overrides: overridesSchema.default({}) }).strict();

async function scopeFor(auth: AuthContext, projectUuid: string, client: ProjectTeamClient, write = false) {
  if (write && auth.type !== "user") throw new ProjectTeamError("FORBIDDEN", "Only users can configure project teams");
  const ownerUuid = auth.type === "user" ? auth.actorUuid : auth.type === "agent" ? auth.ownerUuid : undefined;
  if (!uuid.safeParse(projectUuid).success) throw new ProjectTeamError("NOT_FOUND", "Project not found");
  const access = await computeProjectAccess(auth, projectUuid, client);
  if (!levelAtLeast(access.level, "viewer")) throw new ProjectTeamError("NOT_FOUND", "Project not found");
  return ownerUuid ? { companyUuid: auth.companyUuid, ownerUuid, projectUuid } : null;
}

async function loadTeam(auth: AuthContext, projectUuid: string, client: ProjectTeamClient) {
  const scope = await scopeFor(auth, projectUuid, client);
  if (!scope) return null;
  const config = await client.projectAgentTeam.findFirst({ where: scope });
  if (!config) return null;
  const template = config.templateUuid ? await client.agentTeam.findFirst({
    where: { uuid: config.templateUuid, companyUuid: scope.companyUuid, ownerUuid: scope.ownerUuid },
    include: { members: true },
  }) : null;
  const effective = effectiveProjectTeamRoles(template ? projectTeamRoles(template.members) : config.snapshot, config.overrides);
  return { scope, config, template, effective };
}

export async function getProjectAgentTeam(auth: AuthContext, projectUuid: string, client: ProjectTeamClient = prisma): Promise<ProjectAgentTeamDto | null> {
  const loaded = await loadTeam(auth, projectUuid, client);
  if (!loaded) return null;
  const { scope, config, template, effective } = loaded;
  const memberUuids = [...new Set([...Object.values(effective).flat(), ...(config.lastLeadAgentUuid ? [config.lastLeadAgentUuid] : [])])];
  const agents = await client.agent.findMany({
    where: { companyUuid: scope.companyUuid, ownerUuid: scope.ownerUuid, uuid: { in: memberUuids } },
    select: { uuid: true, name: true, roles: true, permissions: true },
  });
  const liveness: Mentionable[] = agents.map((agent) => ({ uuid: agent.uuid, name: agent.name, type: "agent" }));
  await enrichAgentLiveness(scope.companyUuid, liveness, client);
  const collaborationAccess = levelAtLeast((await computeProjectAccess(auth, projectUuid, client)).level, "editor");
  const roles = Object.fromEntries(AGENT_TEAM_ROLES.map((role) => [role, (effective[role] ?? []).flatMap((agentUuid) => {
    const agent = agents.find((candidate) => candidate.uuid === agentUuid);
    if (!agent) return [];
    const eligibility = getAgentTeamRoleEligibility(role, computeEffectivePermissions(agent.roles, agent.permissions));
    const presence = liveness.find((candidate) => candidate.uuid === agentUuid);
    return [{ agentUuid, agentName: agent.name, ...eligibility, eligible: eligibility.eligible && collaborationAccess,
      hasProjectAccess: collaborationAccess, online: presence?.online ?? false, activeCount: presence?.activeCount ?? 0 }];
  })])) as ProjectAgentTeamDto["roles"];
  let handoffWarning: ProjectAgentTeamDto["handoffWarning"] = null;
  if (config.lastLeadAgentUuid) {
    const agent = agents.find((candidate) => candidate.uuid === config.lastLeadAgentUuid);
    const eligible = agent && computeEffectivePermissions(agent.roles, agent.permissions).has("idea:write")
      && levelAtLeast((await computeProjectAccess({ type: "agent", actorUuid: agent.uuid, ownerUuid: scope.ownerUuid, companyUuid: scope.companyUuid }, projectUuid, client)).level, "editor");
    if (!eligible) handoffWarning = {
      agentUuid: config.lastLeadAgentUuid, agentName: agent?.name ?? null,
      reason: !agent ? "deleted" : "ineligible",
    };
  }
  return {
    projectUuid, templateUuid: template?.uuid ?? null, templateName: template?.name ?? config.templateName,
    frozen: !template, revision: config.revision, overrides: overridesSchema.parse(config.overrides), roles,
    myRoles: auth.type === "agent" ? AGENT_TEAM_ROLES.filter((role) => roles[role].some((member) => member.agentUuid === auth.actorUuid && member.eligible)) : [],
    handoffWarning,
  };
}

export async function projectTeamTransaction<Result>(work: (client: ProjectTeamClient) => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable", timeout: 20_000 });
    } catch (error) {
      if (attempt < 3 && typeof error === "object" && error !== null && "code" in error && error.code === "P2034") continue;
      throw error;
    }
  }
}

export async function saveProjectAgentTeam(auth: AuthContext, projectUuid: string, input: unknown) {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) throw new ProjectTeamError("VALIDATION_ERROR", "Invalid project team", parsed.error.issues);
  return projectTeamTransaction(async (client) => {
    const scope = await scopeFor(auth, projectUuid, client, true);
    if (!scope) throw new ProjectTeamError("FORBIDDEN", "Personal owner required");
    const existing = await loadTeam(auth, projectUuid, client);
    const { templateUuid, overrides } = parsed.data;
    const template = templateUuid ? await client.agentTeam.findFirst({
      where: { uuid: templateUuid, companyUuid: scope.companyUuid, ownerUuid: scope.ownerUuid }, include: { members: true },
    }) : null;
    if (templateUuid && !template) throw new ProjectTeamError("NOT_FOUND", "Template not found");
    if (!template && (!existing || existing.config.templateUuid)) throw new ProjectTeamError("VALIDATION_ERROR", "Choose a template");
    const candidateRoles = effectiveProjectTeamRoles(template ? projectTeamRoles(template.members) : existing!.config.snapshot, overrides);
    const memberUuids = [...new Set(Object.values(candidateRoles).flat())];
    const agents = await client.agent.findMany({ where: { companyUuid: scope.companyUuid, ownerUuid: scope.ownerUuid, uuid: { in: memberUuids } } });
    const ownedAgentUuids = new Set(agents.map((agent) => agent.uuid));
    const submittedMemberUuids = template ? memberUuids : Object.values(overrides).flat();
    if (submittedMemberUuids.some((agentUuid) => !ownedAgentUuids.has(agentUuid))) throw new ProjectTeamError("VALIDATION_ERROR", "Invalid team members");
    const retainOwned = (roles: ProjectTeamOverrides): ProjectTeamOverrides => Object.fromEntries(
      Object.entries(roles).map(([role, members]) => [role, members.filter((agentUuid) => ownedAgentUuids.has(agentUuid))]),
    );
    const effective = retainOwned(candidateRoles);
    const retained = existing && existing.config.templateUuid === templateUuid ? retainOwned(existing.effective) : {};
    const access = await computeProjectAccess(auth, projectUuid, client);
    for (const role of AGENT_TEAM_ROLES) {
      for (const agentUuid of effective[role] ?? []) {
        if (retained[role]?.includes(agentUuid)) continue;
        const agent = agents.find((candidate) => candidate.uuid === agentUuid)!;
        const eligibility = getAgentTeamRoleEligibility(role, computeEffectivePermissions(agent.roles, agent.permissions));
        if (!eligibility.eligible || !levelAtLeast(access.level, "editor")) {
          throw new ProjectTeamError("VALIDATION_ERROR", "Member is not eligible for this project role", { agentUuid, role, missingPermissions: eligibility.missingPermissions });
        }
      }
    }
    await client.projectAgentTeam.upsert({
      where: { projectUuid_ownerUuid: { projectUuid, ownerUuid: scope.ownerUuid } },
      create: { ...scope, templateUuid, templateName: template?.name ?? existing!.config.templateName, overrides, snapshot: effective },
      update: { templateUuid, templateName: template?.name ?? existing!.config.templateName, overrides, snapshot: effective, revision: { increment: 1 } },
    });
    return getProjectAgentTeam(auth, projectUuid, client);
  });
}

export async function deleteProjectAgentTeam(auth: AuthContext, projectUuid: string) {
  return projectTeamTransaction(async (client) => {
    const scope = await scopeFor(auth, projectUuid, client, true);
    if (!scope) throw new ProjectTeamError("FORBIDDEN", "Personal owner required");
    await client.projectAgentTeam.deleteMany({ where: scope });
    return { deleted: true };
  });
}
