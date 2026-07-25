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

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

function renderBand(t: TurnWithMessagesView) {
  return render(<TurnBand turn={t} agentName="Alpha" linkedExecution={null} />);
}

beforeEach(() => {
  // jsdom lacks ResizeObserver; Radix Popover content uses it when opened (the badge tests).
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

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

describe("TurnBand empty-terminal instruction (fix #444)", () => {
  const emptyInstruction = (overrides: Partial<TurnWithMessagesView> = {}) =>
    turn({
      trigger: "human_instruction",
      promptText: "does app/samples exist?",
      status: "ended",
      messages: [],
      ...overrides,
    });

  it("renders the 'ended without a reply' band (no retry button) for an empty terminal human_instruction turn", () => {
    render(<TurnBand turn={emptyInstruction()} agentName="Alpha" linkedExecution={null} />);
    expect(screen.getByText("No reply was received from the agent on this turn.")).toBeTruthy();
    // The neutral placeholder is NOT shown for this case, and there is no retry button
    // (the user simply re-asks in the reply box below).
    expect(screen.queryByText("No transcript retained for this turn.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("also covers an INTERRUPTED empty human_instruction turn (terminal)", () => {
    render(
      <TurnBand
        turn={emptyInstruction({ status: "interrupted", interruptedReason: "offline" })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByText("No reply was received from the agent on this turn.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("keeps the neutral placeholder for an empty AUTONOMOUS turn", () => {
    render(
      <TurnBand
        turn={turn({ trigger: "task_assigned", promptText: null, status: "ended", messages: [] })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByText("No transcript retained for this turn.")).toBeTruthy();
    expect(screen.queryByText("No reply was received from the agent on this turn.")).toBeNull();
  });

  it("does NOT show the no-reply band for a still-RUNNING instruction turn (not terminal)", () => {
    render(
      <TurnBand
        turn={emptyInstruction({ status: "running", endedAt: null })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.queryByText("No reply was received from the agent on this turn.")).toBeNull();
  });
});

describe("TurnBand transcript-relay failure (fix #444 follow-up)", () => {
  const RELAY_MSG = "The agent replied, but the reply could not be uploaded to Chorus:";
  const NO_REPLY_MSG = "No reply was received from the agent on this turn.";

  it("shows the 'reply couldn't be uploaded' band (not 'no reply') when relayError is set", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "does app/samples exist?",
          status: "ended",
          relayError: "transcript upload returned 502",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByText(RELAY_MSG)).toBeTruthy();
    // The KNOWN-cause copy REPLACES the misleading "no reply received" wording.
    expect(screen.queryByText(NO_REPLY_MSG)).toBeNull();
  });

  it("shows the raw daemon reason DIRECTLY (inline, no hover)", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "p",
          status: "ended",
          relayError: "transcript upload returned 502",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    // The error text is rendered as its own visible line, not tucked behind a title attr.
    expect(screen.getByText("transcript upload returned 502")).toBeTruthy();
  });

  it("never offers a Retry for a relay-drop (the produced reply can't be recovered)", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "does app/samples exist?",
          status: "ended",
          relayError: "network error",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("covers a relay-drop on an INTERRUPTED terminal turn too", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "p",
          status: "interrupted",
          interruptedReason: "crash",
          relayError: "transcript upload returned 502",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByText(RELAY_MSG)).toBeTruthy();
    expect(screen.getByText("transcript upload returned 502")).toBeTruthy();
  });

  it("shows the relay-drop band for an autonomous turn too (cause reported, no retry)", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "task_assigned",
          promptText: null,
          status: "ended",
          relayError: "transcript upload returned 502",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.getByText(RELAY_MSG)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("does NOT show the relay band when the turn actually has messages (partial drop out of scope)", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "p",
          status: "ended",
          relayError: "transcript upload returned 502",
          messages: [
            {
              uuid: "m1",
              turnUuid: "t1",
              role: "assistant",
              text: "partial reply that did land",
              seq: 1,
              createdAt: "2026-07-04T03:01:00.000Z",
            },
          ],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.queryByText(RELAY_MSG)).toBeNull();
    expect(screen.getByText("partial reply that did land")).toBeTruthy();
  });

  it("does NOT show the relay band on a still-RUNNING turn (not terminal)", () => {
    render(
      <TurnBand
        turn={turn({
          trigger: "human_instruction",
          promptText: "p",
          status: "running",
          endedAt: null,
          relayError: "transcript upload returned 502",
          messages: [],
        })}
        agentName="Alpha"
        linkedExecution={null}
      />,
    );
    expect(screen.queryByText(RELAY_MSG)).toBeNull();
  });
});

describe("TurnBand — per-turn token usage badge (daemon-token-usage)", () => {
  const usage = {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 24701,
    cacheReadTokens: 0,
    model: "claude-opus-4-8",
    source: "claude_code",
  };

  it("shows a compact input+output total (cache NOT folded in)", () => {
    renderBand(turn({ status: "ended", usage }));
    // 1200 + 340 = 1540 → "1.5k tok" (cache 24701 is excluded from the headline).
    expect(screen.getByText("1.5k tok")).toBeTruthy();
    // The alarming cache number must NOT appear as the badge's visible headline.
    expect(screen.queryByText(/24,?701 tok/)).toBeNull();
  });

  it("exposes the summed total via an aria-label on the badge trigger", () => {
    renderBand(turn({ status: "ended", usage }));
    // Headline aria (input + output = 1540). The breakdown Popover content isn't in the DOM
    // until the badge is clicked, so we assert the always-present accessible label here.
    expect(screen.getByLabelText(/1540 tokens/)).toBeTruthy();
  });

  it("opens the breakdown on CLICK and it PERSISTS (Popover, not a hover tooltip)", () => {
    renderBand(turn({ status: "ended", usage }));
    const badge = screen.getByLabelText(/Token usage/);
    fireEvent.click(badge);
    // Breakdown rows are present after the click and stay (Popover) — includes cache since
    // the per-turn badge tooltip carries it. Portalled + possibly duplicated → getAllByText.
    expect(screen.getAllByText("Input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Output").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cache read").length).toBeGreaterThan(0);
    // Still open after a microtask tick (no hover-out auto-close) — content persists.
    expect(screen.getAllByText("Model").length).toBeGreaterThan(0);
  });

  it("renders NO badge for a turn with null usage (no misleading zero)", () => {
    renderBand(turn({ status: "ended", usage: null }));
    expect(screen.queryByText(/tok$/)).toBeNull();
    expect(screen.queryByLabelText(/Token usage/)).toBeNull();
  });

  it("renders NO badge when usage exists but both token counts are null", () => {
    renderBand(
      turn({
        status: "ended",
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheCreationTokens: null,
          cacheReadTokens: null,
          model: "claude-opus-4-8",
          source: "claude_code",
        },
      }),
    );
    expect(screen.queryByLabelText(/Token usage/)).toBeNull();
  });

  it("renders NO badge for an all-ZERO usage (superseded/duplicate turn — no misleading '0 tok')", () => {
    // Seen live on turn 8: a duplicate/superseded instruction produced a 0/0/0/0 result
    // frame. Per the no-misleading-zeros rule the badge must render nothing, not "0 tok".
    renderBand(
      turn({
        status: "ended",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          model: null,
          source: "claude_code",
        },
      }),
    );
    expect(screen.queryByText(/tok$/)).toBeNull();
    expect(screen.queryByLabelText(/Token usage/)).toBeNull();
  });

  it("DOES render when only cache tokens are present (cache-only turn still had activity)", () => {
    renderBand(
      turn({
        status: "ended",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 1200,
          model: "claude-opus-4-8",
          source: "claude_code",
        },
      }),
    );
    // Headline is in+out = 0, but the turn DID consume cache → badge shows (tooltip has cache).
    expect(screen.getByText("0 tok")).toBeTruthy();
  });
});
