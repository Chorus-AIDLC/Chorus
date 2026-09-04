// @vitest-environment jsdom

import React, { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardEventProvider,
  useDashboardEvents,
} from "@/contexts/dashboard-event-context";

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

function Harness({
  project,
  onEvent,
  onGeneration,
  exposeSession,
}: {
  project: string;
  onEvent: (event: Record<string, unknown>) => void;
  onGeneration: (generation: number) => void;
  exposeSession: (setter: (uuid: string | null) => void) => void;
}) {
  const events = useDashboardEvents();
  useEffect(() => events.subscribe(onEvent), [events.subscribe, onEvent]);
  useEffect(() => onGeneration(events.openGeneration), [
    events.openGeneration,
    onGeneration,
  ]);
  useEffect(() => exposeSession(events.setSessionUuid), [
    events.setSessionUuid,
    exposeSession,
  ]);
  return <div>{project}</div>;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DashboardEventProvider", () => {
  it("keeps one stream across child navigation and reconnects only for session selection", () => {
    const onEvent = vi.fn();
    const onGeneration = vi.fn();
    let setSessionUuid: (uuid: string | null) => void = () => {};
    const exposeSession = (setter: typeof setSessionUuid) => {
      setSessionUuid = setter;
    };

    const view = render(
      <DashboardEventProvider>
        <Harness
          project="project-a"
          onEvent={onEvent}
          onGeneration={onGeneration}
          exposeSession={exposeSession}
        />
      </DashboardEventProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events");

    view.rerender(
      <DashboardEventProvider>
        <Harness
          project="project-b"
          onEvent={onEvent}
          onGeneration={onGeneration}
          exposeSession={exposeSession}
        />
      </DashboardEventProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => setSessionUuid("session with space"));
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].close).toHaveBeenCalledOnce();
    expect(MockEventSource.instances[1].url).toBe(
      "/api/events?sessionUuid=session%20with%20space",
    );
  });

  it("dispatches an in-band stream_reset to subscribers on open, ordered before any message", () => {
    const received: Array<Record<string, unknown>> = [];
    render(
      <DashboardEventProvider>
        <Harness
          project="project-a"
          onEvent={(event) => received.push(event)}
          onGeneration={() => {}}
          exposeSession={() => {}}
        />
      </DashboardEventProvider>,
    );
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({ type: "presence", projectUuid: "project-a" }),
      } as MessageEvent);
    });

    // onopen fires before any onmessage (EventSource spec), and the reset is
    // dispatched synchronously inside onopen — so subscribers see stream_reset
    // strictly before the connection's first replayed message. This ordering is
    // what eliminates the wipe-vs-replay race.
    expect(received[0]).toEqual({ type: "stream_reset" });
    expect(received[1]).toEqual({ type: "presence", projectUuid: "project-a" });
  });

  it("parses once, fans out events, increments opens, recovers visibility, and cleans up", () => {
    const onEvent = vi.fn();
    const onGeneration = vi.fn();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const view = render(
      <DashboardEventProvider>
        <Harness
          project="project-a"
          onEvent={onEvent}
          onGeneration={onGeneration}
          exposeSession={() => {}}
        />
      </DashboardEventProvider>,
    );
    const first = MockEventSource.instances[0];

    act(() => {
      first.onmessage?.({
        data: JSON.stringify({ type: "presence", projectUuid: "project-a" }),
      } as MessageEvent);
      first.onopen?.();
      first.onopen?.();
    });
    // The presence message is fanned out once; each onopen ALSO fans out a
    // synthetic stream_reset (in-band connect reset), so filter those to assert
    // the parsed message delivery.
    const nonReset = onEvent.mock.calls.filter(
      ([event]) => (event as { type?: unknown }).type !== "stream_reset",
    );
    expect(nonReset).toHaveLength(1);
    expect(nonReset[0][0]).toEqual({
      type: "presence",
      projectUuid: "project-a",
    });
    expect(onEvent).toHaveBeenCalledWith({ type: "stream_reset" });
    expect(onGeneration).toHaveBeenLastCalledWith(2);

    act(() => {
      first.readyState = MockEventSource.CONNECTING;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(MockEventSource.instances).toHaveLength(2);
    expect(first.close).toHaveBeenCalledOnce();

    const recovered = MockEventSource.instances[1];
    view.unmount();
    expect(recovered.close).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });
});
