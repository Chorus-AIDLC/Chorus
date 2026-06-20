// @vitest-environment jsdom
//
// Modal test for the chat-style daemon UI (子3) — the "View all" modal body is now
// `DaemonChat`, a two-pane conversation surface (agent-first list + per-conversation
// transcript), not the connections master-detail.
//
// These tests render a REAL AgentPresenceProvider (the production data spine: one
// /api/agent-connections poll + one /api/daemon/executions aggregate fetch + one
// /api/events SSE) wrapping a tiny "View all" trigger and the AgentConnectionsModal,
// and assert the chat-surface behaviors:
//   - the modal opens on the trigger (popover→View all→modal path) and shows the
//     chat title + the agent selector seeded with the connection's agent,
//   - the conversation list renders the agent's sessions (newest-first), and the
//     most-recent agent is default-selected so the modal never opens empty,
//   - selecting a conversation fetches /api/daemon-sessions/[uuid] and renders its
//     turn bands with the wake-trigger labels + messages,
//   - the calm empty state shows when there are no conversations,
//   - a list-load failure renders the distinct error card, never a silent empty.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next-intl: resolve real en strings (a missing key surfaces as its dotted path and
// fails the assertion), with `{param}` interpolation + a tiny ICU-plural shim for
// the keys this surface uses (agentSessionCount / turnLabel etc.).
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
          // Minimal ICU plural: `{x, plural, one {# a} other {# b}}` → pick branch
          // by the `count`-ish param, substitute `#`.
          s = s.replace(
            /\{(\w+),\s*plural,\s*(?:one\s*\{([^}]*)\}\s*)?other\s*\{([^}]*)\}\}/g,
            (_m, name: string, one: string | undefined, other: string) => {
              const n = Number(params[name] ?? 0);
              const branch = n === 1 && one !== undefined ? one : other;
              return branch.replace(/#/g, String(n));
            },
          );
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { Button } from "@/components/ui/button";
import {
  AgentPresenceProvider,
  useAgentPresence,
} from "@/contexts/agent-presence-context";
import { AgentConnectionsModal } from "@/components/agent-presence";

// A stand-in for the sidebar popover's "View all" affordance — it only calls
// setModalOpen(true) on the shared provider, exactly as the real popover does.
function ViewAllTrigger() {
  const { setModalOpen } = useAgentPresence();
  return <Button onClick={() => setModalOpen(true)}>view-all-trigger</Button>;
}

// ===== EventSource stub =====
class NoopEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = NoopEventSource.OPEN;
  constructor(public url: string) {}
  close() {
    this.readyState = NoopEventSource.CLOSED;
  }
}

// ===== Fixtures =====
type Conn = {
  uuid: string;
  agentUuid: string;
  agentName: string | null;
  clientType: string;
  clientVersion: string | null;
  host: string;
  startedAt: string | null;
  status: string;
  effectiveStatus: "online" | "offline";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
};

function conn(overrides: Partial<Conn> & { uuid: string }): Conn {
  const now = "2026-06-16T12:00:00.000Z";
  return {
    agentUuid: `agent-${overrides.uuid}`,
    agentName: "Agent " + overrides.uuid,
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "host-" + overrides.uuid,
    startedAt: now,
    status: "online",
    effectiveStatus: "online",
    connectedAt: now,
    lastSeenAt: now,
    disconnectedAt: null,
    ...overrides,
  };
}

type Session = {
  uuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
  status: string;
  title: string | null;
  lastTurnAt: string;
  originOnline: boolean;
  firstInstruction: string | null;
  ideaTitle: string | null;
};

function session(overrides: Partial<Session> & { uuid: string }): Session {
  return {
    agentUuid: "agent-1",
    sessionId: "sid-" + overrides.uuid,
    directIdeaUuid: null,
    originConnectionUuid: "1",
    status: "active",
    title: null,
    lastTurnAt: "2026-06-16T12:00:00.000Z",
    originOnline: true,
    firstInstruction: null,
    ideaTitle: null,
    ...overrides,
  };
}

