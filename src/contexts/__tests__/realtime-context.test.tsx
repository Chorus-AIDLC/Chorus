// @vitest-environment jsdom
//
// Frontend hook integration test for `useRealtimeEntityTypeEvent` (Q7 = b).
//
// Test seam: we replace `globalThis.EventSource` with a minimal stub that
// captures the most recently constructed instance, so the test can drive
// `onmessage` directly. No production-code seam is required — `EventSource`
// is the provider's only external dependency for SSE input.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import {
  RealtimeProvider,
  useRealtimeEntityTypeEvent,
} from "@/contexts/realtime-context";

// next/navigation is imported transitively by the provider via useRealtimeRefresh-adjacent
// hooks; useRealtimeEntityTypeEvent itself doesn't use it, but the module-level import
// resolves it. Provide a minimal stub.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

interface CapturedEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
}

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
    lastEventSource = this;
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  lastEventSource = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource;
});

const PROJECT_UUID = "00000000-0000-4000-8000-0000000000aa";
const COMPANY_UUID = "00000000-0000-4000-8000-0000000000bb";

function dispatchSseMessage(payload: Record<string, unknown>) {
  if (!lastEventSource?.onmessage) {
    throw new Error("EventSource onmessage not yet bound");
  }
  // MessageEvent only needs the `.data` field for the provider's parser.
  lastEventSource.onmessage({ data: JSON.stringify(payload) } as MessageEvent);
}

const ENTITY_DEBOUNCE_MS = 300;

function HookHarness({
  entityTypes,
  onEvent,
}: {
  entityTypes: string | string[];
  onEvent: (event: { entityType: string; entityUuid: string; action: string }) => void;
}) {
  useRealtimeEntityTypeEvent(entityTypes, onEvent);
  return <div data-testid="harness">ok</div>;
}

describe("useRealtimeEntityTypeEvent", () => {
  it("fires the callback once when a matching `document/created` event arrives", () => {
    const cb = vi.fn();
    render(
      <RealtimeProvider projectUuid={PROJECT_UUID}>
        <HookHarness entityTypes="document" onEvent={cb} />
      </RealtimeProvider>,
    );

    expect(lastEventSource).not.toBeNull();
    expect(lastEventSource?.url).toContain(`projectUuid=${PROJECT_UUID}`);

    act(() => {
      dispatchSseMessage({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "document",
        entityUuid: "doc-1",
        action: "created",
      });
    });

    // Hook should NOT have fired yet — debounce window is 300ms.
    expect(cb).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(ENTITY_DEBOUNCE_MS);
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "document",
        entityUuid: "doc-1",
        action: "created",
      }),
    );
  });

  it("fires the callback once when a matching `idea/updated` event arrives", () => {
    const cb = vi.fn();
    render(
      <RealtimeProvider projectUuid={PROJECT_UUID}>
        <HookHarness entityTypes="idea" onEvent={cb} />
      </RealtimeProvider>,
    );

    act(() => {
      dispatchSseMessage({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "idea",
        entityUuid: "idea-1",
        action: "updated",
      });
    });

    act(() => {
      vi.advanceTimersByTime(ENTITY_DEBOUNCE_MS);
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "idea",
        entityUuid: "idea-1",
        action: "updated",
      }),
    );
  });

  it("does NOT fire the callback when a non-matching entityType event arrives", () => {
    const cb = vi.fn();
    render(
      <RealtimeProvider projectUuid={PROJECT_UUID}>
        <HookHarness entityTypes="document" onEvent={cb} />
      </RealtimeProvider>,
    );

    act(() => {
      dispatchSseMessage({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "task",
        entityUuid: "task-1",
        action: "updated",
      });
    });

    act(() => {
      vi.advanceTimersByTime(ENTITY_DEBOUNCE_MS);
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it("supports an array of entity types and only fires for matching members", () => {
    const cb = vi.fn();
    render(
      <RealtimeProvider projectUuid={PROJECT_UUID}>
        <HookHarness entityTypes={["document", "idea"]} onEvent={cb} />
      </RealtimeProvider>,
    );

    act(() => {
      dispatchSseMessage({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "proposal",
        entityUuid: "p-1",
        action: "updated",
      });
    });
    act(() => {
      vi.advanceTimersByTime(ENTITY_DEBOUNCE_MS);
    });
    expect(cb).not.toHaveBeenCalled();

    act(() => {
      dispatchSseMessage({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "idea",
        entityUuid: "idea-2",
        action: "updated",
      });
    });
    act(() => {
      vi.advanceTimersByTime(ENTITY_DEBOUNCE_MS);
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", entityUuid: "idea-2" }),
    );
  });
});
