// @vitest-environment jsdom
//
// Drill-down rendering test for the sidebar presence pill popover (T2 + T11).
// Covers the spec requirements that an agent row EXPANDS (T11: collapsed by
// default — the per-cwd rows are revealed only after the user clicks the agent
// header toggle) to one instance sub-row per ONLINE connection — each with its
// own cwd (path-first) — that host is shown once for a single-host agent but
// promoted to a per-row suffix when the agent spans 2+ hosts, that a legacy
// null-cwd connection renders as an explicit "unknown path" instance, and that a
// long path keeps its final segment with the full path on hover (the T1
// formatter). Also covers the T11 online-only contract (an offline instance is
// hidden; an all-offline agent disappears) and that the agent starts COLLAPSED.
//
// The pill is rendered inside a real AgentPresenceProvider; authFetch is mocked
// + routed by URL and the SSE stream is a mock EventSource (no production seam),
// mirroring connections-execution-view.test.tsx.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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
        // Simple param substitution (matches the sibling execution-view test
        // mock). ICU plural strings are not expanded here — the tests assert on
        // the path/host text rather than the pluralized count labels (the count
        // derivation itself is covered by the pure instance-group unit tests).
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { AgentPresenceProvider } from "@/contexts/agent-presence-context";
import { AgentPresencePill } from "@/components/agent-presence-pill";

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockEventSource.OPEN;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

const NOW = "2026-06-23T12:00:00.000Z";

function conn(o: Record<string, unknown> & { uuid: string }) {
  return {
    agentUuid: "agent-1",
    agentName: "Admin Claude",
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "Laptop-Q3",
    cwd: "/home/u/dev/chorus",
    startedAt: NOW,
    status: "online",
    effectiveStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
    disconnectedAt: null,
    ...o,
  };
}

function routeFetch(connections: unknown[], executions: unknown[] = []) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { executions } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { connections } }),
    });
  });
}

async function openPopover(connections: unknown[], executions: unknown[] = []) {
  routeFetch(connections, executions);
  render(
    <AgentPresenceProvider>
      <AgentPresencePill />
    </AgentPresenceProvider>,
  );
  // Wait for the first poll to settle (the pill shows the online count).
  await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
  const trigger = await screen.findByLabelText("Online agents — open details");
  fireEvent.click(trigger);
}

// T11: the agent group is COLLAPSED by default — its per-cwd instance rows only
// render after the header toggle is clicked. Expand every agent header so the
// rows under test become visible (the `aria-label` is "Show <agent>'s working
// directories" while collapsed). Wrapped in waitFor so the header has rendered
// after the popover opened.
async function expandAllAgents() {
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /working directories/ }).length,
    ).toBeGreaterThan(0),
  );
  for (const toggle of screen.getAllByRole("button", {
    name: /Show .*working directories/,
  })) {
    fireEvent.click(toggle);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // @ts-expect-error inject mock EventSource
  global.EventSource = MockEventSource;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  mockAuthFetch.mockReset();
});

