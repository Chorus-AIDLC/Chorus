import { parseSessionAnchor } from "@/lib/session-anchor";
import type { ConversationRow } from "./conversation-list";

export function conversationKey(session: { sessionId: string; directIdeaUuid: string | null }): string {
  const anchor = parseSessionAnchor(session.sessionId, session.directIdeaUuid);
  if (anchor.kind === "task" || anchor.kind === "review") return `daemon_session:${session.sessionId}`;
  return session.directIdeaUuid ? `idea:${session.directIdeaUuid}` : `daemon_session:${session.sessionId}`;
}

export interface ConversationGroup {
  key: string;
  ideaUuid: string | null;
  ideaTitle: string | null;
  parents: ConversationRow[];
  children: ConversationRow[];
}

// Loaded pages can contain children before (or without) their Idea session. Keep
// a stable Idea group in either case, ordered by its most recent loaded activity.
export function groupConversationRows(rows: ConversationRow[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
  for (const row of rows) {
    const ideaUuid = row.session.directIdeaUuid;
    const key = ideaUuid ? `idea:${ideaUuid}` : conversationKey(row.session);
    let group = groups.get(key);
    if (!group) {
      group = { key, ideaUuid, ideaTitle: null, parents: [], children: [] };
      groups.set(key, group);
    }
    group.ideaTitle ??= row.session.ideaTitle?.trim() || null;
    const anchor = parseSessionAnchor(row.session.sessionId, ideaUuid);
    if (ideaUuid && (anchor.kind === "task" || anchor.kind === "review")) {
      group.children.push(row);
    } else {
      group.parents.push(row);
    }
  }
  return [...groups.values()];
}
