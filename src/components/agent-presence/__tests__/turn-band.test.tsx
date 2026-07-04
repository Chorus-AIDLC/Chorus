// @vitest-environment jsdom
//
// TurnBand — interrupted-turn presentation (fix-daemon-exit-orphan-running-turn).
// Pins the delta spec `daemon-session-transcript-read` ADDED requirement:
//   - an `interrupted` turn shows a localized "Interrupted" badge,
//   - it renders structurally like a terminal state: no spinner, no running pulse,
//   - it is distinguishable from a plain `ended` turn (distinct label + tone),
//   - `interruptedReason` is consumed from the view (surfaced as the badge title).
// next-intl resolves real en.json strings (a missing key surfaces as its dotted
// path and fails the assertion), matching the sibling agent-presence tests.

import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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

import { TurnBand } from "../chat/turn-band";
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
    executionUuid: null,
    startedAt: "2026-07-04T03:00:00.000Z",
    endedAt: "2026-07-04T03:05:00.000Z",
    createdAt: "2026-07-04T02:59:00.000Z",
    messages: [],
    ...overrides,
  };
}

function renderBand(t: TurnWithMessagesView) {
  return render(<TurnBand turn={t} agentName="Alpha" linkedExecution={null} />);
}

afterEach(() => cleanup());

describe("TurnBand interrupted presentation", () => {
  it("shows the localized Interrupted badge with the reason as its title", () => {
    renderBand(turn({ status: "interrupted", interruptedReason: "offline" }));
    const badge = screen.getByText("Interrupted");
    expect(badge).toBeTruthy();
    // interruptedReason is consumed from the view (surfaced via the title attr).
    expect(badge.closest("[title]")?.getAttribute("title")).toBe("offline");
  });

  it("renders as a quiet terminal state: no spinner, no running pulse", () => {
    const { container } = renderBand(
      turn({ status: "interrupted", interruptedReason: "shutdown" }),
    );
    // No Loader2 spinner (running-only) and no pulse overlay (running-only).
    expect(container.querySelector(".motion-safe\\:animate-spin")).toBeNull();
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
    // The spine is the quiet hairline, not the active terracotta.
    expect(container.querySelector(".bg-\\[\\#C67A52\\]")).toBeNull();
  });

  it("is distinguishable from a plain ended turn (different label)", () => {
    renderBand(turn({ status: "ended" }));
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByText("Interrupted")).toBeNull();
    cleanup();
    renderBand(turn({ status: "interrupted", interruptedReason: "crash" }));
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.queryByText("Ended")).toBeNull();
  });

  it("a running turn still shows Running with its spinner (unchanged)", () => {
    const { container } = renderBand(turn({ status: "running", endedAt: null }));
    expect(screen.getByText("Running")).toBeTruthy();
    expect(container.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
  });

  it("an interrupted turn without a reason renders the badge with no title", () => {
    renderBand(turn({ status: "interrupted", interruptedReason: null }));
    const badge = screen.getByText("Interrupted");
    expect(badge.closest("[title]")).toBeNull();
  });
});
