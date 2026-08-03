// Unit tests for the pure mention-liveness matching rule
// (src/lib/mention-liveness.ts). React-free — exercises the rule with plain
// ConnectionView fixtures, exactly as the Tech Design's "Liveness resolution"
// section specifies.

import { describe, it, expect } from "vitest";
import {
  resolveMentionLiveness,
  isPinnedRef,
  type MentionLivenessRef,
} from "@/lib/mention-liveness";
import type { ConnectionView } from "@/components/agent-presence/types";

const AGENT = "abcdef12-3456-7890-abcd-ef1234567890";
const OTHER_AGENT = "99999999-8888-7777-6666-555555555555";
const OWNER = "11111111-1111-1111-1111-111111111111";

// Build a ConnectionView fixture; only the fields the rule reads matter, the rest
// carry plausible defaults.
function conn(overrides: Partial<ConnectionView>): ConnectionView {
  return {
    uuid: "conn-" + Math.random().toString(36).slice(2),
    agentUuid: AGENT,
    agentName: "DevBot",
    ownerUuid: OWNER,
    clientType: "claude_code",
    clientVersion: null,
    host: "prod",
    cwd: "/work",
    startedAt: null,
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-06-24T00:00:00.000Z",
    lastSeenAt: "2026-06-24T00:00:00.000Z",
    disconnectedAt: null,
    ...overrides,
  };
}

describe("isPinnedRef", () => {
  it("is pinned when either pin key is present (even null-valued)", () => {
    expect(isPinnedRef({ uuid: AGENT, pinnedHost: "h", pinnedCwd: "/c" })).toBe(true);
    expect(isPinnedRef({ uuid: AGENT, pinnedHost: "", pinnedCwd: "/c" })).toBe(true);
    expect(isPinnedRef({ uuid: AGENT, pinnedCwd: null })).toBe(true);
    expect(isPinnedRef({ uuid: AGENT, pinnedHost: null })).toBe(true);
  });

  it("is NOT pinned when both pin keys are absent", () => {
    expect(isPinnedRef({ uuid: AGENT })).toBe(false);
  });
});

describe("resolveMentionLiveness — pinned mention (instance-precise)", () => {
  const ref: MentionLivenessRef = {
    uuid: AGENT,
    pinnedHost: "prod",
    pinnedCwd: "/work",
  };

  it("pinned-online: the exact (agentUuid, host, cwd) instance is online", () => {
    const connections = [
      conn({ host: "prod", cwd: "/work", effectiveStatus: "online" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r).toEqual({
      pinned: true,
      online: true,
      ownerUuid: OWNER,
      host: "prod",
      cwd: "/work",
    });
  });

  it("pinned-offline-while-agent-online-elsewhere = offline (different cwd does NOT count)", () => {
    const connections = [
      // Same agent, online, but a DIFFERENT instance (cwd /elsewhere).
      conn({ host: "prod", cwd: "/elsewhere", effectiveStatus: "online" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r.online).toBe(false);
    expect(r.pinned).toBe(true);
    // The pinned place is echoed for display; owner borrowed from the known agent conn.
    expect(r.host).toBe("prod");
    expect(r.cwd).toBe("/work");
    expect(r.ownerUuid).toBe(OWNER);
  });

  it("runtime cwd is online through any online connection on the fixed host", () => {
    const runtimeRef: MentionLivenessRef = {
      uuid: AGENT,
      pinnedHost: "prod",
      pinnedCwd: "/work/dynamic",
      runtimeCwd: true,
    };
    const result = resolveMentionLiveness(runtimeRef, [
      conn({ host: "prod", cwd: "/daemon/startup", effectiveStatus: "online" }),
    ]);
    expect(result).toMatchObject({
      pinned: true,
      online: true,
      ownerUuid: OWNER,
      host: "prod",
      cwd: "/work/dynamic",
    });
  });

  it("runtime cwd stays offline when only another host is online", () => {
    const runtimeRef: MentionLivenessRef = {
      uuid: AGENT,
      pinnedHost: "fixed-host",
      pinnedCwd: "/work/dynamic",
      runtimeCwd: true,
    };
    expect(resolveMentionLiveness(runtimeRef, [
      conn({ host: "other-host", cwd: "/daemon/startup", effectiveStatus: "online" }),
    ]).online).toBe(false);
  });

  it("pinned place exists but its connection is offline → offline, instance identity surfaced", () => {
    const connections = [
      conn({ host: "prod", cwd: "/work", effectiveStatus: "offline" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r.online).toBe(false);
    expect(r.host).toBe("prod");
    expect(r.cwd).toBe("/work");
    expect(r.ownerUuid).toBe(OWNER);
  });

  it("a different agent's matching place does NOT satisfy the pin", () => {
    const connections = [
      conn({ agentUuid: OTHER_AGENT, host: "prod", cwd: "/work", effectiveStatus: "online" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r.online).toBe(false);
    expect(r.ownerUuid).toBeNull(); // no connection known for THIS agent
  });

  it("matches an unknown-host pin (pinnedHost '') against a host-less connection", () => {
    const unknownHostRef: MentionLivenessRef = {
      uuid: AGENT,
      pinnedHost: "",
      pinnedCwd: "/srv",
    };
    const connections = [
      conn({ host: "", cwd: "/srv", effectiveStatus: "online" }),
    ];
    expect(resolveMentionLiveness(unknownHostRef, connections).online).toBe(true);
  });

  it("matches an unknown-path pin (pinnedCwd null) against a null-cwd connection", () => {
    const unknownPathRef: MentionLivenessRef = {
      uuid: AGENT,
      pinnedHost: "prod",
      pinnedCwd: null,
    };
    const connections = [
      conn({ host: "prod", cwd: null, effectiveStatus: "online" }),
    ];
    const r = resolveMentionLiveness(unknownPathRef, connections);
    expect(r.online).toBe(true);
    expect(r.cwd).toBeNull();
  });
});

describe("resolveMentionLiveness — non-pinned mention (agent-overall)", () => {
  const ref: MentionLivenessRef = { uuid: AGENT };

  it("non-pinned-online: ANY connection for the agent is online", () => {
    const connections = [
      conn({ host: "h1", cwd: "/a", effectiveStatus: "offline" }),
      conn({ host: "h2", cwd: "/b", effectiveStatus: "online" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r).toEqual({
      pinned: false,
      online: true,
      ownerUuid: OWNER,
      host: null, // non-pinned has no single instance
      cwd: null,
    });
  });

  it("non-pinned-offline: no connection for the agent is online", () => {
    const connections = [
      conn({ host: "h1", cwd: "/a", effectiveStatus: "offline" }),
    ];
    const r = resolveMentionLiveness(ref, connections);
    expect(r.online).toBe(false);
    expect(r.ownerUuid).toBe(OWNER); // borrowed from the offline connection
    expect(r.host).toBeNull();
    expect(r.cwd).toBeNull();
  });

  it("no connections at all for the agent → offline, ownerUuid null", () => {
    const connections = [conn({ agentUuid: OTHER_AGENT, effectiveStatus: "online" })];
    const r = resolveMentionLiveness(ref, connections);
    expect(r.online).toBe(false);
    expect(r.ownerUuid).toBeNull();
  });

  it("ignores other agents' online connections", () => {
    const connections = [
      conn({ agentUuid: OTHER_AGENT, effectiveStatus: "online" }),
    ];
    expect(resolveMentionLiveness(ref, connections).online).toBe(false);
  });
});
