// @vitest-environment jsdom
//
// ConversationalEntry unit tests (add-conversational-idea-entry). The component
// is presentational + transport: presence-based online detection, agent +
// instance selection, char-budgeted compose, ad-hoc dispatch. The presence spine
// is mocked at the hook seam (`useAgentPresenceOptional`) — these tests are about
// THIS component's gating/composition, not the provider (covered elsewhere).
//
// Covers the task's AC:
//   - offline gating: null context / zero online connections → offline fallback
//     with the shared DaemonConnectCta (command constant, not i18n),
//   - grouping + selection: agent Select only when 2+ agents online; the picked
//     agent's instances feed the shared InstancePicker; sole instance
//     auto-selects; 2+ instances gate Send until an explicit pick,
//   - dispatch: exactly one POST to /api/daemon-sessions/ad-hoc with the
//     CONSUMER-composed instruction; onStarted receives the created SessionView,
//   - char budget: text over USER_TEXT_MAX_CHARS blocks Send with a visible
//     counter,
//   - 409 path: inline retryable error + refreshConnections() re-poll,
//   - IME guard: a composing Enter never dispatches.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ uuid: "project-1" }),
}));

// Presence spine mocked at the hook seam: each test sets the value.
const mockPresence = vi.fn();
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => mockPresence(),
}));

import {
  ConversationalEntry,
  ConversationalDispatchError,
  USER_TEXT_MAX_CHARS,
} from "../conversational-entry";
import { DAEMON_START_COMMAND } from "../daemon-connect-cta";

type Conn = {
  uuid: string;
  agentUuid: string;
  agentName: string | null;
  clientType: string;
  clientVersion: string | null;
  host: string;
  cwd: string | null;
  startedAt: string | null;
  status: string;
  effectiveStatus: "online" | "offline";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
};

function conn(overrides: Partial<Conn> & { uuid: string }): Conn {
  const now = "2026-07-03T09:00:00.000Z";
  return {
    agentUuid: "agent-1",
    agentName: "Alpha",
    clientType: "claude_code",
    clientVersion: "0.13.0",
    host: "host-a",
    cwd: `/work/${overrides.uuid}`,
    startedAt: now,
    status: "online",
    effectiveStatus: "online",
    connectedAt: now,
    lastSeenAt: now,
    disconnectedAt: null,
    ...overrides,
  };
}

const mockRefreshConnections = vi.fn();

function setPresence(connections: Conn[] | null) {
  if (connections === null) {
    mockPresence.mockReturnValue(null);
    return;
  }
  mockPresence.mockReturnValue({
    connections,
    refreshConnections: mockRefreshConnections,
  });
}

const createdSession = {
  uuid: "s-new",
  agentUuid: "agent-1",
  sessionId: "sid-new",
  directIdeaUuid: null,
  originConnectionUuid: "c1",
  status: "active",
  title: null,
  lastTurnAt: "2026-07-03T09:01:00.000Z",
  createdAt: "2026-07-03T09:01:00.000Z",
  updatedAt: "2026-07-03T09:01:00.000Z",
};

function respondOk() {
  mockAuthFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { session: createdSession } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom lacks the pointer-capture + scroll APIs Radix Select touches.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.HTMLElement.prototype as any).hasPointerCapture = vi.fn(() => false);
  (window.HTMLElement.prototype as any).setPointerCapture = vi.fn();
  (window.HTMLElement.prototype as any).releasePointerCapture = vi.fn();
  (window.HTMLElement.prototype as any).scrollIntoView = vi.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe("ConversationalEntry — offline gating", () => {
  it("keeps an offline project-fixed anchor visible instead of falling back", async () => {
    setPresence([conn({ uuid: "c1", effectiveStatus: "offline" })]);
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          agents: [
            {
              agent: { uuid: "agent-1", name: "Alpha" },
              preference: {
                host: "fixed-host",
                cwd: "/offline/fixed",
                status: "offline",
                anchorAgentInstanceUuid: "fixed-instance",
              },
            },
          ],
        },
      }),
    });

    render(
      <ConversationalEntry
        projectUuid="project-1"
        dispatch={vi.fn()}
        onStarted={vi.fn()}
      />,
    );

    expect(await screen.findByText("/offline/fixed")).toBeTruthy();
    expect(screen.getByText("Host offline")).toBeTruthy();
    expect(screen.queryByText(DAEMON_START_COMMAND)).toBeNull();
    expect(
      (screen.getByRole("button", { name: /Send to agent/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders the offline fallback with the shared daemon CTA when no connection is online", () => {
    setPresence([conn({ uuid: "c1", effectiveStatus: "offline" })]);
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    expect(
      screen.getByText(
        "No agent daemon is online right now. Start one to describe your idea in a conversation:",
      ),
    ).toBeTruthy();
    // The startup command comes from the shared constant (never i18n-hardcoded).
    expect(screen.getByText(DAEMON_START_COMMAND)).toBeTruthy();
  });

  it("treats an absent presence provider exactly like zero online connections", () => {
    setPresence(null);
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    expect(screen.getByText(DAEMON_START_COMMAND)).toBeTruthy();
  });

  it("renders a consumer-provided offlineFallback instead of the default CTA", () => {
    setPresence([]);
    render(
      <ConversationalEntry
        buildInstruction={(t) => t}
        onStarted={vi.fn()}
        offlineFallback={<div>custom-fallback</div>}
      />,
    );
    expect(screen.getByText("custom-fallback")).toBeTruthy();
    expect(screen.queryByText(DAEMON_START_COMMAND)).toBeNull();
  });
});

