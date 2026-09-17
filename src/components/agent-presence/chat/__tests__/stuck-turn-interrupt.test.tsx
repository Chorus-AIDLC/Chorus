// @vitest-environment jsdom
//
// A `running` turn ALWAYS offers an interrupt control (fix-phantom-running-turn C2).
//
// Renders the real TranscriptView → ConversationReplyBox → ComposeField → InterruptButton
// chain, so what is asserted is the whole path a human actually clicks:
//   - a `running` turn with NO matching execution row still renders the control, and the
//     POST it fires targets the CONVERSATION'S OWN session key on its ORIGIN connection,
//     with the stuck-turn ("clear the turn") copy — the phantom-turn escape hatch;
//   - a matching `running` execution row keeps the ORIGINAL control, copy and target
//     (the execution row's own connection/entity) — unchanged behaviour;
//   - an idle conversation (no `running` turn, no execution) renders NO interrupt control;
//   - the origin-offline read-only notice gains its "the stuck turn can still be cleared
//     here" clause ONLY when a stuck-turn target exists.
//
// next-intl resolves real en.json strings (a missing key surfaces as its dotted path and
// would fail these text assertions). The transcript body (TurnBand) and the usage badge are
// stubbed — this is about the footer control, not turn rendering.

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

// The transcript body + usage badge are irrelevant here.
vi.mock("../turn-band", () => ({ TurnBand: () => <div data-testid="turn-band" /> }));
vi.mock("../token-usage-badge", () => ({ SessionUsageBadge: () => null }));

import { TranscriptView } from "../transcript-view";
import type { ConnectionView, ExecutionView } from "../../types";
import type {
  SessionView,
  TurnWithMessagesView,
} from "@/services/daemon-session.service";

const NOW = "2026-09-17T12:00:00.000Z";
const IDEA = "idea-aaaa";
const CONN_ORIGIN = "conn-origin";

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    uuid: "sess-uuid-1",
    agentUuid: "agent-1",
    sessionId: IDEA,
    backendSessionId: null,
    directIdeaUuid: IDEA,
    originConnectionUuid: CONN_ORIGIN,
    status: "active",
    title: "Converge phantom turns",
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

function turn(status: string, seq = 1): TurnWithMessagesView {
  return {
    uuid: `turn-${seq}`,
    sessionUuid: "sess-uuid-1",
    backendSessionId: null,
    seq,
    trigger: "human_instruction",
    promptText: "go",
    status,
    interruptedReason: null,
    relayError: null,
    usage: null,
    executionUuid: null,
    startedAt: NOW,
    endedAt: null,
    createdAt: NOW,
    messages: [],
  };
}

function connection(): ConnectionView {
  return {
    uuid: CONN_ORIGIN,
    agentUuid: "agent-1",
    agentName: "Admin Claude",
    ownerUuid: null,
    clientType: "claude_code",
    clientVersion: "0.18.1",
    host: "host-1",
    cwd: "/home/u/dev/chorus",
    startedAt: NOW,
    status: "online",
    effectiveStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
  } as ConnectionView;
}

function runningExecution(): ExecutionView {
  return {
    uuid: "exec-1",
    agentUuid: "agent-1",
    connectionUuid: "conn-live",
    entityType: "idea",
    entityUuid: IDEA,
    entityTitle: "Converge phantom turns",
    rootIdeaUuid: null,
    directIdeaUuid: IDEA,
    status: "running",
    interruptedReason: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    projectUuid: null,
    rootIdeaTitle: null,
  } as unknown as ExecutionView;
}

// A STALE TERMINAL row: the daemon reported this execution interrupted, but the session's
// turn is still `running` server-side (the terminal turn report was lost). The two
// disagree, so this row is NOT a live run — the turn must still be clearable.
function staleInterruptedExecution(
  reason: "user" | "crash" = "user",
): ExecutionView {
  return {
    ...runningExecution(),
    uuid: "exec-stale",
    status: "interrupted",
    interruptedReason: reason,
  } as unknown as ExecutionView;
}

function renderView(over: {
  turns: TurnWithMessagesView[];
  sessionExecutions?: ExecutionView[];
  originOnline?: boolean;
  session?: SessionView;
}) {
  return render(
    <TranscriptView
      session={over.session ?? session()}
      turns={over.turns}
      title="Converge phantom turns"
      loading={false}
      error={false}
      originConnection={connection()}
      originOnline={over.originOnline ?? true}
      sessionExecutions={over.sessionExecutions ?? []}
      executionsByUuid={new Map()}
      hasMoreEarlier={false}
      loadingEarlier={false}
      onLoadEarlier={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements no scrolling; the pane auto-scrolls to its newest turn on mount.
  Element.prototype.scrollIntoView = vi.fn();
  mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {} }) });
});

afterEach(() => cleanup());