// Route authFetch by URL: connection list, executions aggregate, session list, and
// the per-session transcript detail.
function respondWith(opts: {
  connections?: Conn[];
  executions?: unknown[];
  sessions?: Session[];
  sessionsOk?: boolean;
  detail?: Record<string, unknown> | null;
}) {
  const {
    connections = [],
    executions = [],
    sessions = [],
    sessionsOk = true,
    detail = null,
  } = opts;
  mockAuthFetch.mockImplementation((url: string) => {
    if (typeof url === "string") {
      if (url.startsWith("/api/daemon/executions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { executions } }),
        });
      }
      // A specific session detail: /api/daemon-sessions/<uuid>
      if (/^\/api\/daemon-sessions\/[^/?]+$/.test(url)) {
        if (!detail) {
          return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: detail }),
        });
      }
      if (url.startsWith("/api/daemon-sessions")) {
        return Promise.resolve({
          ok: sessionsOk,
          json: async () => ({ success: sessionsOk, data: { sessions } }),
        });
      }
    }
    // Default: the connection list.
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { connections } }),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = NoopEventSource;
  // jsdom lacks scrollIntoView (used by the transcript auto-scroll).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.HTMLElement.prototype as any).scrollIntoView = vi.fn();
  // jsdom lacks ResizeObserver (Radix ScrollArea instantiates one in a layout effect).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-06-16T12:05:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderAndOpenModal() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const utils = render(
    <AgentPresenceProvider>
      <ViewAllTrigger />
      <AgentConnectionsModal />
    </AgentPresenceProvider>,
  );
  await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  await user.click(screen.getByText("view-all-trigger"));
  return { user, ...utils };
}

