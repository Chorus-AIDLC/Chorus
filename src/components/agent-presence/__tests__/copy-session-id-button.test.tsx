// @vitest-environment jsdom
//
// "Copy session ID" button (daemon chat transcript header). Two layers:
//
//   1. CopySessionIdButton in isolation — the copy interaction itself: a click
//      writes the BARE backend session id to the clipboard,
//      flips to the "Copied!" state, and resets after 2s (fake timers). A clipboard
//      that rejects is swallowed (no throw, no false "Copied!" state).
//   2. The button mounted inside the real TranscriptView header — placement next to
//      the unchanged copy control, render-gating on backendSessionId, and identical
//      behavior for idea-anchored and ad-hoc sessions.
//
// next-intl resolves real en.json strings so a missing key would surface as its
// dotted path and fail the text assertions (same harness as send-instruction-box).
// The footer ConversationReplyBox is stubbed so the header tests don't drag in
// authFetch / sonner / the realtime context.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";

// next-intl: resolve real en strings so a missing key surfaces as its dotted path.
vi.mock("next-intl", async () => {
  const en = (await import("../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let node: unknown = en;
    for (const p of fullKey.split(".")) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  return {
    useTranslations:
      (namespace = "") =>
      (key: string, params?: Record<string, string | number>) => {
        let s = resolve(namespace, key);
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The footer reply composer is irrelevant to the copy button — stub it so the
// full-header render stays free of its data/context dependencies.
vi.mock("../send-instruction-box", () => ({
  ConversationReplyBox: () => null,
}));

import { clientLogger } from "@/lib/logger-client";
import {
  CopySessionIdButton,
  TranscriptView,
} from "@/components/agent-presence/chat/transcript-view";
import type { SessionView } from "@/services/daemon-session.service";

const NOW = "2026-06-22T03:00:00.000Z";

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    uuid: "sess-1",
    agentUuid: "agent-1",
    sessionId: "8974ee58-1111-2222-3333-444455556666",
    backendSessionId: null,
    directIdeaUuid: "8974ee58-1111-2222-3333-444455556666", // idea-anchored: equals sessionId
    originConnectionUuid: "conn-1",
    status: "active",
    title: "Refactor auth",
    lastTurnAt: NOW,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// Install a clipboard whose writeText is observable. Returns the spy.
function installClipboard(impl?: (text: string) => Promise<void>) {
  const writeText = vi.fn<(text: string) => Promise<void>>(
    impl ?? (() => Promise.resolve()),
  );
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

function transcriptProps(session: SessionView | null) {
  return {
    session,
    turns: [],
    title: session?.title ?? "Conversation",
    loading: false,
    error: false,
    originConnection: null,
    originOnline: false,
    sessionExecutions: [],
    executionsByUuid: new Map(),
    hasMoreEarlier: false,
    loadingEarlier: false,
    onLoadEarlier: () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't implement scrollIntoView; TranscriptView's auto-scroll effect
  // calls it on mount. Stub it so the full-header render tests don't throw.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  // jsdom lacks ResizeObserver; Radix Tooltip content uses it when opened (the tap test).
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CopySessionIdButton — copy interaction", () => {
  it("copies the bare backend session id on click", async () => {
    const writeText = installClipboard();
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("codex-thread-123");
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toBe("codex-thread-123");
  });

  it("flips to the Copied! state then resets after 2s", async () => {
    vi.useFakeTimers();
    installClipboard();
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);

    // Drive the async click + the timer under fake timers.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy session ID" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("button", { name: "Copy session ID" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
  });

  it("swallows a clipboard rejection — no throw, stays in the un-copied state", async () => {
    const writeText = installClipboard(() =>
      Promise.reject(new Error("denied")),
    );
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // It logged but did NOT flip to Copied! (the label stays "Copy session ID").
    await waitFor(() => expect(clientLogger.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Copy session ID" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
  });

  it("does not throw when the Clipboard API is unavailable (insecure context)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);
    // The optional-chained writeText is a no-op (awaiting `undefined`); clicking
    // must not throw. The state flip that follows is flushed inside act().
    await act(async () => {
      expect(() =>
        fireEvent.click(screen.getByRole("button", { name: "Copy session ID" })),
      ).not.toThrow();
      await Promise.resolve();
    });
  });
});

describe("CopySessionIdButton — responsive label (mobile icon-only)", () => {
  function labelSpan(button: HTMLElement, text: string) {
    return Array.from(button.querySelectorAll("span")).find(
      (span) => span.textContent === text,
    ) as HTMLElement | undefined;
  }

  it("preserves the mobile-hidden label and accessible name at rest", () => {
    installClipboard();
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);
    const button = screen.getByRole("button", { name: "Copy session ID" });
    const span = labelSpan(button, "Copy session ID");
    expect(span).toBeTruthy();
    expect(span!.className).toContain("hidden");
    expect(span!.className).toContain("lg:inline");
  });

  it("preserves the visible mobile confirmation and then collapses", async () => {
    vi.useFakeTimers();
    installClipboard();
    render(<CopySessionIdButton backendSessionId="codex-thread-123" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const copiedSpan = labelSpan(
      screen.getByRole("button", { name: "Copied!" }),
      "Copied!",
    );
    expect(copiedSpan).toBeTruthy();
    expect(copiedSpan!.className).toContain("inline");
    expect(copiedSpan!.className).not.toContain("hidden");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const restSpan = labelSpan(
      screen.getByRole("button", { name: "Copy session ID" }),
      "Copy session ID",
    );
    expect(restSpan!.className).toContain("hidden");
    expect(restSpan!.className).toContain("lg:inline");
  });
});

describe("CopySessionIdButton — inside the TranscriptView header", () => {
  it("shows the session runtime cwd instead of the origin connection startup cwd", () => {
    const session = sessionView({ runtimeCwd: "/work/dynamic-project" });
    render(
      <TranscriptView
        {...transcriptProps(session)}
        originConnection={{
          uuid: "conn-1",
          agentUuid: "agent-1",
          ownerUuid: "owner-1",
          agentName: "Alpha",
          clientType: "claude_code",
          clientVersion: "1.0.0",
          host: "host-a",
          cwd: "/work/ai-pm",
          startedAt: NOW,
          status: "online",
          effectiveStatus: "online",
          connectedAt: NOW,
          lastSeenAt: NOW,
          disconnectedAt: null,
        }}
        originOnline
      />,
    );

    expect(
      screen.getByLabelText("Working directory: /work/dynamic-project"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Working directory: /work/ai-pm")).toBeNull();
  });

  it("keeps the existing control and copies backendSessionId for an idea-anchored session", async () => {
    const writeText = installClipboard();
    const session = sessionView({ backendSessionId: "codex-idea-thread" });
    render(<TranscriptView {...transcriptProps(session)} />);

    expect(screen.queryByText(/Codex Session ID/i)).toBeNull();
    expect(screen.queryByText("codex-idea-thread")).toBeNull();
    const btn = screen.getByRole("button", { name: "Copy session ID" });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("codex-idea-thread"),
    );
  });

  it("uses the same backendSessionId rule for an ad-hoc session", async () => {
    const writeText = installClipboard();
    const session = sessionView({
      sessionId: "adhoc-server-generated-uuid",
      backendSessionId: "codex-adhoc-thread",
      directIdeaUuid: null,
    });
    render(<TranscriptView {...transcriptProps(session)} />);

    expect(screen.queryByText(/Codex Session ID/i)).toBeNull();
    expect(screen.queryByText("codex-adhoc-thread")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("codex-adhoc-thread"),
    );
  });

  it("hides the copy action and does not fall back to sessionId when backendSessionId is null", () => {
    installClipboard();
    const session = sessionView({ backendSessionId: null });
    render(<TranscriptView {...transcriptProps(session)} />);
    expect(screen.queryByText(/Codex Session ID/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy session ID" })).toBeNull();
  });
});

describe("TranscriptView header — conversation token total (daemon-token-usage)", () => {
  it("shows the SUMMED total on the header badge (same badge as a turn)", () => {
    installClipboard();
    const session = sessionView({ totalInputTokens: 176, totalOutputTokens: 84643 });
    render(<TranscriptView {...transcriptProps(session)} />);
    // 176 + 84643 = 84819 → "84.8k tok" on the badge face (summed, not "N in / N out").
    expect(screen.getByText("84.8k tok")).toBeTruthy();
    expect(screen.queryByText(/ in \/ /)).toBeNull();
    // Accessible name carries the whole-conversation total.
    expect(screen.getByLabelText(/Conversation token usage: 84819 tokens/)).toBeTruthy();
  });

  it("renders no header badge for an all-silent conversation (zero rollup)", () => {
    installClipboard();
    const session = sessionView({ totalInputTokens: 0, totalOutputTokens: 0 });
    render(<TranscriptView {...transcriptProps(session)} />);
    expect(screen.queryByLabelText(/Conversation token usage/)).toBeNull();
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it("opens the breakdown tooltip on TAP (mobile) — Input, Output AND cache read/write (whole-session)", () => {
    installClipboard();
    const session = sessionView({
      totalInputTokens: 176,
      totalOutputTokens: 84643,
      totalCacheReadTokens: 9738735,
      totalCacheCreationTokens: 588599,
    });
    render(<TranscriptView {...transcriptProps(session)} />);
    const badge = screen.getByLabelText(/Conversation token usage/);
    // Popover content isn't in the DOM until opened; a click/tap opens it and it persists.
    fireEvent.click(badge);
    // Breakdown shows Input/Output AND Cache read/Cache write, all whole-session. Popover
    // content is portalled + may be duplicated for a11y, so use getAllByText.
    expect(screen.getAllByText("Input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Output").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cache read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cache write").length).toBeGreaterThan(0);
  });

  it("omits cache rows from the header tooltip when the conversation used no cache", () => {
    installClipboard();
    const session = sessionView({
      totalInputTokens: 176,
      totalOutputTokens: 84643,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    render(<TranscriptView {...transcriptProps(session)} />);
    fireEvent.click(screen.getByLabelText(/Conversation token usage/));
    expect(screen.getAllByText("Input").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cache/i)).toBeNull();
  });
});