describe("presence pill drill-down", () => {
  it("starts COLLAPSED: instance rows are hidden until the agent is expanded", async () => {
    await openPopover([
      conn({ uuid: "c1", cwd: "/home/u/dev/chorus", host: "Laptop-Q3" }),
    ]);
    // The agent header renders (collapsed) but its per-cwd row is NOT visible yet.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Show .*working directories/ }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("…/dev/chorus")).toBeNull();
    // After expanding, the row appears and the toggle flips to the collapse label.
    fireEvent.click(
      screen.getByRole("button", { name: /Show .*working directories/ }),
    );
    await waitFor(() => expect(screen.getByText("…/dev/chorus")).toBeTruthy());
    expect(
      screen.getByRole("button", { name: /Hide .*working directories/ }),
    ).toBeTruthy();
  });

  it("expands an agent into one instance sub-row per cwd connection", async () => {
    await openPopover([
      conn({ uuid: "c1", cwd: "/home/u/dev/chorus", host: "Laptop-Q3" }),
      conn({ uuid: "c2", cwd: "/home/u/dev/chorus-cdk", host: "Laptop-Q3" }),
    ]);
    await expandAllAgents();
    // The path chip renders the abbreviated tail (last 2 segments) as one node;
    // two distinct cwds → two distinct instance sub-rows under the one agent.
    await waitFor(() => {
      expect(screen.getByText("…/dev/chorus")).toBeTruthy();
      expect(screen.getByText("…/dev/chorus-cdk")).toBeTruthy();
    });
    // One agent header (not two): both instances are grouped under it.
    expect(screen.getAllByText("Admin Claude")).toHaveLength(1);
  });

  it("shows host once at the header for a single-host agent (no per-row suffix)", async () => {
    await openPopover([
      conn({ uuid: "c1", cwd: "/home/u/dev/chorus", host: "Laptop-Q3" }),
      conn({ uuid: "c2", cwd: "/home/u/dev/other", host: "Laptop-Q3" }),
    ]);
    await expandAllAgents();
    await waitFor(() => expect(screen.getByText("…/dev/chorus")).toBeTruthy());
    // Header subline carries the single host exactly once (not per-row).
    const hostMatches = screen.getAllByText(/Laptop-Q3/);
    expect(hostMatches).toHaveLength(1);
  });

  it("promotes host to a per-row suffix when the agent spans 2+ hosts", async () => {
    await openPopover([
      conn({ uuid: "c1", cwd: "/home/u/dev/chorus", host: "Laptop-Q3" }),
      conn({ uuid: "c2", cwd: "/home/u/dev/chorus", host: "ci-runner-02" }),
    ]);
    await expandAllAgents();
    await waitFor(() => expect(screen.getAllByText("…/dev/chorus").length).toBe(2));
    // Both hosts now appear (one per instance row) so the two same-cwd rows
    // stay distinguishable.
    expect(screen.getByText("Laptop-Q3")).toBeTruthy();
    expect(screen.getByText("ci-runner-02")).toBeTruthy();
  });

  it("renders a legacy null-cwd ONLINE connection as an explicit 'unknown path' instance", async () => {
    // A null-cwd connection that is still ONLINE is a live instance (the offline
    // 'unknown path' rows are what T11 hides — see the online-only test below).
    await openPopover([conn({ uuid: "c1", cwd: null })]);
    await expandAllAgents();
    await waitFor(() => expect(screen.getByText("unknown path")).toBeTruthy());
  });

  it("keeps a long path's final segment and exposes the full path on hover", async () => {
    await openPopover([
      conn({
        uuid: "c1",
        cwd: "/home/u/dev/payments-platform/services/billing-api",
      }),
    ]);
    await expandAllAgents();
    // The abbreviated tail keeps the final segment (billing-api) intact.
    await waitFor(() =>
      expect(screen.getByText("…/services/billing-api")).toBeTruthy(),
    );
    // The chip's title is the full absolute path (hover reveal).
    const chip = screen.getByTitle(
      "/home/u/dev/payments-platform/services/billing-api",
    );
    expect(chip).toBeTruthy();
  });

  it("online-only: hides an offline sibling instance and drops an all-offline agent", async () => {
    await openPopover([
      // Agent A: one online + one OFFLINE instance — only the online one shows.
      conn({
        uuid: "a-online",
        agentUuid: "A",
        agentName: "Agent A",
        cwd: "/home/u/dev/live",
        effectiveStatus: "online",
      }),
      conn({
        uuid: "a-offline",
        agentUuid: "A",
        agentName: "Agent A",
        cwd: "/home/u/dev/stale",
        effectiveStatus: "offline",
      }),
      // Agent B: entirely offline — its header does not appear at all.
      conn({
        uuid: "b-offline",
        agentUuid: "B",
        agentName: "Agent B",
        cwd: "/home/u/dev/gone",
        effectiveStatus: "offline",
      }),
    ]);
    // Agent A is the only group; Agent B (all-offline) is absent.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Show Agent A.*working directories/ }),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: /Agent B.*working directories/ }),
    ).toBeNull();
    // Expanding Agent A reveals only its ONLINE instance, never the offline one.
    fireEvent.click(
      screen.getByRole("button", { name: /Show Agent A.*working directories/ }),
    );
    await waitFor(() => expect(screen.getByText("…/dev/live")).toBeTruthy());
    expect(screen.queryByText("…/dev/stale")).toBeNull();
  });
});
