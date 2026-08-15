// @vitest-environment jsdom
//
// TurnBand — merged-events collapse (daemon-merged-turn-transcript). Pins the Spec
// requirement "The absorbing turn exposes an expandable merged-events section":
//   - a collapsed-by-default "merged N events" disclosure whose label reflects the
//     EXACT count (real ICU plural: 1 → "merged 1 event", 2 → "merged 2 events"),
//   - expanding lists each coalesced-away event's provenance (trigger label + prompt),
//   - an entity deep link when the merged event's execution resolves,
//   - the disclosure is a real <button> (touch/keyboard-activatable, not hover-only),
//   - no disclosure at all for an ordinary turn.
//
// Unlike the sibling turn-band tests (which use a plain string-substitution mock), this
// file formats through the REAL ICU engine so the plural label is exercised end to end.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IntlMessageFormat } from "intl-messageformat";

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
        const msg = resolve(namespace, key);
        try {
          return String(new IntlMessageFormat(msg, "en").format(params ?? {}));
        } catch {
          return msg;
        }
      },
  };
});

import { TurnBand, type MergedEvent } from "../chat/turn-band";
import type { ExecutionView } from "../types";
import type { TurnWithMessagesView } from "@/services/daemon-session.service";

function turn(overrides: Partial<TurnWithMessagesView> = {}): TurnWithMessagesView {
  return {
    uuid: "t1",
    sessionUuid: "s1",
    seq: 1,
    trigger: "task_assigned",
    promptText: null,
    status: "ended",
    interruptedReason: null,
    relayError: null,
    usage: null,
    executionUuid: null,
    startedAt: "2026-07-04T03:00:00.000Z",
    endedAt: "2026-07-04T03:05:00.000Z",
    createdAt: "2026-07-04T02:59:00.000Z",
    messages: [],
    ...overrides,
  };
}

function mergedEvents(count: number): MergedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    turn: turn({
      uuid: `m${i}`,
      seq: 11 + i,
      trigger: "mentioned",
      promptText: `merged prompt ${i}`,
      status: "merged",
    }),
    linkedExecution: null,
  }));
}

beforeEach(() => {
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => cleanup());

describe("TurnBand merged-events section", () => {
  it("renders a collapsed-by-default 'merged N events' disclosure whose label is the exact plural count", () => {
    render(
      <TurnBand
        turn={turn({ status: "ended", seq: 10 })}
        agentName="Alpha"
        linkedExecution={null}
        mergedEvents={mergedEvents(2)}
      />,
    );
    expect(screen.getByRole("button", { name: /merged 2 events/i })).toBeTruthy();
    // Collapsed by default → the merged events' prompt bodies are not rendered yet.
    expect(screen.queryByText("merged prompt 0")).toBeNull();
  });

  it("uses the singular ICU form for a single merged event", () => {
    render(
      <TurnBand
        turn={turn({ status: "ended", seq: 10 })}
        agentName="Alpha"
        linkedExecution={null}
        mergedEvents={mergedEvents(1)}
      />,
    );
    expect(screen.getByRole("button", { name: /^merged 1 event$/i })).toBeTruthy();
  });

  it("expands to list each merged event's provenance (trigger label + prompt), one row per event", () => {
    render(
      <TurnBand
        turn={turn({ status: "ended", seq: 10 })}
        agentName="Alpha"
        linkedExecution={null}
        mergedEvents={mergedEvents(2)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /merged 2 events/i }));
    // Exactly N rows: both prompts now visible + both trigger labels.
    expect(screen.getByText("merged prompt 0")).toBeTruthy();
    expect(screen.getByText("merged prompt 1")).toBeTruthy();
    expect(screen.getAllByText("Mention")).toHaveLength(2);
  });

  it("shows an entity deep link for a merged event whose execution resolves", () => {
    const linked = {
      entityType: "task",
      entityUuid: "task-9",
      projectUuid: "p1",
    } as unknown as ExecutionView;
    render(
      <TurnBand
        turn={turn({ status: "ended", seq: 10 })}
        agentName="Alpha"
        linkedExecution={null}
        mergedEvents={[
          { turn: turn({ uuid: "m0", seq: 11, trigger: "task_assigned", status: "merged" }), linkedExecution: linked },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /merged 1 event/i }));
    const link = screen.getByRole("link", { name: /Open task/i });
    expect(link.getAttribute("href")).toBe("/projects/p1/tasks/task-9");
  });

  it("renders no merged-events disclosure for an ordinary turn (no merged events)", () => {
    render(<TurnBand turn={turn({ status: "ended" })} agentName="Alpha" linkedExecution={null} />);
    expect(screen.queryByRole("button", { name: /merged/i })).toBeNull();
  });
});
