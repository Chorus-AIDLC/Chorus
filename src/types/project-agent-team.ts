import type { AgentTeamRole } from "@/lib/agent-team-roles";

export type ProjectTeamOverrides = Partial<Record<AgentTeamRole, string[]>>;
export interface ProjectTeamMember {
  agentUuid: string;
  agentName: string;
  eligible: boolean;
  missingPermissions: string[];
  hasProjectAccess: boolean;
  online: boolean;
  activeCount: number;
}
export interface ProjectAgentTeamDto {
  projectUuid: string;
  templateUuid: string | null;
  templateName: string;
  frozen: boolean;
  revision: number;
  overrides: ProjectTeamOverrides;
  roles: Record<AgentTeamRole, ProjectTeamMember[]>;
  myRoles: AgentTeamRole[];
  handoffWarning: {
    agentUuid: string;
    agentName: string | null;
    reason: "removed_from_lead" | "ineligible" | "deleted";
  } | null;
}
