// @vitest-environment jsdom
//
// ConversationList — the LEFT pane of the daemon chat modal. These tests cover the
// list card's three mutually-exclusive body states, the crux of the "loading vs empty"
// disambiguation fix: while the session list is still loading the card MUST show skeleton
// placeholder rows (not the empty state), so an in-flight load is never mistaken for a
// genuinely empty list. next-intl is mocked to resolve real en.json strings so a missing
// key surfaces as its dotted path (same harness as the other agent-presence tests). The
// relative-time hooks are stubbed to keep rendering deterministic and Date-free.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json")).default as Record<
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
      (key: string) =>
        resolve(namespace, key),
  };
});

// Stub the relative-time hooks so rendering is deterministic (no Date, no interval timer).
vi.mock("../../hooks", () => ({
  useNowTick: () => 0,
  useRelativeTime: () => () => "just now",
}));

import {
  ConversationList,
  type AgentOption,
  type ConversationRow,
} from "@/components/agent-presence/chat/conversation-list";

const AGENTS: AgentOption[] = [{ agentUuid: "agent-1", agentName: "Admin Claude" }];

function makeRow(uuid: string, title: string): ConversationRow {
  return {
    session: {
      uuid,
      agentUuid: "agent-1",
      sessionId: uuid,
      directIdeaUuid: null,
      originConnectionUuid: "conn-1",
      status: "active",
      title,
      lastTurnAt: "2026-08-10T00:00:00.000Z",
      originOnline: true,
      firstInstruction: title,
      ideaTitle: null,
    },
    title,
    ideaAnchored: false,
    status: null,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof ConversationList>> = {}) {
  return render(
    <ConversationList
      agents={AGENTS}
      selectedAgentUuid="agent-1"
      onSelectAgent={() => {}}
      rows={[]}
      selectedSessionUuid={null}
      onSelectSession={() => {}}
      onNewConversation={() => {}}
      visibleCount={12}
      onLoadMore={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("ConversationList body state", () => {
  it("loading=true → renders skeleton rows, NOT the empty state", () => {
    renderList({ loading: true, rows: [] });
    // Skeleton container present.
    expect(screen.getByTestId("conversation-list-skeleton")).toBeTruthy();
    // Empty-state copy absent.
    expect(screen.queryByText("No conversations for this agent")).toBeNull();
    // The list chrome (New conversation button) stays visible during loading.
    expect(screen.getByText("New conversation")).toBeTruthy();
  });

  it("loading=false + empty rows → renders the empty state, no skeleton", () => {
    renderList({ loading: false, rows: [] });
    expect(screen.getByText("No conversations for this agent")).toBeTruthy();
    expect(screen.queryByTestId("conversation-list-skeleton")).toBeNull();
  });

  it("defaults to non-loading when the prop is omitted (empty state)", () => {
    renderList({ rows: [] });
    expect(screen.getByText("No conversations for this agent")).toBeTruthy();
    expect(screen.queryByTestId("conversation-list-skeleton")).toBeNull();
  });

  it("loading=false + rows → renders the rows, no skeleton and no empty state", () => {
    renderList({
      loading: false,
      rows: [makeRow("s-1", "First conversation"), makeRow("s-2", "Second conversation")],
    });
    expect(screen.getByText("First conversation")).toBeTruthy();
    expect(screen.getByText("Second conversation")).toBeTruthy();
    expect(screen.queryByTestId("conversation-list-skeleton")).toBeNull();
    expect(screen.queryByText("No conversations for this agent")).toBeNull();
  });

  it("loading=true takes priority even when rows exist (mid-refresh with stale data is not our path, but the guard holds)", () => {
    renderList({ loading: true, rows: [makeRow("s-1", "Stale row")] });
    expect(screen.getByTestId("conversation-list-skeleton")).toBeTruthy();
    expect(screen.queryByText("Stale row")).toBeNull();
  });
});
