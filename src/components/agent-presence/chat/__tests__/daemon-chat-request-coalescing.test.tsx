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

function agentIndexResponse() {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        agents: [
          { agentUuid: "agent-1", lastTurnAt: "2026-08-30T12:00:00.000Z", sessionCount: 1 },
        ],
      },
    }),
  };
}
function pageResponse() {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: { sessions: [], nextCursor: null, hasMore: false },
    }),
  };
}
function detailResponse() {
  return {
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
  };
}

const isIndexUrl = (u: unknown) => String(u).includes("view=agents");

describe("DaemonChat agent-index request coalescing", () => {
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

  it("shares the mount/focus agent-index request, then allows a fresh 15-second refresh", async () => {
    let resolveInitialIndex!: (value: ReturnType<typeof agentIndexResponse>) => void;
    const initialIndex = new Promise<ReturnType<typeof agentIndexResponse>>((resolve) => {
      resolveInitialIndex = resolve;
    });

    mockAuthFetch.mockImplementation((url: string) => {
      if (isIndexUrl(url)) {
        // The mount fetch + the focus-driven re-sync both call fetchAgentIndex; the second
        // must COALESCE into the first in-flight request (one network call).
        const indexCallCount = mockAuthFetch.mock.calls.filter(([u]) => isIndexUrl(u)).length;
        return indexCallCount === 1 ? initialIndex : Promise.resolve(agentIndexResponse());
      }
      if (String(url).includes("agentUuid=")) return Promise.resolve(pageResponse());
      return Promise.resolve(detailResponse()); // /api/daemon-sessions/<uuid>
    });

    const view = render(<DaemonChat />);

    expect(mockClearChatFocusTarget).toHaveBeenCalledOnce();
    // Mount + focus-driven agent-index reads coalesced into a single network call.
    expect(mockAuthFetch.mock.calls.filter(([url]) => isIndexUrl(url))).toHaveLength(1);

    await act(async () => {
      resolveInitialIndex(agentIndexResponse());
      await initialIndex;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // The 15s poll issues a fresh agent-index read (coalescing cleared after settlement).
    expect(mockAuthFetch.mock.calls.filter(([url]) => isIndexUrl(url))).toHaveLength(2);

    view.unmount();
  });
});
