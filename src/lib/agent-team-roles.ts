import type { Permission } from "@/lib/authz/types";

export const AGENT_TEAM_ROLES = ["product", "development", "review", "lead"] as const;
export type AgentTeamRole = (typeof AGENT_TEAM_ROLES)[number];

const READ_PERMISSIONS: readonly Permission[] = [
  "idea:read", "proposal:read", "document:read", "task:read", "project:read",
];

export const AGENT_TEAM_ROLE_DEFINITIONS: Record<AgentTeamRole, {
  requiredPermissions: readonly Permission[];
}> = {
  product: { requiredPermissions: [...READ_PERMISSIONS, "idea:write", "proposal:write", "document:write"] },
  development: { requiredPermissions: [...READ_PERMISSIONS, "task:write"] },
  review: { requiredPermissions: READ_PERMISSIONS },
  lead: { requiredPermissions: [...READ_PERMISSIONS, "idea:write", "idea:admin", "proposal:write", "proposal:admin", "task:write", "task:admin", "document:write"] },
};

export function getAgentTeamRoleEligibility(role: AgentTeamRole, effectivePermissions: Iterable<string>) {
  const permissions = new Set(effectivePermissions);
  const missingPermissions = AGENT_TEAM_ROLE_DEFINITIONS[role].requiredPermissions.filter(
    (permission) => !permissions.has(permission),
  );
  return { eligible: missingPermissions.length === 0, missingPermissions };
}
