// Shared agent-presence rendering vocabulary.
//
// The single source of truth for how a connection's identity, online/offline
// status, and running/queued/interrupted executions are rendered. The sidebar
// presence pill, the click popover, the "View all" modal, and the Agent
// Connections page all import from here so there is no second, drifting copy of
// the warm Chorus vocabulary (Bot/Clock tiles, pulsing online dot, monospace
// elapsed/uptime). Everything exported is presentational + prop-driven — no
// piece fetches the connection/execution dataset itself.

export type { ConnectionView, ExecutionView } from "./types";
export {
  pad2,
  execHref,
  useNowTick,
  useRelativeTime,
  useDurationMono,
  useUptimeMono,
  useElapsedMono,
  useClientTypeLabel,
  useEntityTypeLabel,
} from "./hooks";
export { StatusDot, StatusBadge } from "./status";
export { IdentityBlock } from "./identity-block";
export { ExecutionRow, ExecutionSection } from "./execution-row";
export { SendInstructionBox, type SessionTarget } from "./send-instruction-box";
export { AgentConnectionsView } from "./connections-view";
export { AgentConnectionsModal } from "./connections-modal";
