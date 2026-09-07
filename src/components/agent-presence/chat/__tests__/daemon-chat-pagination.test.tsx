// @vitest-environment jsdom
//
// DaemonChat data-layer pagination (paginate-daemon-session-list). Asserts the chat modal
// consumes the SERVER-PAGINATED /api/daemon-sessions endpoint rather than fetching the whole
// history: on open it reads the agent INDEX (`?view=agents`) — never the bare full list — and
// then the SELECTED agent's first PAGE (`?agentUuid=&limit=12`); the 15s poll refetches only
// that first page. ConversationList/TranscriptView/etc are stubbed so this focuses purely on
// the fetch orchestration.

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.fn();

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn() },
}));

// One online connection for agent-1 so the agent axis + default selection resolve.
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresence: () => ({
    status: "ok",
    connections: [
      {
        uuid: "conn-1",
        agentUuid: "agent-1",
        agentName: "Admin Claude",
        effectiveStatus: "online",
        host: "",
      },
    ],
    executionsByConnection: new Map(),
    setOpenSession: vi.fn(),
    subscribeTranscript: vi.fn(() => vi.fn()),
    focusTarget: null,
    clearChatFocusTarget: vi.fn(),
  }),
}));

vi.mock("../conversation-list", () => ({ ConversationList: () => <div /> }));
vi.mock("../transcript-view", () => ({ TranscriptView: () => <div /> }));
vi.mock("../new-conversation-pane", () => ({ NewConversationPane: () => <div /> }));
vi.mock("../../daemon-connect-cta", () => ({ DaemonConnectCta: () => <div /> }));

import { DaemonChat } from "../daemon-chat";

const isIndex = (u: unknown) => String(u).includes("view=agents");
const isPage = (u: unknown) => String(u).includes("agentUuid=");
// The removed legacy behavior: a bare list fetch with NO query params.
const isBareFullList = (u: unknown) => String(u) === "/api/daemon-sessions";

function indexResp() {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        agents: [
          { agentUuid: "agent-1", lastTurnAt: "2026-08-30T12:00:00.000Z", sessionCount: 25 },
        ],
      },
    }),
  };
}
function pageResp() {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: { sessions: [], nextCursor: null, hasMore: true },
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockAuthFetch.mockImplementation((url: string) => {
    if (isIndex(url)) return Promise.resolve(indexResp());
    if (isPage(url)) return Promise.resolve(pageResp());
    return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("DaemonChat server-paginated list", () => {
  it("on open reads the agent index and the selected agent's first page — never the bare full list", async () => {
    const view = render(<DaemonChat />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const urls = mockAuthFetch.mock.calls.map(([u]) => String(u));
    // Agent index fetched; bare full-list NEVER fetched.
    expect(urls.some(isIndex)).toBe(true);
    expect(urls.some(isBareFullList)).toBe(false);
    // The default (most-recent) agent's FIRST page is fetched, bounded by limit=12.
    const firstPage = urls.find(isPage);
    expect(firstPage).toContain("agentUuid=agent-1");
    expect(firstPage).toContain("limit=12");
    // First page carries no cursor.
    expect(firstPage).not.toContain("before=");

    view.unmount();
  });

  it("the 15s poll refetches only the selected agent's first page (bounded, not the whole history)", async () => {
    const view = render(<DaemonChat />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const pageCallsAfterMount = mockAuthFetch.mock.calls.filter(([u]) => isPage(u)).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const pageCallsAfterPoll = mockAuthFetch.mock.calls.filter(([u]) => isPage(u)).length;
    expect(pageCallsAfterPoll).toBeGreaterThan(pageCallsAfterMount);
    // Every page fetch is the bounded first page for the selected agent — never a full list.
    for (const [u] of mockAuthFetch.mock.calls.filter(([x]) => isPage(x))) {
      expect(String(u)).toContain("limit=12");
    }
    expect(mockAuthFetch.mock.calls.some(([u]) => isBareFullList(u))).toBe(false);

    view.unmount();
  });
});