describe("ConversationalEntry — selection", () => {
  it("project-fixed cwd hides the instance picker without repeating the project-level summary", async () => {
    setPresence([
      conn({ uuid: "c1", host: "fixed-host", cwd: "/startup" }),
      conn({ uuid: "c2", host: "other-host", cwd: "/other" }),
    ]);
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          agents: [
            {
              agent: { uuid: "agent-1", name: "Alpha" },
              preference: {
                host: "fixed-host",
                cwd: "/srv/project",
                status: "valid",
                anchorAgentInstanceUuid: "fixed-instance",
              },
            },
          ],
        },
      }),
    });

    render(
      <ConversationalEntry
        projectUuid="project-1"
        dispatch={vi.fn()}
        onStarted={vi.fn()}
      />,
    );

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(screen.queryByText("/srv/project")).toBeNull();
    expect(screen.queryByText("fixed-host")).toBeNull();
    expect(screen.queryByText("other")).toBeNull();
  });

  it("sole agent + sole instance: agent Select still shows the agent's NAME, instance auto-selected, Send enabled once text present", async () => {
    setPresence([conn({ uuid: "c1" })]);
    respondOk();
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    // The agent Select is ALWAYS rendered — even a sole agent's name must be
    // visible (owner feedback), preselected in the trigger.
    const trigger = screen.getByLabelText("Agent");
    expect(trigger.textContent).toContain("Alpha");
    const send = screen.getByRole("button", { name: /Send to agent/ });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "Build a thing" },
    });
    await waitFor(() =>
      expect((send as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("multiple instances gate Send until an explicit pick", async () => {
    setPresence([
      conn({ uuid: "c1", cwd: "/work/a" }),
      conn({ uuid: "c2", cwd: "/work/b" }),
    ]);
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "Build a thing" },
    });
    const send = screen.getByRole("button", { name: /Send to agent/ });
    // Two instances, none picked → still disabled.
    expect((send as HTMLButtonElement).disabled).toBe(true);
    // Pick one (rows are clickable presentation divs; click the path chip text).
    const user = userEvent.setup();
    await user.click(screen.getByText("work/a"));
    await waitFor(() =>
      expect((send as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("groups by agent: the agent Select appears with 2+ online agents and switching resets the instance pick", async () => {
    setPresence([
      conn({ uuid: "c1", agentUuid: "agent-1", agentName: "Alpha", cwd: "/work/a" }),
      conn({ uuid: "c2", agentUuid: "agent-2", agentName: "Bravo", cwd: "/work/b1" }),
      conn({ uuid: "c3", agentUuid: "agent-2", agentName: "Bravo", cwd: "/work/b2" }),
    ]);
    const user = userEvent.setup();
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    // Two agents online → the Select renders with no default (no sole group).
    const trigger = screen.getByLabelText("Agent");
    expect(screen.getByText("Pick an agent")).toBeTruthy();
    await user.click(trigger);
    // The option now leads with the agent's avatar (alt/aria-label = the name),
    // so match the name as a substring rather than the full accessible name.
    await user.click(screen.getByRole("option", { name: /Bravo/ }));
    // Bravo has two instances → both listed, none auto-picked.
    await waitFor(() => expect(screen.getByText("work/b1")).toBeTruthy());
    expect(screen.getByText("work/b2")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    expect(
      (screen.getByRole("button", { name: /Send to agent/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("ConversationalEntry — dispatch", () => {
  it("sends exactly one ad-hoc POST with the consumer-composed instruction and hands the SessionView to onStarted", async () => {
    setPresence([conn({ uuid: "c1" })]);
    respondOk();
    const onStarted = vi.fn();
    render(
      <ConversationalEntry
        buildInstruction={(t) => `TEMPLATE(project-x)\n---\n${t}`}
        onStarted={onStarted}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "  Build a thing  " },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(createdSession));
    const calls = mockAuthFetch.mock.calls.filter(
      (c) => c[0] === "/api/daemon-sessions/ad-hoc",
    );
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      agentUuid: "agent-1",
      connectionUuid: "c1",
      // Trimmed user text passes through the consumer's template verbatim.
      instructionText: "TEMPLATE(project-x)\n---\nBuild a thing",
    });
  });

  it("blocks Send with a visible counter when the text exceeds the char budget", () => {
    setPresence([conn({ uuid: "c1" })]);
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={vi.fn()} />,
    );
    const over = "x".repeat(USER_TEXT_MAX_CHARS + 1);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: over },
    });
    expect(
      screen.getByText(`${USER_TEXT_MAX_CHARS + 1} / ${USER_TEXT_MAX_CHARS}`),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Send to agent/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("409 (connection went offline) shows a retryable inline error and re-polls the connection list", async () => {
    setPresence([conn({ uuid: "c1" })]);
    mockAuthFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: "Connection is offline" }),
    });
    const onStarted = vi.fn();
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={onStarted} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    // The server reason renders inline, the list re-polls, nothing hands off.
    await waitFor(() =>
      expect(screen.getByText("Connection is offline")).toBeTruthy(),
    );
    expect(mockRefreshConnections).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    // The action relabels to Retry (still enabled for another attempt).
    expect(
      (screen.getByRole("button", { name: /Retry/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("plain Enter sends; a composing (IME) Enter does not", async () => {
    setPresence([conn({ uuid: "c1" })]);
    respondOk();
    const onStarted = vi.fn();
    render(
      <ConversationalEntry buildInstruction={(t) => t} onStarted={onStarted} />,
    );
    const textarea = screen.getByPlaceholderText(/Describe what you want/);
    fireEvent.change(textarea, { target: { value: "你好世界" } });

    // Composing Enter (IME candidate confirm) — must NOT dispatch. jsdom
    // supports `isComposing` in the KeyboardEvent init dict.
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(mockAuthFetch).not.toHaveBeenCalled();

    // Plain Enter — dispatches.
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(
      mockAuthFetch.mock.calls.filter(
        (c) => c[0] === "/api/daemon-sessions/ad-hoc",
      ).length,
    ).toBe(1);
  });
});

// ===== Custom dispatch prop (add-conversational-idea-root-session) =====
describe("ConversationalEntry — custom dispatch", () => {
  const ideaSession = { ...createdSession, sessionId: "idea-1", directIdeaUuid: "idea-1" };

  it("calls the supplied dispatch with the RAW trimmed text (no ad-hoc POST, no buildInstruction) and hands its SessionView to onStarted", async () => {
    setPresence([conn({ uuid: "c1" })]);
    const dispatch = vi.fn().mockResolvedValue(ideaSession);
    const onStarted = vi.fn();
    render(<ConversationalEntry dispatch={dispatch} onStarted={onStarted} />);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "  Build a thing  " },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(ideaSession));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      agentUuid: "agent-1",
      connectionUuid: "c1",
      userText: "Build a thing",
    });
    // The default transport must NOT fire when a custom dispatch is present.
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("a 409 ConversationalDispatchError shows the retryable offline error and re-polls connections", async () => {
    setPresence([conn({ uuid: "c1" })]);
    const dispatch = vi
      .fn()
      .mockRejectedValue(new ConversationalDispatchError(409, "Connection is offline"));
    const onStarted = vi.fn();
    render(<ConversationalEntry dispatch={dispatch} onStarted={onStarted} />);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() =>
      expect(screen.getByText("Connection is offline")).toBeTruthy(),
    );
    expect(mockRefreshConnections).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /Retry/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a 409 without a server message falls back to the offline copy", async () => {
    setPresence([conn({ uuid: "c1" })]);
    const dispatch = vi
      .fn()
      .mockRejectedValue(new ConversationalDispatchError(409, null));
    render(<ConversationalEntry dispatch={dispatch} onStarted={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() =>
      expect(
        screen.getByText("That daemon went offline just now. Pick another instance and retry."),
      ).toBeTruthy(),
    );
    expect(mockRefreshConnections).toHaveBeenCalledTimes(1);
  });

  it("a non-409 dispatch failure surfaces the server reason inline without re-polling", async () => {
    setPresence([conn({ uuid: "c1" })]);
    const dispatch = vi
      .fn()
      .mockRejectedValue(new ConversationalDispatchError(400, "Description too long"));
    const onStarted = vi.fn();
    render(<ConversationalEntry dispatch={dispatch} onStarted={onStarted} />);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() =>
      expect(screen.getByText("Description too long")).toBeTruthy(),
    );
    expect(mockRefreshConnections).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("a non-typed rejection surfaces the generic send error (never silent)", async () => {
    setPresence([conn({ uuid: "c1" })]);
    const dispatch = vi.fn().mockRejectedValue(new Error("network down"));
    render(<ConversationalEntry dispatch={dispatch} onStarted={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want/), {
      target: { value: "hello" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Send to agent/ }));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to reach the agent. Please retry."),
      ).toBeTruthy(),
    );
  });
});
