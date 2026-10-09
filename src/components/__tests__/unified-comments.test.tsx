// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommentWithOwner } from "@/services/comment.service";
import type {
  MentionEditorProps,
  MentionEditorRef,
} from "@/components/mention-editor";

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
const mockDeleteCommentAction = vi.hoisted(() => vi.fn());
const mockReplyToAuthor = vi.hoisted(() => vi.fn());
vi.mock("@/app/(dashboard)/projects/comment-actions", () => ({
  createCommentAction: mockCreateCommentAction,
  deleteCommentAction: mockDeleteCommentAction,
}));
vi.mock("@/lib/comment-reader", () => ({ getCommentPage: mockGetCommentsAction }));

let entityCallback: ((event: { actorUuid?: string }) => void) | null = null;
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityEvent: (
    _t: string,
    _u: string,
    cb: (e: { actorUuid?: string }) => void,
  ) => {
    entityCallback = cb;
  },
}));

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values?.name ? `${key}:${values.name}` : key,
}));

vi.mock("@/components/mention-editor", async () => {
  const React = await import("react");
  return {
    MentionEditor: React.forwardRef<MentionEditorRef, MentionEditorProps>(
      function MockMentionEditor(props, ref) {
        React.useImperativeHandle(ref, () => ({
          focus: () =>
            document
              .querySelector<HTMLTextAreaElement>("[data-comment-editor]")
              ?.focus(),
          clear: vi.fn(),
          replyToAuthor: async (author) => {
            mockReplyToAuthor(author);
            document
              .querySelector<HTMLTextAreaElement>("[data-comment-editor]")
              ?.focus();
          },
        }));
        return <textarea data-comment-editor aria-label="comment editor" onChange={event => props.onChange(event.target.value)} />;
      },
    ),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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
import { ProjectAccessProvider } from "@/contexts/project-access-context";

// ===== Helpers =====
function makeComment(
  uuid: string,
  createdAt: string,
  content = uuid,
  author: CommentWithOwner["author"] = {
    type: "user",
    uuid: "user-1",
    name: "Dev",
  },
): CommentWithOwner {
  return {
    uuid,
    targetType: "idea",
    targetUuid: "idea-1",
    content,
    author,
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
  mockDeleteCommentAction.mockResolvedValue({ success: true });
  mockViewport(false);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function mockViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockInitialComments(comments: CommentWithOwner[], total = comments.length) {
  mockGetCommentsAction.mockResolvedValue({
    success: true,
    comments,
    total,
    nextCursor: null,
    hasMore: false,
  });
}

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
    expect(mockGetCommentsAction).toHaveBeenCalledWith("idea", "idea-1", {
      limit: 10,
      signal: expect.any(AbortSignal),
    });

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
    await act(async () => {
      observers.forEach((o) => o.trigger());
    });

    await waitFor(() => expect(screen.getByText("c1")).toBeTruthy());
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "c2",
      limit: 10,
      signal: expect.any(AbortSignal),
    });
  });
});

