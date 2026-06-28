// Unit tests for the presence drill-down pure grouping + activity helpers
// (`groupConnectionsByAgent`, `deriveInstanceActivity`). These are framework-
// agnostic functions (no React, no i18n) so they are tested directly, mirroring
// the daemon-instance-format (T1) test style.

import { describe, it, expect } from "vitest";
import {
  groupConnectionsByAgent,
  onlineConnectionsOnly,
  sortConnectionsForPresence,
  deriveInstanceActivity,
} from "../instance-group";
import type { ConnectionView, ExecutionView } from "../types";

const NOW = "2026-06-23T12:00:00.000Z";

function conn(overrides: Partial<ConnectionView> & { uuid: string }): ConnectionView {
  return {
    agentUuid: "agent-1",
    agentName: "Alpha",
    ownerUuid: null,
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "host-1",
    cwd: "/home/u/dev/chorus",
    startedAt: NOW,
    status: "online",
    effectiveStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
    disconnectedAt: null,
    ...overrides,
  };
}

function exec(overrides: Partial<ExecutionView> & { uuid: string }): ExecutionView {
  return {
    agentUuid: "agent-1",
    connectionUuid: "conn-1",
    entityType: "task",
    entityUuid: "task-" + overrides.uuid,
    rootIdeaUuid: null,
    status: "running",
    interruptedReason: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    entityTitle: "Task",
    projectUuid: "proj-1",
    rootIdeaTitle: null,
    ...overrides,
  };
}