describe("Daemon chat modal — opening + conversation list", () => {
  it("opens the modal and shows the chat title", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentName: "Alpha" })],
      sessions: [session({ uuid: "s1", agentUuid: "agent-1", title: "Build the thing" })],
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.getAllByText("Conversations").length).toBeGreaterThan(0),
    );
    // The agent's conversation appears in the list.
    await waitFor(() =>
      expect(screen.getAllByText("Build the thing").length).toBeGreaterThan(0),
    );
  });

  it("default-selects the most-recent agent so the modal never opens empty", async () => {
    respondWith({
      connections: [
        conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" }),
        conn({ uuid: "2", agentUuid: "agent-2", agentName: "Bravo" }),
      ],
      sessions: [
        session({
          uuid: "s-old",
          agentUuid: "agent-1",
          title: "Older Alpha chat",
          originConnectionUuid: "1",
          lastTurnAt: "2026-06-16T10:00:00.000Z",
        }),
        session({
          uuid: "s-new",
          agentUuid: "agent-2",
          title: "Newer Bravo chat",
          originConnectionUuid: "2",
          lastTurnAt: "2026-06-16T11:59:00.000Z",
        }),
      ],
    });
    await renderAndOpenModal();
    // agent-2 (Bravo) has the most recent lastTurnAt → its conversation is shown.
    await waitFor(() =>
      expect(screen.getAllByText("Newer Bravo chat").length).toBeGreaterThan(0),
    );
    // Alpha's older chat is not in the (Bravo-filtered) list.
    expect(screen.queryByText("Older Alpha chat")).toBeNull();
  });

  it("no history but an online agent → defaults to the new-conversation composer (not a dead end)", async () => {
    // A connected agent with no conversations must land in a composer, not a passive
    // card: the right pane IS the new-conversation form so the user can start talking
    // immediately. The dead-end card is reserved for the no-agent-at-all case below.
    respondWith({
      connections: [conn({ uuid: "1", agentName: "Alpha" })],
      sessions: [],
    });
    await renderAndOpenModal();
    // The composer pane is shown (title + the live ad-hoc "Start session" submit),
    // and the dead-end "No conversations yet" card is NOT.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Start session" }).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("New conversation").length).toBeGreaterThan(0);
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("calm dead-end card only when there is no agent connected AND no history", async () => {
    // No connections and no sessions → nothing to talk to, so the calm "connect a
    // daemon" card is the right call (no composer to offer).
    respondWith({
      connections: [],
      sessions: [],
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.queryByText("No conversations yet")).toBeTruthy(),
    );
    expect(screen.queryAllByRole("button", { name: "Start session" }).length).toBe(0);
  });

  it("names an ad-hoc conversation by its first human instruction (not type+uuid)", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      sessions: [
        session({
          uuid: "s1",
          agentUuid: "agent-1",
          directIdeaUuid: null,
          firstInstruction: "Refactor the uploader to add retries",
          originConnectionUuid: "1",
        }),
      ],
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(
        screen.getAllByText("Refactor the uploader to add retries").length,
      ).toBeGreaterThan(0),
    );
    // The old type+uuid fallback name is gone.
    expect(screen.queryByText(/Conversation s1|Conversation sid-/)).toBeNull();
  });

  it("names an idea-anchored conversation by its idea title + an Idea badge", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      sessions: [
        session({
          uuid: "s1",
          agentUuid: "agent-1",
          directIdeaUuid: "idea-123",
          ideaTitle: "Realtime presence pill",
          originConnectionUuid: "1",
        }),
      ],
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.getAllByText("Realtime presence pill").length).toBeGreaterThan(0),
    );
    // The resource badge is shown for an idea-anchored conversation.
    expect(screen.getAllByText("Idea").length).toBeGreaterThan(0);
  });

  it("distinct error card on a list-load failure (no silent empty)", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentName: "Alpha" })],
      sessions: [],
      sessionsOk: false,
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.queryByText("Couldn't load this conversation")).toBeTruthy(),
    );
  });

  it("selecting a conversation renders its turn bands with trigger labels + messages", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      sessions: [
        session({
          uuid: "s1",
          agentUuid: "agent-1",
          title: "Ship login",
          originConnectionUuid: "1",
        }),
      ],
      detail: {
        session: {
          uuid: "s1",
          agentUuid: "agent-1",
          sessionId: "sid-s1",
          directIdeaUuid: null,
          originConnectionUuid: "1",
          status: "active",
          title: "Ship login",
          lastTurnAt: "2026-06-16T12:00:00.000Z",
          createdAt: "2026-06-16T11:00:00.000Z",
          updatedAt: "2026-06-16T12:00:00.000Z",
        },
        turns: [
          {
            uuid: "t1",
            sessionUuid: "s1",
            seq: 1,
            trigger: "task_assigned",
            promptText: null,
            status: "ended",
            executionUuid: null,
            startedAt: null,
            endedAt: null,
            createdAt: "2026-06-16T11:01:00.000Z",
            messages: [
              {
                uuid: "m1",
                turnUuid: "t1",
                role: "assistant",
                text: "Working on the login flow.",
                seq: 1,
                createdAt: "2026-06-16T11:01:30.000Z",
              },
            ],
          },
        ],
      },
    });
    const { user } = await renderAndOpenModal();

    // Click the conversation row.
    await waitFor(() =>
      expect(screen.getAllByText("Ship login").length).toBeGreaterThan(0),
    );
    const row = screen.getAllByText("Ship login")[0].closest("button");
    expect(row).toBeTruthy();
    await user.click(row as HTMLElement);

    // The transcript renders the turn band's wake-trigger label + the message text.
    await waitFor(() =>
      expect(screen.getAllByText("Task").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Working on the login flow.").length,
      ).toBeGreaterThan(0),
    );
  });

  it("a 'New conversation' affordance is always present, even with existing history", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      sessions: [
        session({ uuid: "s1", agentUuid: "agent-1", title: "Existing chat", originConnectionUuid: "1" }),
      ],
    });
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.getAllByText("Existing chat").length).toBeGreaterThan(0),
    );
    // The "New conversation" button is offered in the list (chat-app convention),
    // and with nothing selected the right pane already IS the composer.
    expect(screen.getAllByText("New conversation").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Start session" }).length,
      ).toBeGreaterThan(0),
    );
  });

  // ===== Open-conversation footer (post-feedback redesign) =====
  // The footer of an OPEN conversation is a PLAIN reply composer (no
  // new-conversation / agent / connection targeting — those live in the left list)
  // plus the live Interrupt/Resume control for the conversation's in-flight work.

  const detailFor = (overrides: {
    turnStatus?: string;
    executionUuid?: string | null;
  }) => ({
    session: {
      uuid: "s1",
      agentUuid: "agent-1",
      sessionId: "sid-s1",
      directIdeaUuid: null,
      originConnectionUuid: "1",
      status: "active",
      title: "Ship login",
      lastTurnAt: "2026-06-16T12:00:00.000Z",
      createdAt: "2026-06-16T11:00:00.000Z",
      updatedAt: "2026-06-16T12:00:00.000Z",
    },
    turns: [
      {
        uuid: "t1",
        sessionUuid: "s1",
        seq: 1,
        trigger: "human_instruction",
        promptText: "do the thing",
        status: overrides.turnStatus ?? "running",
        executionUuid: overrides.executionUuid ?? null,
        startedAt: "2026-06-16T11:01:00.000Z",
        endedAt: null,
        createdAt: "2026-06-16T11:01:00.000Z",
        messages: [],
      },
    ],
  });

  async function openShipLogin(opts: {
    executions?: unknown[];
    turnStatus?: string;
    executionUuid?: string | null;
  }) {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      executions: opts.executions ?? [],
      sessions: [
        session({ uuid: "s1", agentUuid: "agent-1", title: "Ship login", originConnectionUuid: "1" }),
      ],
      detail: detailFor(opts),
    });
    const { user } = await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.getAllByText("Ship login").length).toBeGreaterThan(0),
    );
    await user.click(screen.getAllByText("Ship login")[0].closest("button") as HTMLElement);
    return user;
  }

  it("open conversation footer is a PLAIN reply box — no target/connection picker", async () => {
    await openShipLogin({ turnStatus: "ended" });
    // The simple reply composer renders (its localized placeholder + a bare "Send").
    await waitFor(() =>
      expect(
        screen.getAllByPlaceholderText("Reply in this conversation…").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("button", { name: "Send" }).length).toBeGreaterThan(0);
    // None of the new-conversation machinery leaks into the open-conversation footer.
    expect(screen.queryByRole("combobox", { name: "Conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    expect(screen.queryByText("Start a new session")).toBeNull();
  });

  // A daemon_session execution fixture for the open conversation, keyed by the
  // conversation's BUSINESS id (sessionId) — what the daemon reports + the server
  // validates against.
  const adHocExec = (over: Partial<Record<string, unknown>> = {}) => ({
    uuid: "exec-1",
    agentUuid: "agent-1",
    connectionUuid: "1",
    entityType: "daemon_session",
    entityUuid: "sid-s1", // = session("s1").sessionId
    rootIdeaUuid: null,
    status: "running",
    interruptedReason: null,
    startedAt: "2026-06-16T11:01:00.000Z",
    createdAt: "2026-06-16T11:01:00.000Z",
    updatedAt: "2026-06-16T11:01:00.000Z",
    entityTitle: "Ship login",
    projectUuid: null,
    rootIdeaTitle: null,
    ...over,
  });

  it("surfaces the Interrupt control from THIS conversation's running daemon_session execution", async () => {
    // The execution is matched to the conversation by daemon_session:<sessionId> — NOT
    // the unreliable per-turn executionUuid link (here null) — so Interrupt appears.
    await openShipLogin({ turnStatus: "running", executionUuid: null, executions: [adHocExec()] });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /interrupt/i }).length).toBeGreaterThan(0),
    );
  });

  it("surfaces the Resume control for a user-interrupted conversation execution", async () => {
    await openShipLogin({
      turnStatus: "ended",
      executions: [adHocExec({ status: "interrupted", interruptedReason: "user" })],
    });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /resume/i }).length).toBeGreaterThan(0),
    );
  });

  it("does NOT show another conversation's execution in this conversation's footer (per-session scope)", async () => {
    // An execution for a DIFFERENT ad-hoc session on the same connection must not leak
    // into the open conversation's footer (point: cards only in their own conversation).
    await openShipLogin({
      turnStatus: "running",
      executions: [adHocExec({ entityUuid: "sid-OTHER" })],
    });
    await waitFor(() =>
      expect(
        screen.getAllByPlaceholderText("Reply in this conversation…").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", { name: /interrupt/i })).toBeNull();
  });
});

