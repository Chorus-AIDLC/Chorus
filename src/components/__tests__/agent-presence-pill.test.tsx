// @vitest-environment jsdom
//
// Component tests for the sidebar AgentPresencePill (T4 — pill + popover).
//
// Focus: the three non-silent presence states the AC calls out, rendered on the
// resident trigger pill:
//   - idle (0 online)  → visible, shows the localized "0 online", static dot,
//   - loading          → muted placeholder, NO count flash (no number shown),
//   - error            → distinguished "Agents unavailable", NEVER "0 online".
// Plus: online (count > 0) emphasizes the count and uses the pulsing-green dot
// (halo gated behind motion-safe so reduced-motion degrades to a static dot),
// and the popover lists online connections' running/queued executions (dropping
// interrupted rows) with a "View all" footer that calls setModalOpen(true).
//
// Test seam: useAgentPresence is mocked per-test to feed each state; next-intl
// resolves the real en strings so a missing/renamed key surfaces as its dotted
// path and fails the assertion (mirrors the agent-connections page tests). Plain
// DOM assertions only (the repo does not load @testing-library/jest-dom).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentPresenceValue,
  AgentPresenceStatus,
} from "@/contexts/agent-presence-context";
import type {
  ConnectionView,
  ExecutionView,
} from "@/components/agent-presence";

// next-intl: resolve real en strings (mirrors the sibling agent-connections tests).
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let node: unknown = en;
    for (const p of fullKey.split(".")) {
      if (
        node &&
        typeof node === "object" &&
        p in (node as Record<string, unknown>)
      ) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  // Minimal ICU `plural` evaluation so the mock matches real next-intl behavior
  // for the pluralized unit string (en `one`/`other`). Handles the single-arg
  // form `{name, plural, one {…} other {…}}` with `#` → value substitution.
  function evalPlural(s: string, params: Record<string, string | number>): string {
    // Greedy `(.+)` + single trailing `\}` so the last branch keeps its own
    // closing brace (a lazy `.+?\}\}` would eat it and break the `other` match).
    return s.replace(
      /\{(\w+),\s*plural,\s*(.+)\}/g,
      (_full, argName: string, branches: string) => {
        const value = Number(params[argName]);
        const cat = value === 1 ? "one" : "other";
        const re = new RegExp(`${cat}\\s*\\{([^}]*)\\}`);
        const other = /other\s*\{([^}]*)\}/.exec(branches);
        const chosen = re.exec(branches) ?? other;
        return (chosen ? chosen[1] : "").replace(/#/g, String(value));
      },
    );
  }
  return {
    useTranslations:
      (namespace = "") =>
      (key: string, params?: Record<string, string | number>) => {
        let s = resolve(namespace, key);
        if (params) {
          if (s.includes(", plural,")) s = evalPlural(s, params);
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// useAgentPresence is the single data spine; mock it per-test.
const mockPresence = vi.fn();
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresence: () => mockPresence(),
}));

import { AgentPresencePill } from "../agent-presence-pill";

const TRIGGER_LABEL = "Online agents — open details";

function makeConnection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    uuid: "conn-1",
    agentUuid: "agent-1",
    agentName: "Builder Bot",
    clientType: "claude_code",
    clientVersion: "1.2.3",
    host: "macbook",
    startedAt: "2026-06-18T09:00:00.000Z",
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-06-18T09:00:00.000Z",
    lastSeenAt: "2026-06-18T09:30:00.000Z",
    disconnectedAt: null,
    ...over,
  };
}

function makeExecution(over: Partial<ExecutionView> = {}): ExecutionView {
  return {
    uuid: "exec-1",
    connectionUuid: "conn-1",
    entityType: "task",
    entityUuid: "task-1",
    status: "running",
    interruptedReason: null,
    startedAt: "2026-06-18T09:25:00.000Z",
    entityTitle: "Implement the thing",
    projectUuid: "proj-1",
    rootIdeaTitle: null,
    ...over,
  } as ExecutionView;
}

function setPresence(over: Partial<AgentPresenceValue>) {
  const value: AgentPresenceValue = {
    status: "ok" as AgentPresenceStatus,
    connections: [],
    onlineCount: 0,
    executionsByConnection: {},
    executionsLoaded: true,
    modalOpen: false,
    setModalOpen: vi.fn(),
    ...over,
  };
  mockPresence.mockReturnValue(value);
  return value;
}

