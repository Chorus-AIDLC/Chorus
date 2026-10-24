import type { AgentTeamRole } from "@/lib/agent-team-roles";
import type { ProjectTeamMember } from "@/types/project-agent-team";

export type IdeaTeamRoutingRole = "product" | "development";

export interface IdeaTeamTurnFence {
  ideaUuid: string;
  generation: number;
  ownerUuid: string;
  agentUuid: string;
  role: "orchestrator" | "product";
}

export interface IdeaTeamTurnContext {
  turnUuid?: string;
  admissionUuid?: string;
  supplementaryTurns?: Array<{ turnUuid: string; admissionUuid: string }>;
}

export interface IdeaTeamContextDto {
  ideaUuid: string;
  managed: boolean;
  state: "active" | "paused" | "unmanaged";
  lead: { agentUuid: string; agentName: string } | null;
  orchestrator?: { agentUuid: string; agentName: string } | null;
  enrollmentVersion?: number;
  generation?: number;
  canAuthorizeAssignment?: boolean;
  yolo: boolean;
  proposalGate: "human" | "lead";
  taskGate: "human" | "lead";
  proposalGateReason?: string | null;
  taskGateReason?: string | null;
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

export interface IdeaTeamActorContext extends IdeaTeamTurnContext {
  actorType: string;
  actorUuid: string;
}
