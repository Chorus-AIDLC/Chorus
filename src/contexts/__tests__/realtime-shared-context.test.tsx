// @vitest-environment jsdom

import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardEventProvider } from "@/contexts/dashboard-event-context";
import {
  RealtimeProvider,
  useExecutionSubscription,
  usePresenceSubscription,
  useRealtimeEntityTypeEvent,
  useRealtimeEvent,
} from "@/contexts/realtime-context";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

function Consumers({
  general,
  entity,
  presence,
  execution,
}: {
  general: () => void;
  entity: () => void;
  presence: () => void;
  execution: () => void;
}) {
  useRealtimeEvent(general);
  useRealtimeEntityTypeEvent("task", entity);
  usePresenceSubscription(presence);
  useExecutionSubscription("connection-1", execution);
  return null;
}

function Shared({
  projectUuid,
  callbacks,
}: {
  projectUuid: string;
  callbacks: {
    general: () => void;
    entity: () => void;
    presence: () => void;
    execution: () => void;
  };
}) {
  return (
    <DashboardEventProvider>
      <RealtimeProvider projectUuid={projectUuid}>
        <Consumers {...callbacks} />
      </RealtimeProvider>
    </DashboardEventProvider>
  );
}

function emit(payload: Record<string, unknown>) {
  MockEventSource.instances.at(-1)?.onmessage?.({
    data: JSON.stringify(payload),
  } as MessageEvent);
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RealtimeProvider shared dashboard transport", () => {
  it("filters project events before all work but keeps execution company-visible", () => {
    const callbacks = {
      general: vi.fn(),
      entity: vi.fn(),
      presence: vi.fn(),
      execution: vi.fn(),
    };
    render(<Shared projectUuid="project-a" callbacks={callbacks} />);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(callbacks.general).toHaveBeenCalledTimes(1); // hook initial fetch

    act(() => {
      emit({
        companyUuid: "company",
        projectUuid: "project-b",
        entityType: "task",
        entityUuid: "task-b",
        action: "updated",
      });
      emit({
        type: "presence",
        companyUuid: "company",
        projectUuid: "project-b",
      });
      vi.advanceTimersByTime(5_000);
    });
    expect(callbacks.general).toHaveBeenCalledTimes(1);
    expect(callbacks.entity).not.toHaveBeenCalled();
    expect(callbacks.presence).not.toHaveBeenCalled();

    act(() => {
      emit({
        companyUuid: "company",
        projectUuid: "project-a",
        entityType: "task",
        entityUuid: "task-a",
        action: "updated",
      });
      emit({
        type: "presence",
        companyUuid: "company",
        projectUuid: "project-a",
      });
      emit({
        type: "execution",
        companyUuid: "company",
        projectUuid: "project-b",
        connectionUuid: "connection-1",
        executions: [],
      });
      vi.advanceTimersByTime(3_000);
    });
    expect(callbacks.general).toHaveBeenCalledTimes(2);
    expect(callbacks.entity).toHaveBeenCalledTimes(1);
    expect(callbacks.presence).toHaveBeenCalledTimes(1);
    expect(callbacks.execution).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect for project navigation and catches up only after a reopen", () => {
    const callbacks = {
      general: vi.fn(),
      entity: vi.fn(),
      presence: vi.fn(),
      execution: vi.fn(),
    };
    const view = render(<Shared projectUuid="project-a" callbacks={callbacks} />);
    const source = MockEventSource.instances[0];
    const initialGeneralCalls = callbacks.general.mock.calls.length;

    act(() => source.onopen?.());
    expect(callbacks.general).toHaveBeenCalledTimes(initialGeneralCalls);

    view.rerender(<Shared projectUuid="project-b" callbacks={callbacks} />);
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => source.onopen?.());
    expect(callbacks.general).toHaveBeenCalledTimes(initialGeneralCalls + 1);
    expect(callbacks.entity).toHaveBeenCalledTimes(1);
  });

  it("retains a project-scoped standalone fallback and closes it on unmount", () => {
    const callbacks = {
      general: vi.fn(),
      entity: vi.fn(),
      presence: vi.fn(),
      execution: vi.fn(),
    };
    const view = render(
      <RealtimeProvider projectUuid="project/a">
        <Consumers {...callbacks} />
      </RealtimeProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(
      "/api/events?projectUuid=project%2Fa",
    );

    view.unmount();
    expect(MockEventSource.instances[0].close).toHaveBeenCalledOnce();
  });
});
