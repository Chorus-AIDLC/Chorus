// @vitest-environment jsdom

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardEventProvider } from "@/contexts/dashboard-event-context";
import {
  NotificationProvider,
  useNotification,
} from "@/contexts/notification-context";
import { AgentPresenceProvider } from "@/contexts/agent-presence-context";
import { RealtimeProvider } from "@/contexts/realtime-context";

const authFetch = vi.fn();
const toast = vi.fn();
const stableMocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  translate: (key: string) => key,
}));

vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => stableMocks.router,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => stableMocks.translate,
}));
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toast(...args) }));

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

function Count() {
  const { unreadCount } = useNotification();
  return <div data-testid="count">{unreadCount}</div>;
}

let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  authFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { unreadCount: 1 } }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationProvider shared transport", () => {
  it("uses receive-time visibility, updates hidden unread, and reconciles without reconnecting", async () => {
    render(
      <DashboardEventProvider>
        <NotificationProvider>
          <AgentPresenceProvider>
            <RealtimeProvider projectUuid="project-a">
              <Count />
            </RealtimeProvider>
          </AgentPresenceProvider>
        </NotificationProvider>
      </DashboardEventProvider>,
    );
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events");

    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "new_notification",
          unreadCount: 2,
          action: "mentioned",
          actorName: "Ada",
          entityTitle: "Task",
        }),
      } as MessageEvent);
    });
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(toast).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "new_notification",
          unreadCount: 3,
          action: "mentioned",
          actorName: "Ada",
          entityTitle: "Task",
        }),
      } as MessageEvent);
    });
    expect(screen.getByTestId("count").textContent).toBe("3");
    expect(toast).toHaveBeenCalledTimes(1);

    const notificationFetchesBeforeVisible = authFetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/notifications"),
    ).length;
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { unreadCount: 7 } }),
    });
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("count").textContent).toBe("7");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(
      authFetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/notifications"),
      ),
    ).toHaveLength(notificationFetchesBeforeVisible + 1);
  });
});
