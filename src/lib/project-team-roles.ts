import { z } from "zod";
import { AGENT_TEAM_ROLES } from "@/lib/agent-team-roles";
import type { ProjectTeamOverrides } from "@/types/project-agent-team";

export const projectTeamUuid = z.string().uuid().transform((value) => value.toLowerCase());
const memberList = z.array(projectTeamUuid).max(200).refine((members) => new Set(members).size === members.length, "Duplicate member");
const roleMapSchema = z.object({
  product: memberList.optional(), development: memberList.optional(), review: memberList.optional(), lead: memberList.optional(),
}).strict();
export const projectTeamOverridesSchema = roleMapSchema.refine((roles) => Object.values(roles).reduce((total, members) => total + members.length, 0) <= 200, "Too many members");

export function projectTeamRoles(members: { role: string; agentUuid: string }[]): ProjectTeamOverrides {
  return Object.fromEntries(AGENT_TEAM_ROLES.map((role) => [role, members.filter((member) => member.role === role).map((member) => member.agentUuid)]));
}

export function effectiveProjectTeamRoles(base: unknown, overrides: unknown): ProjectTeamOverrides {
  return { ...roleMapSchema.parse(base), ...projectTeamOverridesSchema.parse(overrides) };
}