describe("groupConnectionsByAgent", () => {
  it("groups connections by agent in deterministic identity order", () => {
    const groups = groupConnectionsByAgent([
      conn({ uuid: "b1", agentUuid: "B", agentName: "Beta" }),
      conn({ uuid: "a2", agentUuid: "A", agentName: "Alpha", cwd: "/z" }),
      conn({ uuid: "a1", agentUuid: "A", agentName: "Alpha", cwd: "/a" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].agentUuid).toBe("A");
    expect(groups[0].connections.map((c) => c.uuid)).toEqual(["a1", "a2"]);
    expect(groups[1].agentUuid).toBe("B");
  });

  it("counts only effectively-online connections per agent", () => {
    const [group] = groupConnectionsByAgent([
      conn({ uuid: "a1", effectiveStatus: "online" }),
      conn({ uuid: "a2", effectiveStatus: "offline" }),
      conn({ uuid: "a3", effectiveStatus: "online" }),
    ]);
    expect(group.onlineCount).toBe(2);
    expect(group.connections).toHaveLength(3);
  });

  it("is single-host when all connections share one host", () => {
    const [group] = groupConnectionsByAgent([
      conn({ uuid: "a1", host: "Laptop-Q3" }),
      conn({ uuid: "a2", host: "Laptop-Q3", cwd: "/home/u/dev/other" }),
    ]);
    expect(group.multiHost).toBe(false);
    expect(group.singleHost).toBe("Laptop-Q3");
  });

  it("is multi-host when connections span 2+ distinct hosts", () => {
    const [group] = groupConnectionsByAgent([
      conn({ uuid: "a1", host: "Laptop-Q3" }),
      conn({ uuid: "a2", host: "ci-runner-02" }),
    ]);
    expect(group.multiHost).toBe(true);
    expect(group.singleHost).toBeUndefined();
  });

  it("treats a host-less connection as its own distinct host (disambiguates)", () => {
    // A host-less "" connection + a named one read as 2 hosts so the per-row
    // suffix appears to keep them distinct.
    const [group] = groupConnectionsByAgent([
      conn({ uuid: "a1", host: "" }),
      conn({ uuid: "a2", host: "Laptop-Q3" }),
    ]);
    expect(group.multiHost).toBe(true);
  });

  it("carries the single-host '' through as singleHost (caller localizes)", () => {
    const [group] = groupConnectionsByAgent([conn({ uuid: "a1", host: "" })]);
    expect(group.multiHost).toBe(false);
    expect(group.singleHost).toBe("");
  });
});

describe("onlineConnectionsOnly", () => {
  it("keeps only effectively-online connections (drops offline) and returns them sorted", () => {
    const result = onlineConnectionsOnly([
      conn({ uuid: "a1", effectiveStatus: "online", cwd: "/z" }),
      conn({ uuid: "a2", effectiveStatus: "offline" }),
      conn({ uuid: "a3", effectiveStatus: "online", cwd: "/a" }),
    ]);
    expect(result.map((c) => c.uuid)).toEqual(["a3", "a1"]);
  });

  it("drops a legacy null-cwd OFFLINE 'unknown path' connection from presence", () => {
    // The legacy null-cwd offline row must simply disappear from presence (T11).
    const result = onlineConnectionsOnly([
      conn({ uuid: "a1", cwd: null, effectiveStatus: "offline" }),
      conn({ uuid: "a2", cwd: "/home/u/dev/chorus", effectiveStatus: "online" }),
    ]);
    expect(result.map((c) => c.uuid)).toEqual(["a2"]);
  });

  it("removes an agent entirely when it has zero online connections (empty group source)", () => {
    // Grouping the online-only filter of an all-offline agent yields no group, so
    // the agent disappears from presence rather than lingering as an offline row.
    const offlineOnly = onlineConnectionsOnly([
      conn({ uuid: "b1", agentUuid: "B", effectiveStatus: "offline" }),
      conn({ uuid: "b2", agentUuid: "B", effectiveStatus: "offline" }),
    ]);
    expect(offlineOnly).toHaveLength(0);
    expect(groupConnectionsByAgent(offlineOnly)).toHaveLength(0);
  });

  it("sorts surviving online connections instead of preserving raw input order", () => {
    const result = onlineConnectionsOnly([
      conn({ uuid: "a1", effectiveStatus: "online", cwd: "/c" }),
      conn({ uuid: "a2", effectiveStatus: "offline" }),
      conn({ uuid: "a3", effectiveStatus: "online", cwd: "/a" }),
      conn({ uuid: "a4", effectiveStatus: "online", cwd: "/b" }),
    ]);
    expect(result.map((c) => c.uuid)).toEqual(["a3", "a4", "a1"]);
  });
});

describe("sortConnectionsForPresence", () => {
  it("sorts by effective status, agent name, agent uuid, cwd, host, client type, and uuid", () => {
    const input = [
      conn({
        uuid: "offline-alpha",
        agentUuid: "agent-a",
        agentName: "Alpha",
        effectiveStatus: "offline",
        cwd: "/a",
      }),
      conn({
        uuid: "online-beta",
        agentUuid: "agent-b",
        agentName: "Beta",
        cwd: "/a",
      }),
      conn({
        uuid: "online-alpha-null",
        agentUuid: "agent-a",
        agentName: "alpha",
        cwd: null,
      }),
      conn({
        uuid: "online-alpha-a",
        agentUuid: "agent-a",
        agentName: "  ALPHA ",
        cwd: "/a",
      }),
      conn({
        uuid: "online-missing",
        agentUuid: "agent-0",
        agentName: null,
        cwd: "/a",
      }),
    ];

    expect(sortConnectionsForPresence(input).map((c) => c.uuid)).toEqual([
      "online-alpha-a",
      "online-alpha-null",
      "online-beta",
      "online-missing",
      "offline-alpha",
    ]);
    // Pure helper: original array was not mutated.
    expect(input.map((c) => c.uuid)).toEqual([
      "offline-alpha",
      "online-beta",
      "online-alpha-null",
      "online-alpha-a",
      "online-missing",
    ]);
  });

  it("tie-breaks agents with duplicate display names by agent uuid", () => {
    const result = sortConnectionsForPresence([
      conn({
        uuid: "same-name-b",
        agentUuid: "agent-b",
        agentName: "Same Name",
      }),
      conn({
        uuid: "same-name-a",
        agentUuid: "agent-a",
        agentName: "same name",
      }),
    ]);

    expect(result.map((c) => c.uuid)).toEqual(["same-name-a", "same-name-b"]);
  });

  it("ranks running before queued before online idle before offline, then stable identity", () => {
    const running = conn({
      uuid: "running-z",
      agentUuid: "agent-z",
      agentName: "Zeta",
    });
    const queued = conn({
      uuid: "queued-a",
      agentUuid: "agent-a",
      agentName: "Alpha",
    });
    const idle = conn({
      uuid: "idle-a",
      agentUuid: "agent-a",
      agentName: "Alpha",
      cwd: "/idle",
    });
    const offline = conn({
      uuid: "offline-a",
      agentUuid: "agent-a",
      agentName: "Alpha",
      effectiveStatus: "offline",
    });

    const result = sortConnectionsForPresence(
      [offline, idle, queued, running],
      {
        [running.uuid]: [exec({ uuid: "run", connectionUuid: running.uuid, status: "running" })],
        [queued.uuid]: [exec({ uuid: "queue", connectionUuid: queued.uuid, status: "queued" })],
        [idle.uuid]: [],
        [offline.uuid]: [exec({ uuid: "offline-run", connectionUuid: offline.uuid, status: "running" })],
      },
    );

    expect(result.map((c) => c.uuid)).toEqual([
      "running-z",
      "queued-a",
      "idle-a",
      "offline-a",
    ]);
  });

  it("orders groups by highest instance activity when execution state is provided", () => {
    const betaRunning = conn({
      uuid: "beta-running",
      agentUuid: "agent-b",
      agentName: "Beta",
    });
    const alphaIdle = conn({
      uuid: "alpha-idle",
      agentUuid: "agent-a",
      agentName: "Alpha",
    });

    const groups = groupConnectionsByAgent(
      [alphaIdle, betaRunning],
      {
        [betaRunning.uuid]: [
          exec({ uuid: "run", connectionUuid: betaRunning.uuid, status: "running" }),
        ],
      },
    );

    expect(groups.map((g) => g.agentUuid)).toEqual(["agent-b", "agent-a"]);
  });

  it("returns the same order for equivalent shuffled refresh payloads", () => {
    const a = [
      conn({ uuid: "z", agentUuid: "agent-z", agentName: "Zeta", cwd: "/z" }),
      conn({ uuid: "a-null", agentUuid: "agent-a", agentName: "Alpha", cwd: null }),
      conn({ uuid: "a-a", agentUuid: "agent-a", agentName: "Alpha", cwd: "/a" }),
    ];
    const b = [
      conn({ uuid: "a-a", agentUuid: "agent-a", agentName: "Alpha", cwd: "/a" }),
      conn({ uuid: "z", agentUuid: "agent-z", agentName: "Zeta", cwd: "/z" }),
      conn({ uuid: "a-null", agentUuid: "agent-a", agentName: "Alpha", cwd: null }),
    ];

    expect(sortConnectionsForPresence(a).map((c) => c.uuid)).toEqual([
      "a-a",
      "a-null",
      "z",
    ]);
    expect(sortConnectionsForPresence(b).map((c) => c.uuid)).toEqual(
      sortConnectionsForPresence(a).map((c) => c.uuid),
    );
  });
});

describe("deriveInstanceActivity", () => {
  it("returns offline for an offline connection regardless of executions", () => {
    const result = deriveInstanceActivity(
      conn({ uuid: "a1", effectiveStatus: "offline" }),
      [exec({ uuid: "e1", status: "running" })],
    );
    expect(result.state).toBe("offline");
    expect(result.runningStartedAt).toBeNull();
  });

  it("returns running anchored to the earliest running execution start", () => {
    const result = deriveInstanceActivity(conn({ uuid: "a1" }), [
      exec({ uuid: "e1", status: "running", startedAt: "2026-06-23T12:05:00.000Z" }),
      exec({ uuid: "e2", status: "running", startedAt: "2026-06-23T12:01:00.000Z" }),
      exec({ uuid: "e3", status: "queued" }),
    ]);
    expect(result.state).toBe("running");
    expect(result.runningStartedAt).toBe("2026-06-23T12:01:00.000Z");
    expect(result.queuedCount).toBe(1);
  });

  it("falls back to createdAt when a running execution has no startedAt", () => {
    const result = deriveInstanceActivity(conn({ uuid: "a1" }), [
      exec({ uuid: "e1", status: "running", startedAt: null, createdAt: NOW }),
    ]);
    expect(result.state).toBe("running");
    expect(result.runningStartedAt).toBe(NOW);
  });

  it("returns queued (with count) when online and only queued work", () => {
    const result = deriveInstanceActivity(conn({ uuid: "a1" }), [
      exec({ uuid: "e1", status: "queued" }),
      exec({ uuid: "e2", status: "queued" }),
    ]);
    expect(result.state).toBe("queued");
    expect(result.queuedCount).toBe(2);
  });

  it("returns idle when online with no running or queued work", () => {
    const result = deriveInstanceActivity(conn({ uuid: "a1" }), [
      exec({ uuid: "e1", status: "interrupted" }),
    ]);
    expect(result.state).toBe("idle");
  });
});
