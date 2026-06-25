// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { CommentWithOwner } from "@/services/comment.service";

// ===== Controllable IntersectionObserver polyfill (jsdom ships none) =====
type IOCallback = (entries: { isIntersecting: boolean }[]) => void;
const observers: { cb: IOCallback; trigger: () => void }[] = [];
class IOStub {
  cb: IOCallback;
  constructor(cb: IOCallback) {
    this.cb = cb;
    observers.push({ cb, trigger: () => cb([{ isIntersecting: true }]) });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: typeof IOStub }).IntersectionObserver = IOStub;

// ===== Mocks for heavy child deps so we render only UnifiedComments' own logic =====
const mockGetCommentsAction = vi.hoisted(() => vi.fn());
const mockCreateCommentAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(dashboard)/projects/comment-actions", () => ({
  getCommentsAction: mockGetCommentsAction,
  createCommentAction: mockCreateCommentAction,
}));

let entityCallback: ((event: { actorUuid?: string }) => void) | null = null;
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityEvent: (_t: string, _u: string, cb: (e: { actorUuid?: string }) => void) => {
    entityCallback = cb;
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/mention-editor", () => ({
  MentionEditor: () => null,
}));

vi.mock("@/components/mention-renderer", () => ({
  ContentWithMentions: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock("@/components/agent-presence", () => ({
  MentionBadge: () => null,
}));

vi.mock("@/components/ui/presence-indicator", () => ({
  PresenceIndicator: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import {
  UnifiedComments,
  mergeCommentsByUuid,
  syncLatestComments,
  type CommentPageResult,
} from "@/components/unified-comments";

// ===== Helpers =====
function makeComment(uuid: string, createdAt: string, content = uuid): CommentWithOwner {
  return {
    uuid,
    targetType: "idea",
    targetUuid: "idea-1",
    content,
    author: { type: "user", uuid: "user-1", name: "Dev" },
    createdAt,
    updatedAt: createdAt,
  };
}

// Newest-first fixtures (descending createdAt).
const c3 = makeComment("c3", "2026-03-03T00:00:00.000Z");
const c2 = makeComment("c2", "2026-03-02T00:00:00.000Z");
const c1 = makeComment("c1", "2026-03-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  observers.length = 0;
  entityCallback = null;
});

// ===== mergeCommentsByUuid =====
describe("mergeCommentsByUuid", () => {
  it("dedups by uuid (incoming wins) and keeps newest-first order", () => {
    const merged = mergeCommentsByUuid([c3, c1], [c2, c1]);
    expect(merged.map((c) => c.uuid)).toEqual(["c3", "c2", "c1"]);
  });

  it("incoming copy replaces the existing one on uuid collision", () => {
    const edited = makeComment("c1", c1.createdAt, "edited body");
    const merged = mergeCommentsByUuid([c1], [edited]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("edited body");
  });

  it("prepends a newer comment to the top", () => {
    const merged = mergeCommentsByUuid([c2, c1], [c3]);
    expect(merged.map((c) => c.uuid)).toEqual(["c3", "c2", "c1"]);
  });

  it("optimistic insert + its echo appear exactly once", () => {
    const afterOptimistic = mergeCommentsByUuid([c2, c1], [c3]);
    const afterEcho = mergeCommentsByUuid(afterOptimistic, [c3]);
    expect(afterEcho.filter((c) => c.uuid === "c3")).toHaveLength(1);
  });
});

// ===== syncLatestComments =====
describe("syncLatestComments", () => {
  it("stops at the first page when it overlaps the loaded window (contiguous)", async () => {
    const fetchPage = vi.fn(async (): Promise<CommentPageResult> => ({
      comments: [c3, c2], // c2 already loaded → overlap
      total: 3,
      nextCursor: "c2",
      hasMore: true,
    }));
    const result = await syncLatestComments([c2, c1], fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result?.contiguous).toBe(true);
    expect(result?.comments.map((c) => c.uuid)).toEqual(["c3", "c2", "c1"]);
    expect(result?.total).toBe(3);
  });

  it("stops when hasMore is false even without overlap (full set, no hole)", async () => {
    const fetchPage = vi.fn(async (): Promise<CommentPageResult> => ({
      comments: [c3, c2, c1],
      total: 3,
      nextCursor: null,
      hasMore: false,
    }));
    const result = await syncLatestComments([], fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result?.contiguous).toBe(true);
    expect(result?.comments.map((c) => c.uuid)).toEqual(["c3", "c2", "c1"]);
  });

  it("burst: walks newest→older up to the cap, then resets the window (no permanent hole)", async () => {
    // Loaded window is an OLD comment; a burst of brand-new comments never overlaps it
    // within the cap → the sweep gives up and resets to the fetched newest pages.
    const old = makeComment("old", "2026-01-01T00:00:00.000Z");
    const burst = Array.from({ length: 10 }, (_, i) =>
      makeComment(`n${i}`, `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`)
    );
    let call = 0;
    const fetchPage = vi.fn(async (): Promise<CommentPageResult> => {
      const slice = burst.slice(call * 2, call * 2 + 2);
      call++;
      return { comments: slice, total: 11, nextCursor: slice[slice.length - 1]?.uuid ?? null, hasMore: true };
    });
    const result = await syncLatestComments([old], fetchPage, 3);
    expect(fetchPage).toHaveBeenCalledTimes(3); // bounded by the cap
    expect(result?.contiguous).toBe(false); // reset, not merged onto old window
    expect(result?.comments).toHaveLength(6); // 3 pages * 2
    expect(result?.resetHasMore).toBe(true);
    expect(result?.resetOldestCursor).toBeTruthy();
  });

  it("returns null when nothing could be fetched", async () => {
    const fetchPage = vi.fn(async () => null);
    const result = await syncLatestComments([c1], fetchPage);
    expect(result).toBeNull();
  });
});

// ===== UnifiedComments render =====
describe("UnifiedComments (render)", () => {
  it("loads only the first page (limit 10) on mount and renders newest-on-top", async () => {
    mockGetCommentsAction.mockResolvedValue({
      success: true,
      comments: [c3, c2], // newest-first from the server
      total: 12,
      nextCursor: "c2",
      hasMore: true,
    });
    const onCountChange = vi.fn();

    render(
      <UnifiedComments targetType="idea" targetUuid="idea-1" onCountChange={onCountChange} />
    );

    await waitFor(() => expect(screen.getByText("c3")).toBeTruthy());

    // First paint requested exactly one page of 10, no cursor.
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(1);
    expect(mockGetCommentsAction).toHaveBeenCalledWith("idea", "idea-1", { limit: 10 });

    // Count reflects server total (12), not the 2 loaded.
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(12));

    // Newest (c3) renders before c2 in the DOM.
    const html = document.body.innerHTML;
    expect(html.indexOf("c3")).toBeLessThan(html.indexOf("c2"));
  });

  it("shows the 'no more comments' affordance when hasMore is false", async () => {
    mockGetCommentsAction.mockResolvedValue({
      success: true,
      comments: [c1],
      total: 1,
      nextCursor: null,
      hasMore: false,
    });

    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);

    await waitFor(() => expect(screen.getByText("comments.noMoreComments")).toBeTruthy());
  });

  it("auto-loads the next older page when the sentinel intersects", async () => {
    mockGetCommentsAction
      .mockResolvedValueOnce({
        success: true,
        comments: [c3, c2],
        total: 3,
        nextCursor: "c2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        success: true,
        comments: [c1],
        total: 3,
        nextCursor: null,
        hasMore: false,
      });

    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await waitFor(() => expect(screen.getByText("c3")).toBeTruthy());

    // Trigger the bottom sentinel → older page loads and appends below.
    observers.forEach((o) => o.trigger());

    await waitFor(() => expect(screen.getByText("c1")).toBeTruthy());
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "c2",
      limit: 10,
    });
  });
});