describe("UnifiedComments read recovery", () => {
  const page = (comments = [c1]): CommentPageResult & { success: true } => ({
    success: true, comments, total: comments.length, nextCursor: null, hasMore: false,
  });

  function deferredPage() {
    type PageResult = ReturnType<typeof page> | { success: false; error: string };
    let resolve!: (result: PageResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PageResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  it.each(["reject", "timeout"])("recovers an initial %s via Retry without remounting", async (failure) => {
    if (failure === "reject") mockGetCommentsAction.mockRejectedValueOnce(new Error("offline"));
    else mockGetCommentsAction.mockResolvedValueOnce({ success: false, error: "Failed to load comments" });
    mockGetCommentsAction.mockResolvedValue(page());
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "comments.retry" }));
    expect(await screen.findByText("c1")).toBeTruthy();
    expect(screen.queryByText("comments.loadError")).toBeNull();
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
  });

  it("preserves history and cursor on older failure and suppresses automatic retry storms", async () => {
    const older = deferredPage();
    mockGetCommentsAction.mockResolvedValueOnce({ ...page([c3]), total: 2, nextCursor: "c3", hasMore: true })
      .mockReturnValueOnce(older.promise).mockResolvedValue(page([c1]));
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await screen.findByText("c3");
    await act(async () => { observers.forEach(observer => { observer.trigger(); observer.trigger(); }); });
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
    await act(async () => older.reject(new Error("offline")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("c3")).toBeTruthy();
    await act(async () => observers.forEach(observer => observer.trigger()));
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "comments.retry" }));
    expect(await screen.findByText("c1")).toBeTruthy();
    expect(screen.getByText("c3")).toBeTruthy();
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "c3", limit: 10, signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { httpFailure: false, delayedSync: false },
    { httpFailure: true, delayedSync: false },
    { httpFailure: false, delayedSync: true },
    { httpFailure: true, delayedSync: true },
  ])("keeps older pagination recoverable after a local mutation ($httpFailure, delayed sync: $delayedSync)", async ({ httpFailure, delayedSync }) => {
    const older = deferredPage();
    const sync = deferredPage();
    const history = Array.from({ length: 12 }, (_, index) => makeComment(`history-${index}`,
      new Date(Date.UTC(2026, 8, 20 - index)).toISOString()));
    const posted = makeComment("posted", "2026-10-09T10:00:00.000Z");
    const newest = { ...page([posted, ...history.slice(0, 9)]), total: 13, nextCursor: "history-8", hasMore: true };
    const lastPage = { ...page(history.slice(10)), total: 13 };
    mockGetCommentsAction.mockResolvedValueOnce({ ...page(history.slice(0, 10)), total: 12, nextCursor: "history-9", hasMore: true })
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(delayedSync ? sync.promise : Promise.resolve(newest)).mockResolvedValueOnce(lastPage);
    mockCreateCommentAction.mockResolvedValueOnce({ success: true, comment: posted });
    const onCountChange = vi.fn();
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" currentUserUuid="user-1" onCountChange={onCountChange} />);
    await screen.findByText("history-9");
    await act(async () => observers.forEach(observer => observer.trigger()));
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "comment editor" }), "new comment");
    await user.click(screen.getByRole("button", { name: "" }));
    await screen.findByText("posted");
    await act(async () => older.resolve(httpFailure ? { success: false, error: "Failed to load comments" } : lastPage));
    expect(await screen.findByRole("button", { name: "comments.retry" })).toBeTruthy();
    expect(screen.getByText("history-9")).toBeTruthy();
    expect(screen.queryByText("history-11")).toBeNull();
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: "comments.retry" }));
    if (delayedSync) {
      expect(mockGetCommentsAction).toHaveBeenCalledTimes(3);
      await act(async () => sync.resolve(newest));
    }
    expect(await screen.findByText("history-11")).toBeTruthy();
    for (const entry of history) expect(screen.getAllByText(entry.content)).toHaveLength(1);
    expect(screen.getAllByText("posted")).toHaveLength(1);
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "history-9", limit: 10, signal: expect.any(AbortSignal),
    });
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("button", { name: "comments.retry" })).toBeNull();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(13));
  });

  it("aborts an old target and ignores its late page/count", async () => {
    const stale = deferredPage();
    const onCountChange = vi.fn();
    mockGetCommentsAction.mockReturnValueOnce(stale.promise).mockResolvedValue(page([c2]));
    const view = render(<UnifiedComments targetType="idea" targetUuid="idea-1" onCountChange={onCountChange} />);
    const signal = mockGetCommentsAction.mock.calls[0][2].signal;
    view.rerender(<UnifiedComments targetType="task" targetUuid="task-2" onCountChange={onCountChange} />);
    expect(signal.aborted).toBe(true);
    await screen.findByText("c2");
    await act(async () => stale.resolve({ ...page([c1]), total: 99 }));
    expect(screen.queryByText("c1")).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it("aborts an unmounted read and ignores a late rejection", async () => {
    const stale = deferredPage();
    const onCountChange = vi.fn();
    mockGetCommentsAction.mockReturnValueOnce(stale.promise);
    const view = render(<UnifiedComments targetType="idea" targetUuid="idea-1" onCountChange={onCountChange} />);
    const signal = mockGetCommentsAction.mock.calls[0][2].signal;
    view.unmount();
    onCountChange.mockClear();
    expect(signal.aborted).toBe(true);
    await act(async () => stale.reject(new Error("late rejection")));
    expect(onCountChange).not.toHaveBeenCalled();
  });

  it("coalesces realtime events and retains visible comments on a background rejection", async () => {
    const sync = deferredPage();
    mockGetCommentsAction.mockResolvedValueOnce(page()).mockReturnValueOnce(sync.promise).mockResolvedValue(page([c2, c1]));
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await screen.findByText("c1");
    await act(async () => { entityCallback?.({}); entityCallback?.({}); entityCallback?.({}); });
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
    await act(async () => sync.resolve(page()));
    expect(await screen.findByText("c2")).toBeTruthy();
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(3);
    mockGetCommentsAction.mockRejectedValueOnce(new Error("background failure"));
    await act(async () => entityCallback?.({}));
    expect(screen.getByText("c1")).toBeTruthy();
    expect(screen.getByText("c2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "comments.retry" })).toBeNull();
  });

  it("does not let a stale sync resurrect a deleted comment", async () => {
    const stale = deferredPage();
    mockGetCommentsAction.mockResolvedValueOnce(page()).mockReturnValueOnce(stale.promise).mockResolvedValue(page([]));
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" currentUserUuid="user-1" />);
    await screen.findByText("c1");
    await act(async () => entityCallback?.({ actorUuid: "someone-else" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "comments.actionsLabel:Dev" }));
    await user.click(screen.getByRole("menuitem", { name: "comments.delete" }));
    await user.click(await screen.findByRole("button", { name: "comments.deleteConfirm" }));
    await waitFor(() => expect(screen.queryByText("c1")).toBeNull());
    await act(async () => stale.resolve(page()));
    expect(screen.queryByText("c1")).toBeNull();
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(3);
  });

  it("remembers a scroll trigger during a realtime refresh", async () => {
    const sync = deferredPage();
    const newest = { ...page([c3]), total: 2, hasMore: true, nextCursor: "c3" };
    mockGetCommentsAction.mockResolvedValueOnce(newest).mockReturnValueOnce(sync.promise).mockResolvedValue(page([c1]));
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await screen.findByText("c3");
    await act(async () => entityCallback?.({}));
    await act(async () => observers.forEach(observer => observer.trigger()));
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(2);
    await act(async () => sync.resolve(newest));
    expect(await screen.findByText("c1")).toBeTruthy();
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "c3", limit: 10, signal: expect.any(AbortSignal),
    });
  });

  it("retains the entire loaded window when a later realtime page fails", async () => {
    mockGetCommentsAction.mockResolvedValueOnce(page()).mockResolvedValueOnce({
      ...page([c3]), total: 3, hasMore: true, nextCursor: "c3",
    }).mockResolvedValueOnce({ success: false, error: "Failed to load comments" });
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" />);
    await screen.findByText("c1");
    await act(async () => entityCallback?.({}));
    expect(screen.getByText("c1")).toBeTruthy();
    expect(screen.queryByText("c3")).toBeNull();
    expect(mockGetCommentsAction).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("establishes pagination after posting during initial loading (replacement fails: %s)", async (replacementFails) => {
    const initial = deferredPage();
    const history = Array.from({ length: 12 }, (_, index) =>
      makeComment(`history-${index}`, new Date(Date.UTC(2026, 8, 20 - index)).toISOString()),
    );
    const posted = makeComment("posted", "2026-10-09T10:00:00.000Z");
    const newest = { ...page([posted, ...history.slice(0, 9)]), total: 13, nextCursor: "history-8", hasMore: true };
    mockGetCommentsAction.mockReturnValueOnce(initial.promise);
    if (replacementFails) mockGetCommentsAction.mockRejectedValueOnce(new Error("replacement failure"));
    mockGetCommentsAction.mockResolvedValueOnce(newest).mockResolvedValueOnce({ ...page(history.slice(9)), total: 13 });
    mockCreateCommentAction.mockResolvedValueOnce({ success: true, comment: posted });
    const onCountChange = vi.fn();
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" currentUserUuid="user-1" onCountChange={onCountChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "comment editor" }), "new comment");
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(mockCreateCommentAction).toHaveBeenCalledTimes(1));
    await act(async () => initial.resolve({ ...page(history.slice(0, 10)), total: 12, nextCursor: "history-9", hasMore: true }));
    if (replacementFails) {
      expect(await screen.findByText("comments.loadError")).toBeTruthy();
      expect(screen.queryByText("comments.noMoreComments")).toBeNull();
      await user.click(screen.getByRole("button", { name: "comments.retry" }));
    }
    expect(await screen.findByText("posted")).toBeTruthy();
    expect(screen.queryByText("comments.noMoreComments")).toBeNull();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(13));
    await act(async () => observers.forEach(observer => observer.trigger()));
    expect(await screen.findByText("history-11")).toBeTruthy();
    expect(screen.getAllByText("posted")).toHaveLength(1);
    expect(mockGetCommentsAction).toHaveBeenLastCalledWith("idea", "idea-1", {
      cursor: "history-8", limit: 10, signal: expect.any(AbortSignal),
    });
  });
});

