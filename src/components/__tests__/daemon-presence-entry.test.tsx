// @vitest-environment jsdom
//
// Component tests for the bottom-right DaemonPresenceEntry (the single floating
// affordance that replaced the sidebar presence pill + the pixel-canvas button).
//
// Focus: the three non-silent presence states the AC calls out, rendered on the
// floating trigger button:
//   - idle (0 online)  → visible, shows the localized "0 online", static dot,
//   - loading          → muted placeholder, NO count flash (no number shown),
//   - error            → distinguished "Agents unavailable", NEVER "0 online".
// Plus: online (count > 0) emphasizes the count and uses the pulsing-green dot
// (halo gated behind motion-safe so reduced-motion degrades to a static dot),
// the popover lists online connections' running/queued executions (dropping
// interrupted rows), and a PROMINENT "Open chat" action opens the chat modal
// directly via setModalOpen(true) (no "View all" intermediate step).
//
// Test seam: useAgentPresence is mocked per-test to feed each state; next-intl
// resolves the real en strings so a missing/renamed key surfaces as its dotted
// path and fails the assertion. Plain DOM assertions only.

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
// Real en strings for asserting CTA prose by value (kept in sync with the
// next-intl mock below, which resolves from the same file).
import enMessages from "../../../messages/en.json";

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

// usePixelActivityOptional is the shell↔project bridge for the "View activity"
// affordance; mock it per-test. Default: null (no project context) — the entry
// then omits the affordance. Tests that assert its presence set a value.
const mockPixelActivity = vi.fn(() => null as unknown);
vi.mock("@/contexts/pixel-activity-context", () => ({
  usePixelActivityOptional: () => mockPixelActivity(),
}));

import { DaemonPresenceEntry } from "../daemon-presence-entry";
import { ExecutionRow } from "@/components/agent-presence";

const TRIGGER_LABEL = "Online agents — open details";

// The agent group is COLLAPSED by default in the popover, so its per-cwd
// instance rows (and their executions / idle line / Interrupt control) only
// render after the agent header toggle is clicked. Expand every agent so the
// nested rows under test become visible.
async function expandAgents(user: ReturnType<typeof userEvent.setup>) {
  const toggles = await screen.findAllByRole("button", {
    name: /Show .*working directories/,
  });
  for (const toggle of toggles) await user.click(toggle);
}

function makeConnection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    uuid: "conn-1",
    agentUuid: "agent-1",
    agentName: "Builder Bot",
    ownerUuid: null,
    clientType: "claude_code",
    clientVersion: "1.2.3",
    host: "macbook",
    cwd: "/Users/me/projects/alpha",
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
    openSession: null,
    setOpenSession: vi.fn(),
    subscribeTranscript: vi.fn(() => () => {}),
    focusTarget: null,
    openChatForAgent: vi.fn(),
    openChatForSession: vi.fn(),
    clearChatFocusTarget: vi.fn(),
    refreshConnections: vi.fn(),
    ...over,
  };
  mockPresence.mockReturnValue(value);
  return value;
}

