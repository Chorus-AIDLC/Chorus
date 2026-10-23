import type { AgentTeamRole } from "@/lib/agent-team-roles";
import type { ProjectTeamMember } from "@/types/project-agent-team";

export type IdeaTeamRoutingRole = "product" | "development";

export interface IdeaTeamContextDto {
  ideaUuid: string;
  managed: boolean;
  state: "active" | "paused" | "unmanaged";
  lead: { agentUuid: string; agentName: string } | null;
  yolo: boolean;
  proposalGate: "human" | "lead";
  taskGate: "human" | "lead";
  reason: string | null;
  routing: {
    ownerUuid: string;
    productAgentUuid: string | null;
    roles: Record<AgentTeamRole, ProjectTeamMember[]>;
  } | null;
}

export interface IdeaTeamRecommendationDto {
  decision: "recommended" | "lead_decision" | "manual" | "paused";
  agentUuid: string | null;
  candidates: ProjectTeamMember[];
  reason: string;
}

export interface IdeaTeamActorContext {
  actorType: string;
  actorUuid: string;
}