describe("Daemon chat modal — transcript pagination (load earlier)", () => {
  // A turn fixture for the detail payload.
  const turn = (over: Record<string, unknown>) => ({
    sessionUuid: "s1",
    trigger: "human_instruction",
    promptText: null,
    status: "ended",
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-06-16T11:00:00.000Z",
    messages: [],
    ...over,
  });
  const sessionDetail = {
    uuid: "s1",
    agentUuid: "agent-1",
    sessionId: "sid-s1",
    directIdeaUuid: null,
    originConnectionUuid: "1",
    status: "active",
    title: "Long chat",
    lastTurnAt: "2026-06-16T12:00:00.000Z",
    createdAt: "2026-06-16T11:00:00.000Z",
    updatedAt: "2026-06-16T12:00:00.000Z",
  };

  it("shows 'Load earlier' when hasMore, and clicking it prepends the older page", async () => {
    // Route: connections / executions / session list as usual, and the detail endpoint
    // returns the NEWEST page (hasMore:true) on the bare URL, the OLDER page on the
    // `?beforeSeq=` cursor.
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === "string") {
        if (url.startsWith("/api/daemon/executions")) {
          return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { executions: [] } }) });
        }
        // Older page (cursor present): turns seq 1-2, no more before them.
        if (/\/api\/daemon-sessions\/[^/?]+\?beforeSeq=/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                session: sessionDetail,
                turns: [
                  turn({ uuid: "t1", seq: 1, promptText: "FIRST message" }),
                  turn({ uuid: "t2", seq: 2, promptText: "second message" }),
                ],
                hasMore: false,
                oldestSeq: 1,
              },
            }),
          });
        }
        // Newest page (no cursor): turns seq 3-4, hasMore true (earlier turns exist).
        if (/^\/api\/daemon-sessions\/[^/?]+$/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                session: sessionDetail,
                turns: [
                  turn({ uuid: "t3", seq: 3, promptText: "third message" }),
                  turn({ uuid: "t4", seq: 4, promptText: "LATEST message" }),
                ],
                hasMore: true,
                oldestSeq: 3,
              },
            }),
          });
        }
        if (url.startsWith("/api/daemon-sessions")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: { sessions: [session({ uuid: "s1", agentUuid: "agent-1", title: "Long chat", originConnectionUuid: "1" })] },
            }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })] } }),
      });
    });

    const { user } = await renderAndOpenModal();
    await user.click((await screen.findAllByText("Long chat"))[0].closest("button") as HTMLElement);

    // Newest page rendered first.
    await waitFor(() => expect(screen.getAllByText("LATEST message").length).toBeGreaterThan(0));
    expect(screen.queryByText("FIRST message")).toBeNull();

    // The "Load earlier" affordance is shown because hasMore was true. (Both the
    // desktop pane and the hidden mobile pane render in jsdom, so there may be >1.)
    const loadEarlier = await screen.findAllByRole("button", { name: /load earlier/i });
    await user.click(loadEarlier[0]);

    // The older page is prepended (the opening message now present), and the control
    // disappears (the older page reported hasMore:false).
    await waitFor(() => expect(screen.getAllByText("FIRST message").length).toBeGreaterThan(0));
    // The cursor fetch used the oldest loaded seq (3) from the first page.
    expect(
      mockAuthFetch.mock.calls.some((c) => String(c[0]).includes("/api/daemon-sessions/s1?beforeSeq=3")),
    ).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load earlier/i })).toBeNull(),
    );
  });

  it("does NOT show 'Load earlier' when the first page already has everything (hasMore false)", async () => {
    respondWith({
      connections: [conn({ uuid: "1", agentUuid: "agent-1", agentName: "Alpha" })],
      sessions: [session({ uuid: "s1", agentUuid: "agent-1", title: "Short chat", originConnectionUuid: "1" })],
      detail: {
        session: sessionDetail,
        turns: [turn({ uuid: "t1", seq: 1, promptText: "only message" })],
        hasMore: false,
        oldestSeq: 1,
      },
    });
    const { user } = await renderAndOpenModal();
    await user.click((await screen.findAllByText("Short chat"))[0].closest("button") as HTMLElement);
    await waitFor(() => expect(screen.getAllByText("only message").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /load earlier/i })).toBeNull();
  });
});