describe("DaemonPresenceEntry — three presence states", () => {
  beforeEach(() => {
    mockPresence.mockReset();
    mockPixelActivity.mockReset();
    mockPixelActivity.mockReturnValue(null);
  });

  it("idle (0 online): visible, shows the full '0 agents online' unit, no error text", () => {
    setPresence({ status: "ok", onlineCount: 0, connections: [] });
    render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("0");
    expect(text).toContain("agents online");
    expect(text).not.toContain("Agents unavailable");
    expect(trigger).toBeTruthy();
  });

  it("loading: muted placeholder, NO count flash (no digit shown)", () => {
    setPresence({ status: "loading", onlineCount: 0, connections: [] });
    render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("Checking agents");
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain("online");
    expect(text).not.toContain("Agents unavailable");
  });

  it("error: distinguished 'Agents unavailable', never shown as 0 online", () => {
    setPresence({ status: "error", onlineCount: 0, connections: [] });
    render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("Agents unavailable");
    expect(text).not.toContain("online");
    expect(text).not.toMatch(/\d/);
  });

  it("online (multiple distinct agents): shows the DISTINCT-AGENT count (not per-connection), plural unit, pulsing dot", () => {
    // Three distinct agents online. The provider's connection-based onlineCount is set to a
    // DIFFERENT (bogus) value to prove the pill uses the distinct-agent count
    // (onlineAgentGroups.length), never the per-connection onlineCount.
    setPresence({
      status: "ok",
      onlineCount: 7,
      connections: [
        makeConnection({ uuid: "c1", agentUuid: "agent-1", host: "h1", cwd: "/a" }),
        makeConnection({ uuid: "c2", agentUuid: "agent-2", host: "h2", cwd: "/b" }),
        makeConnection({ uuid: "c3", agentUuid: "agent-3", host: "h3", cwd: "/c" }),
      ],
    });
    const { container } = render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("3");
    expect(text).toContain("agents online");
    // Must NOT reflect the per-connection count from the provider.
    expect(text).not.toContain("7");
    // The pulsing-green dot reuses motion-safe:animate-ping (static under
    // reduced motion). The error/idle dots never carry it.
    expect(container.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
  });

  it("one agent online across multiple cwds counts ONCE (distinct-agent, not per-connection)", () => {
    // Same agentUuid on three (host, cwd) connections → the provider counts 3 connections,
    // but the pill must show a single distinct agent (the headline of idea 5b8ee573 point 4).
    setPresence({
      status: "ok",
      onlineCount: 3,
      connections: [
        makeConnection({ uuid: "c1", agentUuid: "agent-1", host: "h", cwd: "/one" }),
        makeConnection({ uuid: "c2", agentUuid: "agent-1", host: "h", cwd: "/two" }),
        makeConnection({ uuid: "c3", agentUuid: "agent-1", host: "h", cwd: "/three" }),
      ],
    });
    render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("agent online");
    expect(text).not.toContain("agents online"); // singular, not plural
    expect(text).not.toContain("3"); // NOT the per-connection count
  });

  it("online (count === 1): uses the SINGULAR unit 'agent online'", () => {
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
    });
    render(<DaemonPresenceEntry />);

    const trigger = screen.getByRole("button", { name: TRIGGER_LABEL });
    const text = trigger.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("agent online");
    expect(text).not.toContain("agents online");
  });

  it("idle / error dots do NOT animate (no motion-safe:animate-ping)", () => {
    setPresence({ status: "error", onlineCount: 0, connections: [] });
    const { container } = render(<DaemonPresenceEntry />);
    expect(container.querySelector(".motion-safe\\:animate-ping")).toBeNull();
  });
});

describe("DaemonPresenceEntry — popover content", () => {
  beforeEach(() => {
    mockPresence.mockReset();
    mockPixelActivity.mockReset();
    mockPixelActivity.mockReturnValue(null);
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
    render(<DaemonPresenceEntry />);

    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    await screen.findByText("Builder Bot");
    await expandAgents(user);
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
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));
    await expandAgents(user);

    expect(
      await screen.findByText("Idle — no running or queued work."),
    ).toBeTruthy();
  });

  it("default COLLAPSED: agent header shows name + count but hides instance rows until expanded", async () => {
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection({ agentName: "Builder Bot" })],
      executionsByConnection: {},
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    const toggle = await screen.findByRole("button", {
      name: /Show .*working directories/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await screen.findByText("Builder Bot")).toBeTruthy();
    expect(
      screen.queryByText("Idle — no running or queued work."),
    ).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      await screen.findByText("Idle — no running or queued work."),
    ).toBeTruthy();
  });

  it("'Open chat' action calls setModalOpen(true) and does not navigate", async () => {
    const setModalOpen = vi.fn();
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
      executionsByConnection: {},
      setModalOpen,
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    // The prominent open-chat action opens the daemon chat modal directly —
    // no intermediate "View all" step.
    const openChat = await screen.findByRole("button", { name: "Open chat" });
    await user.click(openChat);
    expect(setModalOpen).toHaveBeenCalledWith(true);
  });

  it("popover 0-online empty state shows the daemon-connect CTA (command + copy), not a dead-end sentence", async () => {
    setPresence({
      status: "ok",
      onlineCount: 0,
      connections: [],
      executionsByConnection: {},
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    expect(
      await screen.findByText("npx @chorus-aidlc/chorus daemon"),
    ).toBeTruthy();
    expect(screen.getByText(enMessages.daemonConnectCta.body)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: enMessages.daemonConnectCta.copy }),
    ).toBeTruthy();
  });
});

