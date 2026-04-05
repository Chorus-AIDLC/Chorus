// Pure diff functions for detecting draft changes (new/changed/deleted)
// Extracted for unit testing

interface DraftBase {
  uuid: string;
}

interface DocDraft extends DraftBase {
  title: string;
  content: string;
  type: string;
}

interface TaskDraft extends DraftBase {
  title: string;
  description?: string;
  priority?: string;
  storyPoints?: number;
  acceptanceCriteriaItems?: { description: string; required?: boolean }[];
  dependsOnDraftUuids?: string[];
}

/** Find UUIDs present in current but not in old */
export function findNew<T extends DraftBase>(old: T[], current: T[]): string[] {
  const oldSet = new Set(old.map(d => d.uuid));
  return current.filter(d => !oldSet.has(d.uuid)).map(d => d.uuid);
}

/** Find UUIDs present in old but not in current */
export function findDeleted<T extends DraftBase>(old: T[], current: T[]): string[] {
  const currentSet = new Set(current.map(d => d.uuid));
  return old.filter(d => !currentSet.has(d.uuid)).map(d => d.uuid);
}

/** Find doc drafts that exist in both but have changed (field-level comparison) */
export function findChangedDocs(old: DocDraft[], current: DocDraft[]): string[] {
  const oldMap = new Map(old.map(d => [d.uuid, d]));
  return current.filter(d => {
    const prev = oldMap.get(d.uuid);
    if (!prev) return false;
    return d.title !== prev.title || d.content !== prev.content || d.type !== prev.type;
  }).map(d => d.uuid);
}

/**
 * Determine whether a full-page router.refresh() is needed.
 * - Status change (e.g. draft → pending): refreshes Actions buttons
 * - Draft count change in draft status: refreshes ValidationChecklist
 */
export function shouldRefresh(
  currentStatus: string,
  latestStatus: string | null,
  oldDocCount: number,
  newDocCount: number,
  oldTaskCount: number,
  newTaskCount: number
): boolean {
  const statusChanged = latestStatus != null && latestStatus !== currentStatus;
  const draftCountChanged = currentStatus === "draft" && (
    newDocCount !== oldDocCount || newTaskCount !== oldTaskCount
  );
  return statusChanged || draftCountChanged;
}

/** Find task drafts that exist in both but have changed (field-level comparison) */
export function findChangedTasks(old: TaskDraft[], current: TaskDraft[]): string[] {
  const oldMap = new Map(old.map(d => [d.uuid, d]));
  return current.filter(d => {
    const prev = oldMap.get(d.uuid);
    if (!prev) return false;
    if (d.title !== prev.title || d.description !== prev.description
      || d.priority !== prev.priority || d.storyPoints !== prev.storyPoints) return true;
    // Array fields: element order is backend-guaranteed, JSON.stringify is safe for arrays
    if (JSON.stringify(d.acceptanceCriteriaItems) !== JSON.stringify(prev.acceptanceCriteriaItems)) return true;
    if (JSON.stringify(d.dependsOnDraftUuids?.sort()) !== JSON.stringify(prev.dependsOnDraftUuids?.sort())) return true;
    return false;
  }).map(d => d.uuid);
}
