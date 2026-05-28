// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import * as React from "react";

// Polyfill for Radix's measurement code paths inside the dialog.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    return typeof node === "string" ? node : `${ns ? ns + "." : ""}${key}`;
  }
  return {
    useTranslations: (ns?: string) => (key: string, _values?: Record<string, unknown>) =>
      resolveKey(ns ?? "", key),
  };
});

// framer-motion: pass-through so jsdom doesn't choke on its layout effects.
vi.mock("framer-motion", async () => {
  const ReactMod = await import("react");
  type DivProps = React.PropsWithChildren<React.HTMLAttributes<HTMLDivElement>> & {
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
    layout?: unknown;
  };
  const Div = ReactMod.forwardRef<HTMLDivElement, DivProps>((props, ref) => {
    const { initial, animate, exit, transition, layout, ...rest } = props;
    void initial;
    void animate;
    void exit;
    void transition;
    void layout;
    return ReactMod.createElement("div", { ref, ...rest });
  });
  return {
    motion: { div: Div, button: Div },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { GlobalSearch } from "@/components/global-search";

const sampleResults = [
  {
    entityType: "task" as const,
    uuid: "task-1",
    title: "Sample Task",
    projectUuid: "proj-1",
    updatedAt: new Date().toISOString(),
  },
];

async function openSearchAndLoadResults() {
  render(<GlobalSearch />);

  // Open the search dialog via Cmd+K (the only way the dialog mounts).
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
  });

  const input = (await screen.findByPlaceholderText(/search/i)) as HTMLInputElement;

  // Type a query — the component debounces 300ms before fetching.
  await act(async () => {
    fireEvent.change(input, { target: { value: "hello" } });
  });

  // Advance past the debounce window and let fetch resolve.
  await act(async () => {
    vi.advanceTimersByTime(350);
    // Flush microtasks
    await Promise.resolve();
    await Promise.resolve();
  });

  // Wait for results to render (selectedIndex becomes addressable).
  await waitFor(() => {
    expect(screen.queryByText("Sample Task")).toBeTruthy();
  });

  return input;
}

describe("GlobalSearch — Enter + IME composition", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { results: sampleResults, counts: { task: 1 } },
          }),
        } as Response)
      )
    );
  });

  it("does NOT navigate on Enter while IME is composing", async () => {
    const input = await openSearchAndLoadResults();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    });

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("DOES navigate on Enter when not composing", async () => {
    const input = await openSearchAndLoadResults();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/projects/proj-1/tasks/task-1");
  });
});