describe("DaemonPresenceEntry — widened popover + stacked task rows", () => {
  beforeEach(() => {
    mockPresence.mockReset();
    mockPixelActivity.mockReset();
    mockPixelActivity.mockReturnValue(null);
  });

  // The popover is a viewport-clamped ~400px so titles get room and it never
  // overflows a phone.
  it("popover content is viewport-clamped ~400px (not the old 300px)", async () => {
    setPresence({
      status: "ok",
      onlineCount: 1,
      connections: [makeConnection()],
      executionsByConnection: {},
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));
    await expandAgents(user);
    await screen.findByText("Idle — no running or queued work.");

    const content = document.querySelector('[class*="min(92vw,400px)"]');
    expect(content).not.toBeNull();
    expect(document.querySelector('[class*="w-[300px]"]')).toBeNull();
  });

  // A running row in the popover keeps the elapsed timer + Interrupt control but
  // stacks them on a second line (flex-col <li>) so the title isn't crowded; the
  // title relaxes from a hard truncate to a two-line clamp.
  it("running row in the popover stacks controls on a second line and keeps Interrupt + elapsed", async () => {
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
            entityTitle: "A very long running task title that used to truncate",
          }),
        ],
      },
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));
    await expandAgents(user);

    const interruptBtn = await screen.findByRole("button", {
      name: "Interrupt this running execution",
    });
    expect(interruptBtn).toBeTruthy();

    const row = interruptBtn.closest("li");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("flex-col");

    const titleEl = screen.getByText(
      "A very long running task title that used to truncate",
    );
    expect(titleEl.className).toContain("line-clamp-2");
    expect(titleEl.className).not.toContain("truncate");
  });

  // The modal/connection-view keep the default inline single-line layout —
  // ExecutionRow's default must be inline.
  it("ExecutionRow defaults to the inline single-line layout (modal unchanged)", () => {
    const exec = makeExecution({
      uuid: "run-2",
      status: "running",
      entityTitle: "Inline task",
    });
    const { container } = render(
      <ul>
        <ExecutionRow exec={exec} nowMs={Date.parse(exec.startedAt as string) + 5000} />
      </ul>,
    );
    const row = container.querySelector("li");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("items-center");
    expect(row?.className).not.toContain("flex-col");
  });
});

describe("DaemonPresenceEntry — pixel 'Open pixel workspace' affordance", () => {
  beforeEach(() => {
    mockPresence.mockReset();
    mockPixelActivity.mockReset();
  });

  it("shows 'Open pixel workspace' and opens the pixel view when a project context is available", async () => {
    setPresence({ status: "ok", onlineCount: 0, connections: [] });
    const setOpen = vi.fn();
    // Inside a project context: the bridge exists and reports available.
    mockPixelActivity.mockReturnValue({
      open: false,
      setOpen,
      available: true,
      setAvailable: vi.fn(),
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    const openPixel = await screen.findByRole("button", {
      name: "Open pixel workspace",
    });
    await user.click(openPixel);
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("omits 'Open pixel workspace' on a global page (bridge absent → null)", async () => {
    setPresence({ status: "ok", onlineCount: 0, connections: [] });
    mockPixelActivity.mockReturnValue(null);

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    // The roster/CTA renders (portal mounted) but no "Open pixel workspace" action.
    await screen.findByText("npx @chorus-aidlc/chorus daemon");
    expect(
      screen.queryByRole("button", { name: "Open pixel workspace" }),
    ).toBeNull();
  });

  it("omits 'Open pixel workspace' when the bridge exists but reports NOT available (project unmounted)", async () => {
    setPresence({ status: "ok", onlineCount: 0, connections: [] });
    mockPixelActivity.mockReturnValue({
      open: false,
      setOpen: vi.fn(),
      available: false,
      setAvailable: vi.fn(),
    });

    const user = userEvent.setup();
    render(<DaemonPresenceEntry />);
    await user.click(screen.getByRole("button", { name: TRIGGER_LABEL }));

    await screen.findByText("npx @chorus-aidlc/chorus daemon");
    expect(
      screen.queryByRole("button", { name: "Open pixel workspace" }),
    ).toBeNull();
  });
});
