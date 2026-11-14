// @vitest-environment jsdom
//
// cli-agent-session-sync D7 — the daemon conversation surface for CLI-held sessions.
// Covers the three states the UI must distinguish:
//   1. Running in terminal (live CLI lease): header badge, list-row indicator, "In
//      terminal" turn status, queued hint on pending human turns, Send stays ENABLED with
//      an info hint (the server stores the turn pending).
//   2. Unbound (no daemon on the origin machine/dir): Send disabled with its own reason.
//   3. Not continuable: Send disabled with a distinct reason; a queued turn retired as
//      interrupted(session_not_continuable) says it was not delivered.
// Plus the pure helpers (lease liveness, gate precedence, 409 reason mapping, list-row
// merge). next-intl resolves real en.json strings (a missing key fails the assertion).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json")).default as Record<
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

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const mockToast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}));
vi.mock("../token-usage-badge", () => ({
  SessionUsageBadge: () => null,
  TokenUsageBadge: () => null,
}));

import {
  deriveSendGate,
  isCliLeaseLive,
  mergeCliSessionState,
  sendGateFromErrorReason,
} from "../session-cli-state";
import { TurnBand } from "../turn-band";
import { TranscriptView } from "../transcript-view";
import { ConversationList, type ConversationRow } from "../conversation-list";
import { ConversationReplyBox, type SessionTarget } from "../../send-instruction-box";
import type {
  SessionView,
  TurnWithMessagesView,
} from "@/services/daemon-session.service";

const NOW = "2026-11-09T12:00:00.000Z";
const LEASED = { leased: true, host: "felix-laptop", cwd: "/home/felix/dev/chorus" };

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    cli: null,
    originBound: true,
    continuable: true,
    uuid: "sess-1",
    agentUuid: "agent-1",
    sessionId: "8974ee58-1111-2222-3333-444455556666",
    backendSessionId: null,
    directIdeaUuid: null,
    originConnectionUuid: "conn-1",
    status: "active",
    title: "Refactor the lease gate",
    lastTurnAt: NOW,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function turn(over: Partial<TurnWithMessagesView> = {}): TurnWithMessagesView {
  return {
    uuid: `turn-${over.seq ?? 1}`,
    sessionUuid: "sess-1",
    backendSessionId: null,
    seq: 1,
    trigger: "human_instruction",
    promptText: "run the tests",
    status: "pending",
    interruptedReason: null,
    relayError: null,
    usage: null,
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: NOW,
    messages: [],
    ...over,
  };
}

function renderTranscript(s: SessionView, turns: TurnWithMessagesView[], originOnline = false) {
  return render(
    <TranscriptView
      session={s}
      turns={turns}
      title="Refactor the lease gate"
      loading={false}
      error={false}
      originConnection={null}
      originOnline={originOnline}
      sessionExecutions={[]}
      executionsByUuid={new Map()}
      hasMoreEarlier={false}
      loadingEarlier={false}
      onLoadEarlier={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { turn: {}, queued: true } }),
  });
});
afterEach(() => cleanup());

describe("session-cli-state helpers", () => {
  it("isCliLeaseLive: needs the server lease AND a still-running newest cli_session turn", () => {
    expect(isCliLeaseLive(session(), [])).toBe(false);
    expect(isCliLeaseLive(session({ cli: { ...LEASED, leased: false } }), [])).toBe(false);
    expect(isCliLeaseLive(session({ cli: LEASED }), [])).toBe(true);
    expect(
      isCliLeaseLive(session({ cli: LEASED }), [turn({ trigger: "cli_session", status: "running" })]),
    ).toBe(true);
    // The terminal's turn ended over SSE → the (stale) lease flag is overridden.
    expect(
      isCliLeaseLive(session({ cli: LEASED }), [
        turn({ seq: 1, trigger: "cli_session", status: "running" }),
        turn({ seq: 2, trigger: "cli_session", status: "ended" }),
      ]),
    ).toBe(false);
  });

  it("deriveSendGate follows the server precedence", () => {
    const g = (s: Partial<SessionView>, cliLeased: boolean, originOnline: boolean) =>
      deriveSendGate({ session: session(s), cliLeased, originOnline });
    expect(g({ continuable: false, originBound: false }, true, true)).toBe("not_continuable");
    expect(g({ originBound: false, originConnectionUuid: null }, true, false)).toBe("unbound");
    expect(g({}, true, false)).toBe("queued");
    expect(g({}, false, false)).toBe("offline");
    expect(g({}, false, true)).toBe("open");
  });

  it("maps 409 reasons to gates", () => {
    expect(sendGateFromErrorReason("session_unbound")).toBe("unbound");
    expect(sendGateFromErrorReason("session_not_continuable")).toBe("not_continuable");
    expect(sendGateFromErrorReason(undefined)).toBeNull();
  });

  it("mergeCliSessionState folds the list row's fresher CLI state onto the detail", () => {
    const detail = session({ cli: LEASED, originBound: false, originConnectionUuid: null });
    const row = {
      uuid: "sess-1",
      originConnectionUuid: "conn-9",
      cli: { ...LEASED, leased: false },
      originBound: true,
      continuable: true,
    };
    const merged = mergeCliSessionState(detail, row)!;
    expect(merged.cli?.leased).toBe(false);
    expect(merged.originBound).toBe(true);
    expect(merged.originConnectionUuid).toBe("conn-9");
    // Unchanged / foreign row → same object back.
    expect(mergeCliSessionState(detail, { ...row, uuid: "other" })).toBe(detail);
    const same = { uuid: "sess-1", originConnectionUuid: null, cli: LEASED, originBound: false, continuable: true };
    expect(mergeCliSessionState(detail, same)).toBe(detail);
  });
});

