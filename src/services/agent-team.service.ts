import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { AGENT_TEAM_ROLES, getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import type { AuthContext } from "@/types/auth";
import type { AgentTeamCandidateDto, AgentTeamDto, AgentTeamMemberInput, AgentTeamRole } from "@/types/agent-team";
import type { ErrorCodeType } from "@/lib/api-response";
import { effectiveProjectTeamRoles, projectTeamRoles } from "@/lib/project-team-roles";

export class AgentTeamError extends Error {
  constructor(public code: ErrorCodeType, message: string, public details?: unknown) {
    super(message);
  }
}

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
const membersSchema = z.array(z.object({
  role: z.enum(AGENT_TEAM_ROLES),
  agentUuid: uuidSchema,
}).strict()).max(200).superRefine((members, context) => {
  const tuples = new Set<string>();
  for (const member of members) {
    const key = tupleKey(member);
    if (tuples.has(key)) context.addIssue({ code: "custom", message: "Duplicate role-agent binding" });
    tuples.add(key);
  }
});
const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000),
  members: membersSchema,
};
const createSchema = z.object({
  name: fields.name,
  description: fields.description.default(""),
  members: membersSchema.default([]),
}).strict();
const updateSchema = z.object(fields).partial().strict().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "Provide at least one field",
);

function parseInput<Output>(schema: z.ZodType<Output>, input: unknown): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AgentTeamError("VALIDATION_ERROR", "Validation failed", result.error.issues);
  }
  return result.data;
}

function scopeFor(auth: AuthContext) {
  if (auth.type !== "user") throw new AgentTeamError("FORBIDDEN", "Only users can manage agent teams");
  return { companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid };
}

type Scope = ReturnType<typeof scopeFor>;
type TeamDb = Pick<typeof prisma, "agent" | "agentTeam" | "agentTeamMember" | "projectAgentTeam">;

const agentSelect = { uuid: true, name: true, roles: true, permissions: true } as const;

function teamInclude(scope: Scope) {
  return {
    members: {
      where: { agent: scope },
      include: { agent: { select: agentSelect } },
      orderBy: [{ role: "asc" }, { agentUuid: "asc" }],
    },
  } satisfies Prisma.AgentTeamInclude;
}

async function requireTeam(client: TeamDb, scope: Scope, uuid: string) {
  const parsed = uuidSchema.safeParse(uuid);
  const team = parsed.success ? await client.agentTeam.findFirst({
    where: { uuid: parsed.data, ...scope },
    include: teamInclude(scope),
  }) : null;
  if (!team) throw new AgentTeamError("NOT_FOUND", "Agent team not found");
  return team;
}

function toDto(team: Awaited<ReturnType<typeof requireTeam>>): AgentTeamDto {
  return {
    uuid: team.uuid,
    companyUuid: team.companyUuid,
    ownerUuid: team.ownerUuid,
    name: team.name,
    description: team.description,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
    members: team.members.map((member) => ({
      role: member.role as AgentTeamRole,
      agentUuid: member.agentUuid,
      agentName: member.agent.name,
      ...getAgentTeamRoleEligibility(member.role as AgentTeamRole,
        computeEffectivePermissions(member.agent.roles, member.agent.permissions)),
    })),
  };
}

function tupleKey(member: { role: string; agentUuid: string }) {
  return `${member.role}:${member.agentUuid}`;
}

async function validateMembers(
  client: TeamDb,
  scope: Scope,
  members: AgentTeamMemberInput[],
  retained = new Set<string>(),
) {
  const agentUuids = [...new Set(members.map((member) => member.agentUuid))];
  const agents = await client.agent.findMany({
    where: { ...scope, uuid: { in: agentUuids } },
    select: agentSelect,
  });
  if (agents.length !== agentUuids.length) {
    throw new AgentTeamError("VALIDATION_ERROR", "Invalid team members");
  }
  const effective = new Map(agents.map((agent) => [agent.uuid,
    computeEffectivePermissions(agent.roles, agent.permissions)]));
  const invalid = members.flatMap((member) => {
    if (retained.has(tupleKey(member))) return [];
    const { eligible, missingPermissions } = getAgentTeamRoleEligibility(member.role, effective.get(member.agentUuid)!);
    return eligible ? [] : [{ ...member, missingPermissions }];
  });
  if (invalid.length) {
    throw new AgentTeamError("VALIDATION_ERROR", "Members lack required permissions", { members: invalid });
  }
}

async function serialTransaction<Result>(work: (client: TeamDb) => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt < 3 && typeof error === "object" && error !== null && "code" in error && error.code === "P2034") continue;
      throw error;
    }
  }
}

export async function listAgentTeams(auth: AuthContext) {
  const scope = scopeFor(auth);
  const teams = await prisma.agentTeam.findMany({
    where: scope,
    include: teamInclude(scope),
    orderBy: [{ updatedAt: "desc" }, { uuid: "asc" }],
  });
  return teams.map(toDto);
}

export async function getAgentTeam(auth: AuthContext, uuid: string) {
  return toDto(await requireTeam(prisma, scopeFor(auth), uuid));
}

export async function listAgentTeamCandidates(auth: AuthContext): Promise<AgentTeamCandidateDto[]> {
  const agents = await prisma.agent.findMany({
    where: scopeFor(auth), select: agentSelect, orderBy: [{ name: "asc" }, { uuid: "asc" }],
  });
  return agents.map((agent) => ({
    uuid: agent.uuid, name: agent.name,
    effectivePermissions: [...computeEffectivePermissions(agent.roles, agent.permissions)],
  }));
}

export async function createAgentTeam(auth: AuthContext, input: unknown) {
  const scope = scopeFor(auth);
  const body = parseInput(createSchema, input);
  return serialTransaction(async (client) => {
    await validateMembers(client, scope, body.members);
    const team = await client.agentTeam.create({
      data: { ...scope, name: body.name, description: body.description, members: { create: body.members } },
      include: teamInclude(scope),
    });
    return toDto(team);
  });
}

export async function updateAgentTeam(auth: AuthContext, uuid: string, input: unknown) {
  const scope = scopeFor(auth);
  return serialTransaction(async (client) => {
    const team = await requireTeam(client, scope, uuid);
    const body = parseInput(updateSchema, input);
    if (body.members !== undefined) {
      await validateMembers(client, scope, body.members, new Set(team.members.map(tupleKey)));
      await client.agentTeamMember.deleteMany({ where: { teamUuid: team.uuid, team: scope } });
    }
    const updated = await client.agentTeam.update({
      where: { uuid: team.uuid, ...scope },
      data: {
        name: body.name,
        description: body.description,
        members: body.members === undefined ? undefined : { create: body.members },
      },
      include: teamInclude(scope),
    });
    return toDto(updated);
  });
}

export async function deleteAgentTeam(auth: AuthContext, uuid: string) {
  const scope = scopeFor(auth);
  return serialTransaction(async (client) => {
    const team = await requireTeam(client, scope, uuid);
    const configs = await client.projectAgentTeam.findMany({ where: { ...scope, templateUuid: team.uuid } });
    for (const config of configs) {
      await client.projectAgentTeam.update({
        where: { uuid: config.uuid },
        data: { templateUuid: null, templateName: team.name,
          snapshot: effectiveProjectTeamRoles(projectTeamRoles(team.members), config.overrides), revision: { increment: 1 } },
      });
    }
    await client.agentTeam.delete({ where: { uuid: team.uuid, ...scope } });
    return { deleted: true };
  });
}
