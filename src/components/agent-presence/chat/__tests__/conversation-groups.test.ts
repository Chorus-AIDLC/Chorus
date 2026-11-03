import { describe, expect, it } from "vitest";
import { conversationKey, groupConversationRows } from "../conversation-groups";
import type { ConversationRow } from "../conversation-list";

function row(sessionId: string, directIdeaUuid: string | null, ideaTitle: string | null = null): ConversationRow {
  return {
    session: { uuid: sessionId, sessionId, directIdeaUuid, ideaTitle, agentUuid: "A", title: null,
      originConnectionUuid: "C", status: "active", lastTurnAt: "2026-11-03T00:00:00.000Z", originOnline: true, firstInstruction: null },
    title: sessionId, status: null, ideaAnchored: directIdeaUuid != null,
  };
}

describe("conversation grouping", () => {
  it("uses scoped business keys and preserves Idea/ad-hoc keys", () => {
    expect(conversationKey(row("I", "I").session)).toBe("idea:I");
    expect(conversationKey(row("task:T", "I").session)).toBe("daemon_session:task:T");
    expect(conversationKey(row("review:task:T", "I").session)).toBe("daemon_session:review:task:T");
    expect(conversationKey(row("adhoc", null).session)).toBe("daemon_session:adhoc");
  });

  it("keeps newest activity order, parents before children and one header for child-only groups", () => {
    const review = row("review:task:T", "I");
    const other = row("adhoc", null);
    const task = row("task:T", "I", " Feature ");
    const idea = row("I", "I", "Feature");
    const groups = groupConversationRows([review, other, task, idea]);
    expect(groups.map((g) => g.key)).toEqual(["idea:I", "daemon_session:adhoc"]);
    expect(groups[0]).toMatchObject({ ideaTitle: "Feature", parents: [idea], children: [review, task] });
    expect(groupConversationRows([task])[0]).toMatchObject({ key: "idea:I", parents: [], children: [task] });
  });

  it("leaves Idea-only, ad-hoc and orphaned scoped sessions selectable", () => {
    const idea = row("I", "I");
    const adhoc = row("adhoc", null);
    const orphan = row("task:T", null);
    const groups = groupConversationRows([idea, adhoc, orphan]);
    expect(groups.map((g) => g.parents)).toEqual([[idea], [adhoc], [orphan]]);
    expect(groups.every((g) => g.children.length === 0)).toBe(true);
    expect(groupConversationRows([])).toEqual([]);
  });
});
