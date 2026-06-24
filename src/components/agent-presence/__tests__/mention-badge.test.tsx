// @vitest-environment jsdom
//
// MentionBadge — the interactive agent-mention badge (子2). These tests pin the
// behaviors the acceptance criteria call out:
//   - the badge renders the agent name + an online dot (StatusDot),
//   - clicking opens a portaled Popover with the minimal identity (name + status),
//   - a PINNED mention's popover shows cwd + host (formatted), a NON-PINNED one
//     omits them,
//   - the owner/online gating MATRIX for "Open conversation":
//       owner + online   → shown
//       owner + offline   → hidden
//       non-owner + online → hidden
//   - activating "Open conversation" calls `openChatForAgent(agentUuid, pin?)`
//     with the pinned `(host, cwd)` for a pinned mention and `undefined` for a
//     non-pinned one.
//
// Presence + auth are injected by mocking `useAgentPresence` (which both the badge
// AND its internal `useMentionLiveness` read) and `useAuth`. next-intl resolves
// real en.json strings (a missing key surfaces as its dotted path and fails the
// assertion), matching the sibling agent-presence component tests.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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

// Inject presence (connections + the openChatForAgent spy). The badge reads
// `openChatForAgent` directly and `connections` transitively via
// `useMentionLiveness`, so one mock covers both.
const mockOpenChatForAgent = vi.fn();
let mockConnections: ConnectionView[] = [];
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresence: () => ({
    connections: mockConnections,
    openChatForAgent: mockOpenChatForAgent,
  }),
}));

// Inject the current user for the owner gate.
let mockUserUuid: string | null = null;
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: mockUserUuid ? { uuid: mockUserUuid } : null }),
}));

import type { ConnectionView } from "@/components/agent-presence/types";
import { MentionBadge } from "@/components/agent-presence/mention-badge";
import type { ParsedMentionRef } from "@/components/mention-renderer";

const OWNER = "owner-user-uuid";
const OTHER = "other-user-uuid";
const AGENT = "agent-uuid-1";

function makeConnection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    uuid: "conn-1",
    agentUuid: AGENT,
    agentName: "Builder Bot",
    ownerUuid: OWNER,
    clientType: "claude_code",
    clientVersion: "1.0.0",
    host: "prod-host",
    cwd: "/home/u/dev/chorus",
    startedAt: "2026-06-18T09:00:00.000Z",
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-06-18T09:00:00.000Z",
    lastSeenAt: "2026-06-18T09:30:00.000Z",
    disconnectedAt: null,
    ...over,
  };
}

const pinnedRef: ParsedMentionRef = {
  type: "agent",
  uuid: AGENT,
  displayName: "Builder Bot",
  pinnedHost: "prod-host",
  pinnedCwd: "/home/u/dev/chorus",
};

const nonPinnedRef: ParsedMentionRef = {
  type: "agent",
  uuid: AGENT,
  displayName: "Builder Bot",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConnections = [];
  mockUserUuid = null;
});
afterEach(() => cleanup());

// Open the badge's popover by clicking its trigger (the badge).
function openPopover() {
  // The trigger is the badge — find it by its accessible label / name text.
  const trigger = screen.getByText("@Builder Bot");
  fireEvent.click(trigger);
}

describe("MentionBadge — badge + popover identity", () => {
  it("renders the agent name on a clickable badge", () => {
    mockConnections = [makeConnection()];
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    expect(screen.getByText("@Builder Bot")).toBeTruthy();
  });

  it("pinned mention popover shows name + status + cwd + host", () => {
    mockConnections = [makeConnection()]; // online pinned instance exists
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    // Identity
    expect(screen.getAllByText("Builder Bot").length).toBeGreaterThan(0);
    // Online status label (mention.online = "Online")
    expect(screen.getByText("Online")).toBeTruthy();
    // Pinned fields: working-directory + host labels are present
    expect(screen.getByText("Working directory")).toBeTruthy();
    expect(screen.getByText("Host")).toBeTruthy();
    // The host value renders (formatHost keeps a short host whole)
    expect(screen.getByText("prod-host")).toBeTruthy();
    // The cwd tail renders (formatCwd keeps the final segment)
    expect(screen.getByText((txt) => txt.includes("chorus"))).toBeTruthy();
  });

  it("non-pinned mention popover omits cwd + host", () => {
    mockConnections = [makeConnection()];
    render(<MentionBadge mention={nonPinnedRef} displayName="Builder Bot" />);
    openPopover();
    expect(screen.getByText("Online")).toBeTruthy();
    // No pinned-instance fields for a non-pinned mention (q9).
    expect(screen.queryByText("Working directory")).toBeNull();
    expect(screen.queryByText("Host")).toBeNull();
  });

  it("offline pinned instance shows the offline status", () => {
    // A connection exists for the agent but NOT for this pinned place → offline.
    mockConnections = [
      makeConnection({ host: "other-host", cwd: "/elsewhere" }),
    ];
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    expect(screen.getByText("Offline")).toBeTruthy();
  });
});

describe("MentionBadge — owner/online gating matrix for Open conversation", () => {
  it("owner + online → button SHOWN", () => {
    mockConnections = [makeConnection()]; // online, ownerUuid = OWNER
    mockUserUuid = OWNER;
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    expect(screen.getByText("Open conversation")).toBeTruthy();
  });

  it("owner + offline → button HIDDEN (not disabled)", () => {
    // No connection for the pinned place → offline; owner borrowed from agent conn.
    mockConnections = [
      makeConnection({ host: "other-host", cwd: "/elsewhere" }),
    ];
    mockUserUuid = OWNER;
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    expect(screen.queryByText("Open conversation")).toBeNull();
  });

  it("non-owner + online → button HIDDEN", () => {
    mockConnections = [makeConnection()]; // online, ownerUuid = OWNER
    mockUserUuid = OTHER; // not the owner
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    expect(screen.queryByText("Open conversation")).toBeNull();
  });

  it("non-owner still sees the badge + popover identity (q5)", () => {
    mockConnections = [makeConnection()];
    mockUserUuid = OTHER;
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    // Identity is visible to everyone.
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Working directory")).toBeTruthy();
  });
});

describe("MentionBadge — Open conversation action payload", () => {
  it("pinned: calls openChatForAgent with the pinned (host, cwd)", () => {
    mockConnections = [makeConnection()];
    mockUserUuid = OWNER;
    render(<MentionBadge mention={pinnedRef} displayName="Builder Bot" />);
    openPopover();
    fireEvent.click(screen.getByText("Open conversation"));
    expect(mockOpenChatForAgent).toHaveBeenCalledWith(AGENT, {
      host: "prod-host",
      cwd: "/home/u/dev/chorus",
    });
  });

  it("non-pinned: calls openChatForAgent with no pin (undefined)", () => {
    mockConnections = [makeConnection()];
    mockUserUuid = OWNER;
    render(<MentionBadge mention={nonPinnedRef} displayName="Builder Bot" />);
    openPopover();
    fireEvent.click(screen.getByText("Open conversation"));
    expect(mockOpenChatForAgent).toHaveBeenCalledWith(AGENT, undefined);
  });
});
