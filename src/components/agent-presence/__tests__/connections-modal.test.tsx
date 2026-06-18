// @vitest-environment jsdom
//
// Modal-relocation test for the Agent Connections view (was the standalone page).
//
// The former `/agent-connections` page is gone — its master-detail view now lives
// in the "View all" modal, hosted in the dashboard shell and opened from the
// sidebar popover's "View all" button (which calls setModalOpen(true) on the
// shared AgentPresenceProvider). These tests render a REAL AgentPresenceProvider
// (the production data spine: one /api/agent-connections poll + one
// /api/daemon/executions aggregate fetch + one /api/events SSE) wrapping a tiny
// "View all" trigger and the AgentConnectionsModal, and assert:
//   - the modal opens on the trigger (the popover→View all→modal path) and shows
//     the same connection-list data the former page did,
//   - master-detail defaults to the first connection without flashing the prompt,
//   - agent name is primary identity, client type a secondary badge,
//   - uptime ticks for online connections and is absent for offline,
//   - the mobile drill-down opens/closes and self-closes when its connection drops.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next-intl: resolve real en strings (a missing key surfaces as its dotted path
// and fails the assertion), with `{param}` interpolation for keys like `summary`.
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
  return (
    <Button onClick={() => setModalOpen(true)}>view-all-trigger</Button>
  );
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

// Route authFetch by URL: connection list vs. aggregate executions read.
function respondWith(connections: Conn[], executions: unknown[] = []) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { executions } }),
      });
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Pin "now" a few minutes after the fixture timestamps so uptime is non-zero.
  vi.setSystemTime(new Date("2026-06-16T12:05:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// Render the provider + the View-all trigger + the modal (the shell wiring), let
// the initial provider fetches settle, then open the modal via the trigger.
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
  // The modal is closed until the (popover) "View all" trigger fires.
  await user.click(screen.getByText("view-all-trigger"));
  return { user, ...utils };
}

describe("Agent Connections modal — opening + connection list", () => {
  it("opens the modal from the 'View all' trigger (no standalone page navigation)", async () => {
    respondWith([conn({ uuid: "1", agentName: "Alpha" })]);
    await renderAndOpenModal();
    // The modal title (Agent Connections) appears once opened.
    await waitFor(() =>
      expect(screen.getAllByText("Agent Connections").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });

  it("empty dataset renders the empty state, not a broken list", async () => {
    respondWith([]);
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.queryByText("No agent connections yet")).toBeTruthy(),
    );
    // No rail header when there's nothing.
    expect(screen.queryByText("CONNECTIONS")).toBeNull();
  });

  it("default-selects the first connection's detail without flashing the select prompt", async () => {
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    await renderAndOpenModal();

    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Select a connection/)).toBeNull();
  });

  it("renders agentName as primary and demotes client type to a badge; null name → fallback", async () => {
    respondWith([conn({ uuid: "1", agentName: null, clientType: "openclaw" })]);
    await renderAndOpenModal();
    await waitFor(() =>
      expect(screen.getAllByText("Unknown agent").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThan(0);
  });

  it("shows a ticking monospace uptime for online connections only", async () => {
    respondWith([conn({ uuid: "1", effectiveStatus: "online" })]);
    await renderAndOpenModal();
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
    await renderAndOpenModal();
    await waitFor(() => expect(screen.getAllByText(/Agent 1/).length).toBeGreaterThan(0));
    // No HH:MM:SS uptime anywhere for an offline connection.
    expect(screen.queryByText(/^\d{2}:\d{2}:\d{2}$/)).toBeNull();
  });

  it("mobile drill-down opens on card tap and closes on back", async () => {
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    const { user } = await renderAndOpenModal();

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
    respondWith([
      conn({ uuid: "1", agentName: "Alpha" }),
      conn({ uuid: "2", agentName: "Bravo" }),
    ]);
    const { user } = await renderAndOpenModal();

    // Drill into Bravo.
    const bravoCard = screen.getAllByText("Bravo")[0].closest("button");
    await user.click(bravoCard as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Connections/i })).toBeTruthy(),
    );

    // Next provider poll drops Bravo — the guard must close the drill-down rather
    // than silently swapping the open detail to a different agent.
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
