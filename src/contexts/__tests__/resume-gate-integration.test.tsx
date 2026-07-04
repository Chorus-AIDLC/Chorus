// @vitest-environment jsdom
//
// Context-level tests for the resume gate integration (sse-resume-timing spec):
// each SSE provider's visibility-resume handler must defer its ENTIRE body —
// the EventSource reconnect AND the accompanying fetches — until the gate
// settles (or the hard timeout releases it), and must re-check visibility
// after the wait. Initial-mount connections are NOT gated.
//
// Test seams (same as the sibling context tests): `authFetch` mocked,
// `globalThis.EventSource` stubbed. The resume gate is the REAL module —
// tests drive it via arm/settle and assert deferred side effects.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import {
  settleResumeRevalidation,
  RESUME_GATE_TIMEOUT_MS,
  __resetResumeGateForTests,
} from "@/lib/resume-gate";

// ---- Shared mocks ----
const authFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (url: string, opts?: RequestInit) => authFetch(url, opts),
}));
vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

// ---- EventSource stub ----
interface CapturedEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
}
let eventSourceConstructions: string[] = [];
let lastEventSource: CapturedEventSource | null = null;
class MockEventSource implements CapturedEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockEventSource.OPEN;
  constructor(url: string) {
    this.url = url;
    eventSourceConstructions.push(url);
    lastEventSource = this;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

import { NotificationProvider } from "@/contexts/notification-context";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { AgentPresenceProvider } from "@/contexts/agent-presence-context";

let visibilityState: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// Flush pending microtasks (promise continuations) inside act.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  eventSourceConstructions = [];
  lastEventSource = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  authFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { unreadCount: 0, connections: [], executions: [] } }),
  });
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  __resetResumeGateForTests();
});

afterEach(() => {
  __resetResumeGateForTests();
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource;
});

describe("notification-context resume gate", () => {
  it("connects and fetches immediately at mount (ungated)", async () => {
    render(<NotificationProvider>{null}</NotificationProvider>);
    await flush();
    expect(eventSourceConstructions.filter((u) => u.includes("/api/events/notifications"))).toHaveLength(1);
    expect(authFetch.mock.calls.some((c) => String(c[0]).includes("/api/notifications"))).toBe(true);
  });

  it("defers resume reconnect AND unread-count fetch until settle", async () => {
    render(<NotificationProvider>{null}</NotificationProvider>);
    await flush();
    const baselineConnections = eventSourceConstructions.length;
    authFetch.mockClear();

    // Background then resume. NOTE: the gate's own module listener arms on the
    // visible transition, BEFORE the provider's async handler awaits it.
    setVisibility("hidden");
    setVisibility("visible");
    await flush();

    // Gate armed and unsettled → nothing has fired yet.
    expect(eventSourceConstructions.length).toBe(baselineConnections);
    expect(authFetch).not.toHaveBeenCalled();

    act(() => settleResumeRevalidation());
    await flush();

    expect(eventSourceConstructions.length).toBe(baselineConnections + 1);
    expect(authFetch.mock.calls.some((c) => String(c[0]).includes("/api/notifications"))).toBe(true);
  });

  it("skips resume work when the tab went hidden again during the wait", async () => {
    render(<NotificationProvider>{null}</NotificationProvider>);
    await flush();
    const baselineConnections = eventSourceConstructions.length;
    authFetch.mockClear();

    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    // Hidden again while the handler awaits the gate.
    visibilityState = "hidden";

    act(() => settleResumeRevalidation());
    await flush();

    expect(eventSourceConstructions.length).toBe(baselineConnections);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("is released by the hard timeout when nothing settles the gate", async () => {
    vi.useFakeTimers();
    try {
      render(<NotificationProvider>{null}</NotificationProvider>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const baselineConnections = eventSourceConstructions.length;
      authFetch.mockClear();

      setVisibility("hidden");
      setVisibility("visible");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(eventSourceConstructions.length).toBe(baselineConnections);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RESUME_GATE_TIMEOUT_MS);
      });

      expect(eventSourceConstructions.length).toBe(baselineConnections + 1);
      expect(authFetch.mock.calls.some((c) => String(c[0]).includes("/api/notifications"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("realtime-context resume gate", () => {
  it("defers resume reconnect and catch-up fan-out until settle", async () => {
    render(<RealtimeProvider>{null}</RealtimeProvider>);
    await flush();
    const baselineConnections = eventSourceConstructions.length;

    // Kill the stream so the resume path takes the connectionLost branch.
    lastEventSource!.readyState = MockEventSource.CLOSED;

    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    expect(eventSourceConstructions.length).toBe(baselineConnections);

    act(() => settleResumeRevalidation());
    await flush();
    expect(eventSourceConstructions.length).toBe(baselineConnections + 1);
  });

  it("re-checks visibility after the wait", async () => {
    render(<RealtimeProvider>{null}</RealtimeProvider>);
    await flush();
    const baselineConnections = eventSourceConstructions.length;
    lastEventSource!.readyState = MockEventSource.CLOSED;

    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    visibilityState = "hidden";

    act(() => settleResumeRevalidation());
    await flush();
    expect(eventSourceConstructions.length).toBe(baselineConnections);
  });
});

describe("agent-presence-context resume gate", () => {
  it("defers resume reconnect AND executions re-fetch until settle", async () => {
    render(<AgentPresenceProvider>{null}</AgentPresenceProvider>);
    await flush();
    const baselineConnections = eventSourceConstructions.length;

    // Make the stream unhealthy so the resume path reconnects.
    lastEventSource!.readyState = MockEventSource.CLOSED;
    authFetch.mockClear();

    setVisibility("hidden");
    setVisibility("visible");
    await flush();

    expect(eventSourceConstructions.length).toBe(baselineConnections);
    // No executions re-fetch before settle.
    expect(
      authFetch.mock.calls.filter((c) => String(c[0]).includes("executions"))
    ).toHaveLength(0);

    act(() => settleResumeRevalidation());
    await flush();

    expect(eventSourceConstructions.length).toBe(baselineConnections + 1);
    expect(
      authFetch.mock.calls.filter((c) => String(c[0]).includes("executions"))
    ).not.toHaveLength(0);
  });
});
