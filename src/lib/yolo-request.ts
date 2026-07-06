// Shared enable-predicate for the human-facing "Yolo" button.
//
// Both idea-detail panels (the `/ideas` route panel and the dashboard
// idea-tracker panel) gate the button on the SAME predicate so the two surfaces
// never drift (mirrors src/lib/start-development.ts and src/lib/elaboration-verify.ts).
// The server action re-validates every precondition authoritatively — this is
// only a UX hint.
//
// Deviation from start-development.ts: Yolo shows at ANY incomplete stage
// (elaboration decision Q1), so the render gate is the RELAXED "the idea is not
// already fully done", not the stricter "approved proposal AND ≥1 unfinished
// task". "Done" is computed from the SAME proposals/tasks primitives both panels
// already thread to the Start Development button — deliberately NOT from
// `idea.derivedStatus`, because the `/ideas` panel's idea type has no such field
// (and no "done" status vocabulary), so reading it there would be a type error.

// A task is finished only when done or closed; open / assigned / in_progress /
// to_verify all count as unfinished (same rule as start-development.ts).
const FINISHED_TASK_STATUSES = new Set(["done", "closed"]);

export interface YoloAssignee {
  type: string;
  uuid: string;
  // Present only when type === "agent_instance": the owning agent's uuid.
  instance?: { agentUuid: string } | null;
}

export interface CanRequestYoloInput {
  /** Idea.assignee — must be an agent (or pinned agent_instance). */
  assignee: YoloAssignee | null | undefined;
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
  assignee: YoloAssignee | null | undefined
): string | null {
  if (!assignee) return null;
  if (assignee.type === "agent") return assignee.uuid;
  if (assignee.type === "agent_instance") return assignee.instance?.agentUuid ?? null;
  return null;
}

/**
 * Whether the idea is already fully done: an approved proposal exists AND it has
 * at least one task and every task is `done`/`closed`. Mirrors the `allDone`
 * predicate in computeDerivedStatus, but computed from the primitives the panels
 * already hold. An idea with no approved proposal, or with any unfinished task,
 * is NOT done — so the Yolo button shows at every earlier stage.
 */
function ideaIsDone(
  proposals: { status: string }[] | null | undefined,
  tasks: { status: string }[] | null | undefined
): boolean {
  if (!proposals || !proposals.some((p) => p.status === "approved")) return false;
  if (!tasks || tasks.length === 0) return false;
  return tasks.every((t) => FINISHED_TASK_STATUSES.has(t.status));
}

/**
 * Whether the Yolo button should be RENDERED (stage preconditions, ignoring
 * liveness): the assignee is an agent (or pinned agent_instance) and the idea is
 * NOT already fully done. When this holds but the agent is offline the button
 * renders disabled with an offline hint instead of disappearing.
 */
export function yoloPreconditionsMet({
  assignee,
  proposals,
  tasks,
}: Omit<CanRequestYoloInput, "agentOnline">): boolean {
  if (!assignee || (assignee.type !== "agent" && assignee.type !== "agent_instance")) {
    return false;
  }
  if (ideaIsDone(proposals, tasks)) return false;
  return true;
}

/**
 * Whether the Yolo button should be ENABLED.
 *
 * Enabled iff ALL hold:
 *  - the Idea's assignee is an agent (or pinned agent_instance),
 *  - the Idea is not already fully done,
 *  - the assignee's owning agent is online per AgentPresence.
 */
export function canRequestYolo(input: CanRequestYoloInput): boolean {
  return yoloPreconditionsMet(input) && input.agentOnline;
}