describe("UnifiedComments comment actions", () => {
  it("renders a keyboard-operable desktop dropdown and restores trigger focus on Escape", async () => {
    mockInitialComments([c1]);
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "comments.actionsLabel:Dev",
    });
    await user.click(trigger);

    const menu = screen.getByRole("menu");
    expect(
      menu.getAttribute("data-comment-actions-variant"),
    ).toBe("desktop");
    expect(screen.getByRole("menuitem", { name: "comments.reply" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "comments.delete" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("uses a safe-area bottom sheet with 44px action rows on mobile", async () => {
    mockViewport(true);
    mockInitialComments([c1]);
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "comments.actionsLabel:Dev",
      }),
    );

    const sheet = screen.getByRole("dialog");
    expect(sheet.getAttribute("data-comment-actions-variant")).toBe("mobile");
    expect(sheet.className).toContain("safe-area-inset-bottom");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("button", { name: "comments.reply" }).className,
    ).toContain("min-h-11");
    const deleteButton = screen.getByRole("button", {
      name: "comments.delete",
    });
    expect(deleteButton.className).toContain("min-h-11");
    expect(deleteButton.className).toContain("text-destructive");
  });

  it("routes Reply through the editor ref with the exact author identity and leaves focus in the editor", async () => {
    const agentComment = makeComment(
      "agent-comment",
      "2026-03-04T00:00:00.000Z",
      "Agent note",
      {
        type: "agent",
        uuid: "agent-1",
        name: "Builder",
        owner: { uuid: "user-1", name: "Dev" },
      },
    );
    mockInitialComments([agentComment]);
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "comments.actionsLabel:Builder",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "comments.reply" }));

    await waitFor(() =>
      expect(mockReplyToAuthor).toHaveBeenCalledWith({
        type: "agent",
        uuid: "agent-1",
        name: "Builder",
      }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "comment editor" }),
      ),
    );
  });

  it("shows Delete only for the current user's comments and owned-Agent comments", async () => {
    const own = makeComment(
      "own",
      "2026-03-05T00:00:00.000Z",
      "Own",
      { type: "user", uuid: "user-1", name: "Own user" },
    );
    const other = makeComment(
      "other",
      "2026-03-04T00:00:00.000Z",
      "Other",
      { type: "user", uuid: "user-2", name: "Other user" },
    );
    const ownedAgent = makeComment(
      "owned-agent",
      "2026-03-03T00:00:00.000Z",
      "Owned agent",
      {
        type: "agent",
        uuid: "agent-1",
        name: "Owned agent",
        owner: { uuid: "user-1", name: "Own user" },
      },
    );
    const otherAgent = makeComment(
      "other-agent",
      "2026-03-02T00:00:00.000Z",
      "Other agent",
      {
        type: "agent",
        uuid: "agent-2",
        name: "Other agent",
        owner: { uuid: "user-2", name: "Other user" },
      },
    );
    mockInitialComments([own, other, ownedAgent, otherAgent]);
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
      />,
    );

    for (const [name, allowed] of [
      ["Own user", true],
      ["Other user", false],
      ["Owned agent", true],
      ["Other agent", false],
    ] as const) {
      await user.click(
        await screen.findByRole("button", {
          name: `comments.actionsLabel:${name}`,
        }),
      );
      expect(
        screen.queryByRole("menuitem", { name: "comments.delete" }) !== null,
      ).toBe(allowed);
      await user.keyboard("{Escape}");
    }
  });

  it("cancels deletion without changing the list or count and returns focus", async () => {
    mockInitialComments([c1], 3);
    const onCountChange = vi.fn();
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
        onCountChange={onCountChange}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "comments.actionsLabel:Dev",
    });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "comments.delete" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(mockDeleteCommentAction).not.toHaveBeenCalled();
    expect(screen.getByText("c1")).toBeTruthy();
    expect(onCountChange).toHaveBeenLastCalledWith(3);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("removes a confirmed deletion and decrements the server total exactly once", async () => {
    mockInitialComments([c2, c1], 7);
    const onCountChange = vi.fn();
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
        onCountChange={onCountChange}
      />,
    );

    const triggers = await screen.findAllByRole("button", {
      name: "comments.actionsLabel:Dev",
    });
    await user.click(triggers[1]);
    await user.click(screen.getByRole("menuitem", { name: "comments.delete" }));
    await screen.findByRole("alertdialog");
    await user.click(
      screen.getByRole("button", { name: "comments.deleteConfirm" }),
    );

    await waitFor(() => expect(screen.queryAllByText("c1")).toHaveLength(0));
    expect(mockDeleteCommentAction).toHaveBeenCalledTimes(1);
    expect(mockDeleteCommentAction).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(6));
  });

  it("keeps the confirmation, comment, and count intact when deletion fails", async () => {
    mockInitialComments([c1], 4);
    mockDeleteCommentAction.mockResolvedValue({
      success: false,
      error: "Failed to delete comment",
    });
    const onCountChange = vi.fn();
    const user = userEvent.setup();
    render(
      <UnifiedComments
        targetType="idea"
        targetUuid="idea-1"
        currentUserUuid="user-1"
        onCountChange={onCountChange}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "comments.actionsLabel:Dev",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "comments.delete" }));
    await screen.findByRole("alertdialog");
    await user.click(
      screen.getByRole("button", { name: "comments.deleteConfirm" }),
    );

    await waitFor(() => expect(mockDeleteCommentAction).toHaveBeenCalledOnce());
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("c1")).toBeTruthy();
    expect(onCountChange).toHaveBeenLastCalledWith(4);
  });
});

// ===== Viewer (read-only) mode via ProjectAccessProvider =====
describe("UnifiedComments — project access level", () => {
  it("editor (default, no provider) sees the composer and comment actions", async () => {
    mockInitialComments([c3]);
    render(<UnifiedComments targetType="idea" targetUuid="idea-1" currentUserUuid="user-1" />);
    await waitFor(() => expect(screen.getByText("c3")).toBeTruthy());

    expect(screen.getByLabelText("comment editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "comments.actionsLabel:Dev" })).toBeTruthy();
    expect(screen.queryByTestId("comments-read-only")).toBeNull();
  });

  it("viewer gets no composer, no actions menu, and a read-only hint", async () => {
    mockInitialComments([c3]);
    render(
      <ProjectAccessProvider accessLevel="viewer">
        <UnifiedComments targetType="idea" targetUuid="idea-1" currentUserUuid="user-1" />
      </ProjectAccessProvider>,
    );
    await waitFor(() => expect(screen.getByText("c3")).toBeTruthy());

    expect(screen.queryByLabelText("comment editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "comments.actionsLabel:Dev" })).toBeNull();
    expect(screen.getByTestId("comments-read-only").textContent).toBe(
      "projectAccess.commentsReadOnly",
    );
  });
});
