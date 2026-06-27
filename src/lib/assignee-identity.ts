/**
 * Pure, client-safe helpers for reasoning about a polymorphic assignee on the
 * frontend (kanban card, detail panels, modals). The backend resolves names and
 * ownership via uuid-resolver; these mirror the *display/ownership* questions the
 * UI asks, with NO DB access, so they are trivially unit-testable.
 *
 * The polymorphic assignee can be one of three types (add-agent-instance-addressing):
 *   - "user"           → `uuid` is a User.uuid
 *   - "agent"          → `uuid` is an Agent.uuid
 *   - "agent_instance" → `uuid` is an AgentInstance.uuid; the OWNING agent is
 *                        carried separately as `agentUuid` (the row's assigneeUuid
 *                        is the instance uuid, NOT the agent uuid — so an agent
 *                        identity comparison must use `agentUuid`, never `uuid`).
 */

/** The current viewer's actor identity (a user in the dashboard, an agent in MCP). */
export interface ActorIdentity {
  type: "user" | "agent";
  uuid: string;
}

/**
 * The minimal assignee shape these helpers reason over. A structural subset of
 * the server `AssigneeInfo` (uuid-resolver) — every render site already has these
 * fields. `agentUuid`/`instance` are present only for `type === "agent_instance"`.
 */
export interface AssigneeLike {
  type: string;
  uuid: string;
  /**
   * For `agent_instance` only: the OWNING agent's uuid (AgentInstance.agentUuid).
   * Used for the agent-identity comparison in `isAssignedToActor`. Absent/undefined
   * for `user` and `agent` assignees.
   */
  agentUuid?: string | null;
}

/**
 * Does `assignee` belong to `actor`? — the corrected ownership check that fixes
 * the `task-detail-panel` bug of comparing only `uuid` (which would, e.g., match a
 * user whose uuid coincidentally equals an agent uuid, and could NEVER correctly
 * match an `agent_instance` whose `uuid` is an instance uuid, not the actor's).
 *
 *   - user           → actor is the SAME user (type AND uuid match)
 *   - agent          → actor is the SAME agent (type AND uuid match)
 *   - agent_instance → actor is an agent AND owns the instance
 *                      (assignee.agentUuid === actor.uuid). The instance's OWNING
 *                      agent is the identity, never the instance uuid.
 *
 * Returns false for a null assignee or any unknown type.
 */
export function isAssignedToActor(
  assignee: AssigneeLike | null | undefined,
  actor: ActorIdentity | null | undefined,
): boolean {
  if (!assignee || !actor) return false;

  if (assignee.type === "user") {
    return actor.type === "user" && assignee.uuid === actor.uuid;
  }
  if (assignee.type === "agent") {
    return actor.type === "agent" && assignee.uuid === actor.uuid;
  }
  if (assignee.type === "agent_instance") {
    // The instance's owning agent is the identity; a viewer is "the assignee" iff
    // they are that agent. Compare against agentUuid, NOT the instance uuid.
    return (
      actor.type === "agent" &&
      !!assignee.agentUuid &&
      assignee.agentUuid === actor.uuid
    );
  }
  return false;
}

/** True when the assignee is a specific pinned (agent, host, cwd) instance. */
export function isInstanceAssignee(
  assignee: AssigneeLike | null | undefined,
): boolean {
  return !!assignee && assignee.type === "agent_instance";
}

/** True when the assignee is an agent OR a pinned instance of an agent. */
export function isAgentAssignee(
  assignee: AssigneeLike | null | undefined,
): boolean {
  return (
    !!assignee &&
    (assignee.type === "agent" || assignee.type === "agent_instance")
  );
}
