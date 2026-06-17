// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next-intl: resolve real strings from the locale JSON (so a missing key shows
// as the dotted key path and fails the assertion), with ICU-ish `{param}`
// interpolation for keys like `summary` / `uptimeMonoDays`.
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

// The page wraps itself in a RealtimeProvider (so its execution pane gets live
// updates). The provider calls useRouter and opens an EventSource — neither
// exists in jsdom — so stub both. This file exercises the CONNECTION LIST, not
// live execution, so a no-op EventSource is sufficient.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

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

import AgentConnectionsPage from "@/app/(dashboard)/agent-connections/page";

// ===== Helpers =====

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

function respondWith(connections: Conn[]) {
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { connections } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = NoopEventSource;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Pin "now" a few minutes after the fixture timestamps so uptime is non-zero.
  vi.setSystemTime(new Date("2026-06-16T12:05:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderPage() {
  const utils = render(<AgentConnectionsPage />);
  // Let the initial fetch + state settle.
  await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("AgentConnectionsPage", () => {
  it("empty dataset renders the empty state, not a broken list", async () => {
    respondWith([]);
    await renderPage();
    await waitFor(() =>
      expect(screen.queryByText("No agent connections yet")).toBeTruthy(),
    );
    // No "select a connection" prompt and no rail header when there's nothing.
    expect(screen.queryByText("CONNECTIONS")).toBeNull();
  });

  it("default-selects the first connection's detail without flashing the select prompt", async () => {
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    await renderPage();

    // The desktop detail pane shows the first connection on first paint.
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0));
    // selectPrompt ("Select a connection …") must never appear when a default exists.
    expect(screen.queryByText(/Select a connection/)).toBeNull();
  });

  it("renders agentName as primary and demotes client type to a badge; null name → fallback", async () => {
    respondWith([conn({ uuid: "1", agentName: null, clientType: "openclaw" })]);
    await renderPage();
    // Fallback label appears (primary identity), and the client type label shows too.
    await waitFor(() =>
      expect(screen.getAllByText("Unknown agent").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThan(0);
  });

  it("shows a ticking monospace uptime for online connections only", async () => {
    respondWith([conn({ uuid: "1", effectiveStatus: "online" })]);
    await renderPage();
    // 5 minutes after connectedAt → 00:05:00
    await waitFor(() => expect(screen.getAllByText("00:05:00").length).toBeGreaterThan(0));
    // Advance the 1s ticker → uptime should advance to 00:05:01.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(screen.getAllByText("00:05:01").length).toBeGreaterThan(0));
  });

  it("offline connection shows no uptime value at all", async () => {
    respondWith([conn({ uuid: "1", effectiveStatus: "offline", status: "offline" })]);
    await renderPage();
    await waitFor(() => expect(screen.getAllByText(/Agent 1/).length).toBeGreaterThan(0));
    // No HH:MM:SS uptime anywhere for an offline connection.
    expect(screen.queryByText(/^\d{2}:\d{2}:\d{2}$/)).toBeNull();
  });

  // The mobile drill-down is gated by React state (mobileDetailOpen), not just a
  // CSS breakpoint, so its open/close is testable in jsdom even though both
  // compositions are present in the DOM. The "Back" affordance only renders
  // while the drill-down is open, so it is a reliable open/closed signal.
  it("mobile drill-down opens on card tap and closes on back", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    await renderPage();

    expect(screen.queryByRole("button", { name: /Connections/i })).toBeNull();

    // Tapping the mobile card for Bravo opens the drill-down.
    const bravoCard = screen.getAllByText("Bravo")[0].closest("button");
    expect(bravoCard).toBeTruthy();
    await user.click(bravoCard as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Connections/i })).toBeTruthy(),
    );

    // Back closes it.
    await user.click(screen.getByRole("button", { name: /Connections/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Connections/i })).toBeNull(),
    );
  });

  it("closes the mobile drill-down if the open connection disappears from a poll", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    await renderPage();

    // Drill into Bravo.
    const bravoCard = screen.getAllByText("Bravo")[0].closest("button");
    await user.click(bravoCard as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Connections/i })).toBeTruthy(),
    );

    // Next poll drops Bravo — the guard must close the drill-down rather than
    // silently swapping the open detail to a different agent.
    respondWith([conn({ uuid: "1", agentName: "Alpha" })]);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Connections/i })).toBeNull(),
    );
  });
});
