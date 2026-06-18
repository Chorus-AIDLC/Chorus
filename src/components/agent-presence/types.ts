// Shared presentational types for the agent-presence rendering vocabulary.
//
// These shapes are consumed identically by the pill, popover, modal, and the
// (soon-relocated) Agent Connections page so there is no second, drifting copy.

// Shape returned by GET /api/agent-connections (see daemon-connection.service.ts → ConnectionView).
export interface ConnectionView {
  uuid: string;
  agentUuid: string;
  agentName: string | null;
  clientType: string;
  clientVersion: string | null;
  host: string; // "" when host-less
  startedAt: string | null;
  status: string;
  effectiveStatus: "online" | "offline";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
}

// Re-export the execution-state view so consumers of this module share one
// source of truth for the row/event shape (originally sourced from the backend
// daemon-execution.service via the realtime context).
export type { ExecutionView } from "@/contexts/realtime-context";
