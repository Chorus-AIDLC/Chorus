// @vitest-environment jsdom
//
// Local daemon-presence E2E guard: render the resident shell-level presence
// provider + sidebar pill, then drive two poll refreshes whose connection
// payloads are the same logical set in different raw orders. The visible agent
// groups and expanded cwd rows must keep the same DOM order.
//
// Command:
//   pnpm test src/components/agent-presence/__tests__/presence-refresh-stability.e2e.test.tsx

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionView } from "@/components/agent-presence";

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

function conn(overrides: Partial<ConnectionView> & Pick<ConnectionView, "uuid">): ConnectionView {
  return {
    agentUuid: "agent-alpha",
    agentName: "Alpha Agent",
    ownerUuid: null,
    clientType: "claude_code",
    clientVersion: "0.12.0",
    host: "host-a",
    cwd: "/work/a",
    startedAt: NOW,
    status: "online",
    effectiveStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
    disconnectedAt: null,
    ...overrides,
  };
}

function agentLabelsInDomOrder(): string[] {
  return screen
    .getAllByRole("button", { name: /working directories/ })
    .map((button) => button.textContent ?? "")
    .map((text) => text.match(/Alpha Agent|Beta Agent/)?.[0])
    .filter((name): name is string => Boolean(name));
}

function cwdTitlesInDomOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("span[title^='/work/']"))
    .map((el) => el.getAttribute("title"))
    .filter((title): title is string => Boolean(title));
}

async function expandAllAgents() {
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /Show .*working directories/ }).length,
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

describe("daemon presence refresh stability E2E", () => {
  it("keeps visible agent and cwd DOM order stable across shuffled refresh payloads", async () => {
    const stableConnections = [
      conn({
        uuid: "alpha-z",
        agentUuid: "agent-alpha",
        agentName: "Alpha Agent",
        cwd: "/work/z",
      }),
      conn({
        uuid: "beta-b",
        agentUuid: "agent-beta",
        agentName: "Beta Agent",
        host: "host-b",
        cwd: "/work/b",
      }),
      conn({
        uuid: "alpha-a",
        agentUuid: "agent-alpha",
        agentName: "Alpha Agent",
        cwd: "/work/a",
      }),
    ];
    const shuffledConnections = [
      stableConnections[1],
      stableConnections[0],
      stableConnections[2],
    ];
    let connectionPolls = 0;
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/daemon/executions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { executions: [] } }),
        });
      }
      const connections =
        connectionPolls++ === 0 ? stableConnections : shuffledConnections;
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { connections } }),
      });
    });

    render(
      <AgentPresenceProvider>
        <AgentPresencePill />
      </AgentPresenceProvider>,
    );

    await waitFor(() => expect(connectionPolls).toBe(1));
    fireEvent.click(await screen.findByLabelText("Online agents — open details"));
    await waitFor(() =>
      expect(agentLabelsInDomOrder()).toEqual(["Alpha Agent", "Beta Agent"]),
    );

    await expandAllAgents();
    await waitFor(() =>
      expect(cwdTitlesInDomOrder()).toEqual(["/work/a", "/work/z", "/work/b"]),
    );

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(connectionPolls).toBeGreaterThanOrEqual(2));

    await waitFor(() =>
      expect(agentLabelsInDomOrder()).toEqual(["Alpha Agent", "Beta Agent"]),
    );
    expect(cwdTitlesInDomOrder()).toEqual(["/work/a", "/work/z", "/work/b"]);
  });
});