describe("a running turn always offers an interrupt control", () => {
  it("running turn with NO matching execution → control renders and targets the session's own key on its origin connection", async () => {
    renderView({ turns: [turn("running")] });

    // The control is present even though nothing matched in the execution snapshot.
    fireEvent.click(screen.getByRole("button", { name: /Clear this stuck turn/i }));

    // The stuck-turn confirm copy — never "we stopped a running process".
    expect(await screen.findByText("Clear this stuck turn?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear the turn" }));

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(url).toBe("/api/daemon/control");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      command: "interrupt",
      // The ORIGIN connection of the conversation, and the conversation's own
      // idea-anchored control key — derived from the session, not from any row.
      targetConnectionUuid: CONN_ORIGIN,
      entityType: "idea",
      entityUuid: IDEA,
    });
  });

  it("an AD-HOC conversation's stuck turn targets daemon_session:<sessionId>", async () => {
    renderView({
      turns: [turn("running")],
      session: session({ sessionId: "sess-xyz", directIdeaUuid: null }),
    });

    fireEvent.click(screen.getByRole("button", { name: /Clear this stuck turn/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear the turn" }));

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(mockAuthFetch.mock.calls[0][1].body);
    expect(body.entityType).toBe("daemon_session");
    expect(body.entityUuid).toBe("sess-xyz");
  });

  it("a matching RUNNING execution keeps the original control copy and targets that row", async () => {
    renderView({ turns: [turn("running")], sessionExecutions: [runningExecution()] });

    fireEvent.click(screen.getByRole("button", { name: /Interrupt this running execution/i }));

    // Unchanged copy: the live-process confirm, NOT the stuck-turn one.
    expect(await screen.findByText("Interrupt this execution?")).toBeTruthy();
    expect(screen.queryByText("Clear this stuck turn?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(mockAuthFetch.mock.calls[0][1].body);
    // The execution row's OWN connection — a cross-connection match still stops the right
    // subprocess, so the stuck-turn fallback must not hijack it.
    expect(body.targetConnectionUuid).toBe("conn-live");
  });

  it.each(["user", "crash"] as const)(
    "a STALE interrupted(%s) row alongside a running turn is still clearable (Resume alone would strand it)",
    async (reason) => {
      renderView({
        turns: [turn("running")],
        sessionExecutions: [staleInterruptedExecution(reason)],
      });

      // The stuck-turn control wins over the stale row's Resume: the turn is what is
      // wrong, and Resume would leave it `running` forever.
      expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Clear this stuck turn/i }));
      fireEvent.click(await screen.findByRole("button", { name: "Clear the turn" }));

      await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
      const body = JSON.parse(mockAuthFetch.mock.calls[0][1].body);
      // Targeted at the CONVERSATION's own key + origin connection, not the stale row's.
      expect(body).toEqual({
        command: "interrupt",
        targetConnectionUuid: CONN_ORIGIN,
        entityType: "idea",
        entityUuid: IDEA,
      });
    },
  );

  it("a stale interrupted row with NO running turn still offers Resume (unchanged behaviour)", () => {
    renderView({
      turns: [turn("ended")],
      sessionExecutions: [staleInterruptedExecution("user")],
    });

    expect(screen.getByRole("button", { name: /resume/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear this stuck turn/i })).toBeNull();
  });

  it.each([
    [true, /Cleared the stuck turn/],
    [false, /Asked the daemon to stop/],
  ])(
    "the success toast reflects whether the server actually settled (settled=%s)",
    async (settled, expected) => {
      mockAuthFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { dispatched: true, settled } }),
      });
      renderView({ turns: [turn("running")] });

      fireEvent.click(screen.getByRole("button", { name: /Clear this stuck turn/i }));
      fireEvent.click(await screen.findByRole("button", { name: "Clear the turn" }));

      // `settled: false` means the command was only FORWARDED to a live daemon — claiming
      // "cleared" there would be a success the user cannot verify.
      await waitFor(() => expect(mockToast.success).toHaveBeenCalledTimes(1));
      expect(mockToast.success.mock.calls[0][0]).toMatch(expected);
    },
  );

  it("an idle conversation (no running turn, no execution) renders NO interrupt control", () => {
    renderView({ turns: [turn("ended")] });

    expect(
      screen.queryByRole("button", { name: /Interrupt this running execution/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear this stuck turn/i })).toBeNull();
  });

  it("no interrupt control for a conversation with only pending turns", () => {
    renderView({ turns: [turn("pending")] });

    expect(
      screen.queryByRole("button", { name: /Interrupt this running execution/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear this stuck turn/i })).toBeNull();
  });
});

describe("the origin-offline read-only notice", () => {
  it("gains the 'can still be cleared here' clause when a stuck turn is clearable", () => {
    renderView({ turns: [turn("running")], originOnline: false });

    expect(
      screen.getByText(/The stuck turn can still be cleared here\./),
    ).toBeTruthy();
    // And the control itself is reachable — the action group is not behind the
    // origin-offline gate.
    expect(
      screen.getByRole("button", { name: /Clear this stuck turn/i }),
    ).toBeTruthy();
  });

  it("is UNCHANGED (no extra clause) when there is no stuck turn to clear", () => {
    renderView({ turns: [turn("ended")], originOnline: false });

    expect(screen.queryByText(/The stuck turn can still be cleared here\./)).toBeNull();
    expect(
      screen.getByText(/This conversation's origin daemon is offline, so it's read-only\./),
    ).toBeTruthy();
  });
});