describe("State 1 — running in terminal", () => {
  it("header shows 'Running in terminal' and the terminal's cwd chip without a daemon connection", () => {
    renderTranscript(
      session({ cli: LEASED, originBound: false, originConnectionUuid: null, continuable: true }),
      [turn({ trigger: "cli_session", status: "running", promptText: null })],
    );
    const badge = screen.getByTestId("running-in-terminal");
    expect(badge.textContent).toContain("Running in terminal");
    expect(badge.getAttribute("title")).toBe("felix-laptop · /home/felix/dev/chorus");
    // The cli_session band reads "In terminal", not a daemon "Running".
    expect(screen.getAllByText("In terminal").length).toBeGreaterThan(0);
    expect(screen.getByText("Running in the terminal — its output appears here as it syncs.")).toBeTruthy();
  });

  it("a leased, bound conversation keeps Send enabled with the queued hint, even origin-offline", async () => {
    renderTranscript(session({ cli: LEASED }), [
      turn({ seq: 1, trigger: "cli_session", status: "running", promptText: null }),
      turn({ seq: 2, status: "pending" }),
    ]);
    expect(screen.getByTestId("compose-hint").textContent).toContain(
      "messages you send now are queued",
    );
    expect(screen.queryByTestId("compose-disabled-reason")).toBeNull();
    // Pending human turn sent during the lease → queued hint on the band.
    expect(screen.getByTestId("turn-queued-terminal").textContent).toBe(
      "Queued — delivered when the terminal session ends",
    );
    const textarea = screen.getByPlaceholderText("Reply in this conversation…");
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "also fix lint" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
    expect(mockAuthFetch.mock.calls[0][0]).toBe("/api/daemon-sessions/sess-1/instruction");
  });

  it("the IME guard still holds: a composing Enter never sends", () => {
    render(<ConversationReplyBox sessionUuid="sess-1" originOnline sendGate="queued" />);
    const textarea = screen.getByPlaceholderText("Reply in this conversation…");
    fireEvent.change(textarea, { target: { value: "你好" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("a pending turn without a live lease shows no queued-for-terminal hint", () => {
    render(<TurnBand turn={turn({ status: "pending" })} agentName="Alpha" linkedExecution={null} />);
    expect(screen.queryByTestId("turn-queued-terminal")).toBeNull();
  });

  it("the conversation list marks a leased row 'In terminal'", () => {
    const target: SessionTarget = {
      ...session({ cli: LEASED }),
      originOnline: false,
      firstInstruction: null,
      ideaTitle: null,
    };
    const rows: ConversationRow[] = [
      { session: target, title: "Refactor the lease gate", ideaAnchored: false, status: null, inTerminal: true },
    ];
    const { container } = render(
      <ConversationList
        agents={[{ agentUuid: "agent-1", agentName: "Alpha" }]}
        selectedAgentUuid="agent-1"
        onSelectAgent={() => {}}
        rows={rows}
        selectedSessionUuid={null}
        onSelectSession={() => {}}
        onNewConversation={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(container.querySelector('[data-session-status="terminal"]')).not.toBeNull();
    expect(screen.getByText("In terminal")).toBeTruthy();
  });
});

describe("State 2 — unbound", () => {
  it("disables Send with the unbound reason (and no escape hatch)", () => {
    renderTranscript(
      session({ cli: { ...LEASED, leased: false }, originBound: false, originConnectionUuid: null }),
      [],
    );
    expect(screen.getByTestId("compose-disabled-reason").textContent).toContain(
      "No Chorus daemon is running for this agent on the conversation's origin machine and directory",
    );
    expect(
      (screen.getByPlaceholderText("Reply in this conversation…") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("running-in-terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue on an online directory" })).toBeNull();
  });

  it("a 409 session_unbound refusal flips the composer to the unbound reason", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        success: false,
        error: { code: "CONFLICT", message: "x", details: { reason: "session_unbound" } },
      }),
    });
    render(<ConversationReplyBox sessionUuid="sess-1" originOnline sendGate="open" />);
    const textarea = screen.getByPlaceholderText("Reply in this conversation…");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("compose-disabled-reason")).toBeTruthy());
    expect(screen.getByTestId("compose-disabled-reason").textContent).toContain("No Chorus daemon");
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining("No Chorus daemon"));
  });
});

describe("State 3 — not continuable", () => {
  it("disables Send with a reason distinct from unbound/offline", () => {
    renderTranscript(session({ cli: { ...LEASED, leased: false }, continuable: false }), [], true);
    const reason = screen.getByTestId("compose-disabled-reason").textContent ?? "";
    expect(reason).toContain("can't be continued from Chorus");
    expect(reason).not.toContain("No Chorus daemon");
    expect(reason).not.toContain("offline");
  });

  it("a queued turn retired as interrupted(session_not_continuable) says it was not delivered", () => {
    render(
      <TurnBand
        turn={turn({ status: "interrupted", interruptedReason: "session_not_continuable" })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByTestId("turn-not-continuable").textContent).toBe(
      "Not delivered — this conversation can't be continued from Chorus.",
    );
    // Not the misleading "ended without a reply" copy.
    expect(screen.queryByText(/without a reply/i)).toBeNull();
  });

  it("a 409 session_not_continuable refusal shows the not-continuable reason", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        success: false,
        error: { code: "CONFLICT", message: "x", details: { reason: "session_not_continuable" } },
      }),
    });
    render(<ConversationReplyBox sessionUuid="sess-1" originOnline sendGate="queued" />);
    const textarea = screen.getByPlaceholderText("Reply in this conversation…");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("compose-disabled-reason").textContent).toContain(
        "can't be continued from Chorus",
      ),
    );
  });
});
