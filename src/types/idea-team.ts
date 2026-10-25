import type { AgentTeamRole } from "@/lib/agent-team-roles";
import type { ProjectTeamMember } from "@/types/project-agent-team";

export type IdeaTeamRoutingRole = "product" | "development";

export type IdeaTeamPauseReason = "orchestrator_ineligible";

/** Team state for one Idea (no private roster unless `routing`). */
export interface IdeaTeamContextDto {
  ideaUuid: string;
  managed: boolean;
  state: "active" | "paused" | "unmanaged";
  reason: IdeaTeamPauseReason | null;
  orchestrator: { agentUuid: string; agentName: string } | null;
  /** A human requested YOLO on this Idea (only affects whether approvals need a human). */
  yolo: boolean;
  /** Owner-private: only the Team owner and the owner's own agents receive this. */
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
