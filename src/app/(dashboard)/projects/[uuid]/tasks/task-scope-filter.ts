// URL-driven task scope filter shared by the tasks page views (list / kanban /
// DAG) and the idea panel's "view all" link.
//
//   ?proposalUuids=a,b   → tasks of those proposals
//   ?ideaUuid=x          → Quick Tasks linked directly to that idea (Task.ideaUuid)
//
// When both are present the scope is their UNION — an idea's tasks are its
// approved proposals' tasks plus its directly linked Quick Tasks.

export interface TaskScopeFilter {
  proposalUuids: Set<string>;
  ideaUuid: string | null;
}

export const PROPOSAL_UUIDS_PARAM = "proposalUuids";
export const IDEA_UUID_PARAM = "ideaUuid";

export function parseTaskScopeFilter(
  searchParams: { get(name: string): string | null }
): TaskScopeFilter | null {
  const proposalParam = searchParams.get(PROPOSAL_UUIDS_PARAM);
  const proposalUuids = new Set(
    (proposalParam ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const ideaUuid = searchParams.get(IDEA_UUID_PARAM)?.trim() || null;
  if (proposalUuids.size === 0 && !ideaUuid) return null;
  return { proposalUuids, ideaUuid };
}

export function taskMatchesScope(
  task: { proposalUuid: string | null; ideaUuid?: string | null },
  scope: TaskScopeFilter | null
): boolean {
  if (!scope) return true;
  if (task.proposalUuid && scope.proposalUuids.has(task.proposalUuid)) return true;
  return !!scope.ideaUuid && task.ideaUuid === scope.ideaUuid;
}

/** Query string (without "?") for a scope; "" when the scope is empty. */
export function buildTaskScopeQuery(
  proposalUuids: string[],
  ideaUuid?: string | null
): string {
  const params = new URLSearchParams();
  if (proposalUuids.length > 0) params.set(PROPOSAL_UUIDS_PARAM, proposalUuids.join(","));
  if (ideaUuid) params.set(IDEA_UUID_PARAM, ideaUuid);
  // Keep commas readable in the proposal list (matches the legacy link format).
  return params.toString().replace(/%2C/g, ",");
}