describe("AgentPresencePill — three presence states", () => {
  beforeEach(() => {
    mockPresence.mockReset();
  });

  it("idle (0 online): visible, shows the full '0 agents online' unit, no error text", () => {
    setPresence({ status: "ok", onlineCount: 0, connections: [] });
    render(<AgentPresencePill />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    // The count glyph "0" + the spelled-out plural unit (not a bare "online").
    expect(text).toContain("0");
    expect(text).toContain("agents online");
    // It must NOT read as the error state.
    expect(text).not.toContain("Agents unavailable");
    // Pill stays mounted/visible regardless of count.
    expect(trigger).toBeTruthy();
  });

  it("loading: muted placeholder, NO count flash (no digit shown)", () => {
    setPresence({ status: "loading", onlineCount: 0, connections: [] });
    render(<AgentPresencePill />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("Checking agents");
    // No count flash: the loading state shows no numeric count and no "online" word.
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain("online");
    expect(text).not.toContain("Agents unavailable");
  });

  it("error: distinguished 'Agents unavailable', never shown as 0 online", () => {
    // A failed poll flips status to error; even so the pill must NOT render a
    // count — it shows the distinguished unavailable label.
    setPresence({ status: "error", onlineCount: 0, connections: [] });
    render(<AgentPresencePill />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("Agents unavailable");
    // Never masquerade as "0 online".
    expect(text).not.toContain("online");
    expect(text).not.toMatch(/\d/);
  });

  it("online (count > 0): emphasizes the count, shows the plural unit, and renders the pulsing-green dot", () => {
    setPresence({
      status: "ok",
      onlineCount: 3,
      connections: [makeConnection()],
    });
    const { container } = render(<AgentPresencePill />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    // Count glyph + the plural unit "agents online" (3 → plural form).
    expect(text).toContain("3");
    expect(text).toContain("agents online");
    // The pulsing-green dot reuses motion-safe:animate-ping (static under
    // reduced motion). The error/idle dots never carry it.
    expect(container.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
  });

  it("online (count === 1): uses the SINGULAR unit 'agent online'", () => {
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
    });
    render(<AgentPresencePill />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("1");
    // Singular unit — not "agents online".
    expect(text).toContain("agent online");
    expect(text).not.toContain("agents online");
  });

  it("idle / error dots do NOT animate (no motion-safe:animate-ping)", () => {
    setPresence({ status: "error", onlineCount: 0, connections: [] });
    const { container } = render(<AgentPresencePill />);
    expect(container.querySelector(".motion-safe\\:animate-ping")).toBeNull();
  });
});

describe("AgentPresencePill — popover content", () => {
  beforeEach(() => {
    mockPresence.mockReset();
  });

  it("lists online connections with running/queued executions and drops interrupted rows", async () => {
    const conn = makeConnection({ uuid: "conn-1", agentName: "Builder Bot" });
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [conn],
      executionsByConnection: {
        "conn-1": [
          makeExecution({
            uuid: "run-1",
            status: "running",
            entityTitle: "Running task A",
          }),
          makeExecution({
            uuid: "queue-1",
            status: "queued",
            startedAt: null,
            entityTitle: "Queued task B",
          }),
          makeExecution({
            uuid: "int-1",
            status: "interrupted",
            interruptedReason: "user",
            entityTitle: "Interrupted task C",
          }),
        ],
      },
    });

    const user = userEvent.setup();
    render(<AgentPresencePill />);

    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    // PopoverContent renders in a portal — assert against the document text.
    await screen.findByText("Builder Bot");
    const popoverText = document.body.textContent ?? "";
    expect(popoverText).toContain("Running task A");
    expect(popoverText).toContain("Queued task B");
    // Interrupted row must NOT be rendered in the glanceable popover.
    expect(popoverText).not.toContain("Interrupted task C");
  });

  it("shows a quiet idle line for an online connection with no active work", async () => {
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
      executionsByConnection: {},
    });

    const user = userEvent.setup();
    render(<AgentPresencePill />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    expect(
      await screen.findByText("Idle — no running or queued work."),
    ).toBeTruthy();
  });

  it("'View all' footer calls setModalOpen(true) and does not navigate", async () => {
    const setModalOpen = vi.fn();
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
      executionsByConnection: {},
      setModalOpen,
    });

    const user = userEvent.setup();
    render(<AgentPresencePill />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    const viewAll = await screen.findByRole("button", { name: "View all" });
    await user.click(viewAll);
    expect(setModalOpen).toHaveBeenCalledWith(true);
  });

  it("popover renders empty-state when no connections are online", async () => {
    setPresence({
      status: "ok",
      onlineCount: 0,
      connections: [],
      executionsByConnection: {},
    });

    const user = userEvent.setup();
    render(<AgentPresencePill />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    expect(
      await screen.findByText("No agents are online right now."),
    ).toBeTruthy();
  });
});
