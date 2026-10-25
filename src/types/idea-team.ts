import type { AgentTeamRole } from "@/lib/agent-team-roles";
import type { ProjectTeamMember } from "@/types/project-agent-team";

export type IdeaTeamRoutingRole = "product" | "development";

export type IdeaTeamPauseReason = "orchestrator_ineligible";

/** Safe, shareable Team gate summary for one Idea (no private roster unless `routing`). */
export interface IdeaTeamContextDto {
  ideaUuid: string;
  managed: boolean;
  state: "active" | "paused" | "unmanaged";
  reason: IdeaTeamPauseReason | null;
  orchestrator: { agentUuid: string; agentName: string } | null;
  yolo: boolean;
  proposalGate: "human" | "orchestrator";
  taskGate: "human" | "orchestrator";
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
