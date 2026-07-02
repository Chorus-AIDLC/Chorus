// Shared enable-predicate for the human-facing "Start Development" button.
//
// Both idea-detail panels (the `/ideas` route panel and the dashboard
// idea-tracker panel) gate the button on the SAME predicate so the two
// surfaces never drift (mirrors src/lib/elaboration-verify.ts). It is computed
// from data the panels already load (proposals + their tasks + assignee) plus
// the AgentPresence-driven online flag. The server action re-validates every
// precondition authoritatively — this is only a UX hint.

// A task is finished only when done or closed; open / assigned / in_progress /
// to_verify all count as unfinished (same rule as the server precondition).
const FINISHED_TASK_STATUSES = new Set(["done", "closed"]);

export interface StartDevelopmentAssignee {
  type: string;
  uuid: string;
  // Present only when type === "agent_instance": the owning agent's uuid.
  instance?: { agentUuid: string } | null;
}

export interface CanStartDevelopmentInput {
  /** Idea.assignee — must be an agent (or pinned agent_instance). */
  assignee: StartDevelopmentAssignee | null | undefined;
  /** Idea-linked proposals already loaded into the panel. */
  proposals: { status: string }[] | null | undefined;
  /** Tasks of the idea's approved proposal(s) already loaded into the panel. */
  tasks: { status: string }[] | null | undefined;
  /** AgentPresence verdict for the assignee's owning agent. */
  agentOnline: boolean;
}

/**
 * The owning Agent uuid to match against presence connections: a plain agent
 * assignee is itself; an agent_instance assignee resolves to its owning agent
 * (any online connection of that agent qualifies — the server's session-origin
 * upgrade picks the right cwd, not the client).
 */
export function assigneeOwningAgentUuid(
  assignee: StartDevelopmentAssignee | null | undefined
): string | null {
  if (!assignee) return null;
  if (assignee.type === "agent") return assignee.uuid;
  if (assignee.type === "agent_instance") return assignee.instance?.agentUuid ?? null;
  return null;
}

/**
 * Whether the Start Development button should be RENDERED (stage preconditions,
 * ignoring liveness): the assignee is an agent, an approved proposal exists, and
 * at least one task is unfinished. When this holds but the agent is offline the
 * button renders disabled with an offline hint instead of disappearing.
 */
export function startDevelopmentPreconditionsMet({
  assignee,
  proposals,
  tasks,
}: Omit<CanStartDevelopmentInput, "agentOnline">): boolean {
  if (!assignee || (assignee.type !== "agent" && assignee.type !== "agent_instance")) {
    return false;
  }
  if (!proposals || !proposals.some((p) => p.status === "approved")) return false;
  if (!tasks || !tasks.some((t) => !FINISHED_TASK_STATUSES.has(t.status))) return false;
  return true;
}

/**
 * Whether the Start Development button should be ENABLED.
 *
 * Enabled iff ALL hold:
 *  - the Idea's assignee is an agent (or pinned agent_instance),
 *  - an approved idea-linked proposal exists,
 *  - at least one of its tasks is neither `done` nor `closed`,
 *  - the assignee's owning agent is online per AgentPresence.
 */
export function canStartDevelopment(input: CanStartDevelopmentInput): boolean {
  return startDevelopmentPreconditionsMet(input) && input.agentOnline;
}
