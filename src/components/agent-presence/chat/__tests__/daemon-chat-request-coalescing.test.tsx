// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.fn();
const mockClearChatFocusTarget = vi.fn();
let currentFocusTarget: {
  agentUuid: string;
  sessionUuid: string;
  sessionSeed: typeof sessionSeed;
} | null;

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn() },
}));

const sessionSeed = {
  uuid: "session-1",
  agentUuid: "agent-1",
  sessionId: "backend-session-1",
  backendSessionId: null,
  directIdeaUuid: "idea-1",
  originConnectionUuid: "connection-1",
  runtimeCwd: "/workspace",
  status: "active",
  title: "Seeded conversation",
  lastTurnAt: "2026-08-30T12:00:00.000Z",
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresence: () => ({
    status: "ok",
    connections: [],
    executionsByConnection: new Map(),
    setOpenSession: vi.fn(),
    subscribeTranscript: vi.fn(() => vi.fn()),
    focusTarget: currentFocusTarget,
    clearChatFocusTarget: mockClearChatFocusTarget,
  }),
}));

vi.mock("../conversation-list", () => ({
  ConversationList: () => <div />,
}));

vi.mock("../transcript-view", () => ({
  TranscriptView: () => <div />,
}));

vi.mock("../new-conversation-pane", () => ({
  NewConversationPane: () => <div />,
}));

vi.mock("../../daemon-connect-cta", () => ({
  DaemonConnectCta: () => <div />,
}));

import { DaemonChat } from "../daemon-chat";

function successfulListResponse() {
  return {
    ok: true,
    json: async () => ({ success: true, data: { sessions: [] } }),
  };
}

describe("DaemonChat session-list request coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    currentFocusTarget = {
      agentUuid: "agent-1",
      sessionUuid: "session-1",
      sessionSeed,
    };
    mockClearChatFocusTarget.mockImplementation(() => {
      currentFocusTarget = null;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shares the mount/focus request, then allows a fresh 15-second refresh", async () => {
    let resolveInitialList!: (value: ReturnType<typeof successfulListResponse>) => void;
    const initialList = new Promise<ReturnType<typeof successfulListResponse>>((resolve) => {
      resolveInitialList = resolve;
    });

    mockAuthFetch.mockImplementation((url: string) => {
      if (url === "/api/daemon-sessions") {
        const listCallCount = mockAuthFetch.mock.calls.filter(
          ([calledUrl]) => calledUrl === "/api/daemon-sessions",
        ).length;
        return listCallCount === 1
          ? initialList
          : Promise.resolve(successfulListResponse());
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            session: sessionSeed,
            turns: [],
            hasMore: false,
            oldestTurnSeq: null,
            oldestMsgSeq: null,
          },
        }),
      });
    });

    const view = render(<DaemonChat />);

    expect(mockClearChatFocusTarget).toHaveBeenCalledOnce();
    expect(
      mockAuthFetch.mock.calls.filter(([url]) => url === "/api/daemon-sessions"),
    ).toHaveLength(1);

    await act(async () => {
      resolveInitialList(successfulListResponse());
      await initialList;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      mockAuthFetch.mock.calls.filter(([url]) => url === "/api/daemon-sessions"),
    ).toHaveLength(2);

    view.unmount();
  });
});
