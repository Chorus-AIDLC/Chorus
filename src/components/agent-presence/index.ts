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
export {
  groupConnectionsByAgent,
  onlineConnectionsOnly,
  sortConnectionsForPresence,
  deriveInstanceActivity,
  useInstanceActivity,
  AgentGroupHeader,
  InstanceRow,
  PathChip,
  type AgentInstanceGroup,
  type InstanceActivity,
  type InstanceActivityState,
} from "./instance-group";
export {
  InstancePicker,
  filterOnlineInstances,
  type InstancePickerProps,
  type InstanceCandidate,
} from "./instance-picker";
export {
  WakeCwdPickerDialog,
  type WakeCwdPickerDialogProps,
} from "./wake-cwd-picker-dialog";
export {
  AssigneeInstanceLine,
  type AssigneeInstanceLineProps,
} from "./assignee-instance-line";
export { ExecutionRow, ExecutionSection } from "./execution-row";
export { SendInstructionBox, type SessionTarget } from "./send-instruction-box";
export {
  ConversationalEntry,
  ConversationalDispatchError,
  USER_TEXT_MAX_CHARS,
  type ConversationalEntryProps,
} from "./conversational-entry";
export { AgentConnectionsView } from "./connections-view";
export { AgentConnectionsModal } from "./connections-modal";
export { MentionBadge, type MentionBadgeProps } from "./mention-badge";
export {
  DaemonConnectCta,
  type DaemonConnectCtaVariant,
  DAEMON_NPX_PACKAGE,
  DAEMON_START_COMMAND,
  DAEMON_LOGIN_COMMAND,
} from "./daemon-connect-cta";
