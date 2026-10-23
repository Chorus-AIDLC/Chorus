import type { AgentTeamRole } from "@/lib/agent-team-roles";
import type { Permission } from "@/lib/authz/types";

export type { AgentTeamRole } from "@/lib/agent-team-roles";

export interface AgentTeamMemberInput {
  role: AgentTeamRole;
  agentUuid: string;
}

export interface AgentTeamMemberDto extends AgentTeamMemberInput {
  agentName: string;
  eligible: boolean;
  missingPermissions: Permission[];
}

export interface AgentTeamDto {
  uuid: string;
  companyUuid: string;
  ownerUuid: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  members: AgentTeamMemberDto[];
}

export interface AgentTeamCandidateDto {
  uuid: string;
  name: string;
  effectivePermissions: Permission[];
}

export interface CreateAgentTeamInput {
  name: string;
  description?: string;
  members?: AgentTeamMemberInput[];
}

export interface UpdateAgentTeamInput {
  name?: string;
  description?: string;
  members?: AgentTeamMemberInput[];
}
