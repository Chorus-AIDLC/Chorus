// @vitest-environment jsdom
//
// "Copy session ID" button (daemon chat transcript header). Two layers:
//
//   1. CopySessionIdButton in isolation — the copy interaction itself: a click
//      writes the BARE session id to the clipboard (no `claude --resume`, no cwd),
//      flips to the "Copied!" state, and resets after 2s (fake timers). A clipboard
//      that rejects is swallowed (no throw, no false "Copied!" state).
//   2. The button mounted inside the real TranscriptView header — placement next to
//      the "Connection details" trigger, render-gating on `session != null`, and that
//      BOTH session kinds (idea-anchored where sessionId === directIdeaUuid, and
//      ad-hoc where it doesn't) surface the button copying their own sessionId.
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
    directIdeaUuid: "8974ee58-1111-2222-3333-444455556666", // idea-anchored: equals sessionId
    originConnectionUuid: "conn-1",
    status: "active",
    title: "Refactor auth",
    lastTurnAt: NOW,
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CopySessionIdButton — copy interaction", () => {
  it("copies the bare session id (no `claude --resume`, no cwd) on click", async () => {
    const writeText = installClipboard();
    render(<CopySessionIdButton sessionId="sid-abc-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("sid-abc-123");
    // Exactly the id — never a command form.
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toBe("sid-abc-123");
    expect(copied).not.toContain("claude --resume");
    expect(copied).not.toContain("cd ");
  });

  it("flips to the Copied! state then resets after 2s", async () => {
    vi.useFakeTimers();
    installClipboard();
    render(<CopySessionIdButton sessionId="sid-abc-123" />);

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
    render(<CopySessionIdButton sessionId="sid-abc-123" />);

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
    render(<CopySessionIdButton sessionId="sid-abc-123" />);
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
  // The visible label <span> is space-saving on mobile: hidden at rest
  // (`hidden lg:inline` → icon-only), shown on copy (`inline` → the transient
  // "Copied!" confirmation) and always shown on desktop. The accessible name
  // (aria-label) is present at every breakpoint regardless.
  function labelSpan(button: HTMLElement, text: string) {
    return Array.from(button.querySelectorAll("span")).find(
      (s) => s.textContent === text,
    ) as HTMLElement | undefined;
  }

  it("hides the label on mobile at rest but keeps the accessible name (icon-only)", () => {
    installClipboard();
    render(<CopySessionIdButton sessionId="sid-abc-123" />);
    const btn = screen.getByRole("button", { name: "Copy session ID" });
    // Icon-only on mobile: the label span is `hidden` until the `lg` breakpoint.
    const span = labelSpan(btn, "Copy session ID");
    expect(span).toBeTruthy();
    expect(span!.className).toContain("hidden");
    expect(span!.className).toContain("lg:inline");
    // a11y name still resolves (button is queryable by it) even while visually hidden.
  });

  it("reveals the confirmation label on copy (visible on mobile too), then collapses", async () => {
    vi.useFakeTimers();
    installClipboard();
    render(<CopySessionIdButton sessionId="sid-abc-123" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    // After copy: the "Copied!" label is unconditionally `inline` (shown on mobile
    // as the requested post-copy hint, not hidden behind the lg breakpoint).
    const copiedBtn = screen.getByRole("button", { name: "Copied!" });
    const copiedSpan = labelSpan(copiedBtn, "Copied!");
    expect(copiedSpan).toBeTruthy();
    expect(copiedSpan!.className).toContain("inline");
    expect(copiedSpan!.className).not.toContain("hidden");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Back to rest → icon-only again on mobile.
    const restSpan = labelSpan(
      screen.getByRole("button", { name: "Copy session ID" }),
      "Copy session ID",
    );
    expect(restSpan!.className).toContain("hidden");
    expect(restSpan!.className).toContain("lg:inline");
  });
});

describe("CopySessionIdButton — inside the TranscriptView header", () => {
  it("renders the button for an idea-anchored session and copies its sessionId", async () => {
    const writeText = installClipboard();
    const session = sessionView(); // sessionId === directIdeaUuid
    render(<TranscriptView {...transcriptProps(session)} />);

    const btn = screen.getByRole("button", { name: "Copy session ID" });
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(session.sessionId));
  });

  it("renders the button for an ad-hoc session (sessionId !== directIdeaUuid)", async () => {
    const writeText = installClipboard();
    const session = sessionView({
      sessionId: "adhoc-server-generated-uuid",
      directIdeaUuid: null,
    });
    render(<TranscriptView {...transcriptProps(session)} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("adhoc-server-generated-uuid"),
    );
  });

  it("does NOT render the button when there is no session", () => {
    installClipboard();
    render(<TranscriptView {...transcriptProps(null)} />);
    expect(screen.queryByRole("button", { name: "Copy session ID" })).toBeNull();
  });
});
