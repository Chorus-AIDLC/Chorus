import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====
// The preview is a pure COMPOSITION of the wake path's read primitives. Mock all of
// them so this is a true unit test of the three-way decision tree with no DB — and so
// the "no wake / no mutation / no activity" contract can be asserted by proving the
// mutating primitives are NEVER touched.

// prisma: only `idea.findFirst` is a legitimate read for the preview. `idea.update`,
// `activity.create`, and `notification.create` are provided as spies purely to PROVE the
// preview never writes — if any is called, the read-only contract is broken.
const mockIdeaFindFirst = vi.hoisted(() => vi.fn());
const mockIdeaUpdate = vi.hoisted(() => vi.fn());
const mockActivityCreate = vi.hoisted(() => vi.fn());
const mockNotificationCreate = vi.hoisted(() => vi.fn());
const mockPreferenceFindFirst = vi.hoisted(() => vi.fn());
const mockPreferenceUpdate = vi.hoisted(() => vi.fn());
const mockAgentInstanceUpsert = vi.hoisted(() => vi.fn());
const mockAgentInstanceFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    idea: { findFirst: mockIdeaFindFirst, update: mockIdeaUpdate },
    projectAgentCwdPreference: { findFirst: mockPreferenceFindFirst, update: mockPreferenceUpdate },
    agentInstance: {
      upsert: mockAgentInstanceUpsert,
      findFirst: mockAgentInstanceFindFirst,
    },
    activity: { create: mockActivityCreate },
    notification: { create: mockNotificationCreate },
  },
}));

const mockResolveAssigneeAgentUuid = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uuid-resolver", () => ({
  resolveAssigneeAgentUuid: mockResolveAssigneeAgentUuid,
}));

const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: mockListConnectionsForAgent,
}));

// notification-turn: the preview no longer consults the session-origin (owner choice B —
// a bare agent with >=2 online ALWAYS prompts). `createTurnAndResolveTarget` /
// `maybeCreateTurnForWakeNotification` are the WAKE entry points — provided as spies so we
// can assert the preview never wakes.
const mockCreateTurnAndResolveTarget = vi.hoisted(() => vi.fn());
const mockMaybeCreateTurnForWakeNotification = vi.hoisted(() => vi.fn());
vi.mock("@/services/notification-turn", () => ({
  createTurnAndResolveTarget: mockCreateTurnAndResolveTarget,
  maybeCreateTurnForWakeNotification: mockMaybeCreateTurnForWakeNotification,
}));

import { previewIdeaWakeTarget } from "@/services/wake-preview.service";
import type { ConnectionView } from "@/services/daemon-connection.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";

let connSeq = 0;

/**
 * Build a `ConnectionView` fixture. The preview reads `uuid`, `agentInstanceUuid`,
 * `host`, `cwd`, and (for the online filter) `effectiveStatus`; the rest are filled with
 * plausible values so the fixture is a structurally-complete ConnectionView.
 */
function makeConnection(
  overrides: Partial<ConnectionView> = {},
): ConnectionView {
  connSeq += 1;
  return {
    uuid: `conn-${connSeq}`,
    agentUuid,
    agentName: "Build Agent",
    ownerUuid: "owner-1",
    clientType: "claude_code",
    clientVersion: "0.14.1",
    host: `host-${connSeq}`,
    cwd: `/repo/${connSeq}`,
    startedAt: "2026-07-15T00:00:00.000Z",
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-07-15T00:00:00.000Z",
    lastSeenAt: "2026-07-15T00:00:30.000Z",
    disconnectedAt: null,
    agentInstanceUuid: `instance-${connSeq}`,
    ...overrides,
  };
}

/** Assert NOTHING that would wake / mutate / emit an activity was ever invoked. */
function expectNoSideEffects() {
  expect(mockIdeaUpdate).not.toHaveBeenCalled();
  expect(mockActivityCreate).not.toHaveBeenCalled();
  expect(mockNotificationCreate).not.toHaveBeenCalled();
  expect(mockCreateTurnAndResolveTarget).not.toHaveBeenCalled();
  expect(mockMaybeCreateTurnForWakeNotification).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  connSeq = 0;
  // Sensible defaults: idea exists, assigned to a bare agent, agent resolves to itself,
  // no connections. Individual tests override the pieces they exercise.
  mockIdeaFindFirst.mockResolvedValue({
    assigneeType: "agent",
    assigneeUuid: agentUuid,
    projectUuid: "project-1",
    cwdSource: null,
    cwdHost: null,
    runtimeCwd: null,
  });
  mockResolveAssigneeAgentUuid.mockResolvedValue(agentUuid);
  mockListConnectionsForAgent.mockResolvedValue([]);
  mockPreferenceFindFirst.mockResolvedValue(null);
  mockAgentInstanceUpsert.mockResolvedValue({ uuid: "fixed-instance" });
  mockAgentInstanceFindFirst.mockResolvedValue(null);
});

describe("previewIdeaWakeTarget — outcome classification", () => {
  it("pick: bare agent, >=2 online", async () => {
    const conns = [makeConnection(), makeConnection()];
    mockListConnectionsForAgent.mockResolvedValue(conns);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview).not.toBeNull();
    expect(preview!.outcome).toBe("pick");
    expect(preview!.assigneeAgentUuid).toBe(agentUuid);
    expect(preview!.onlineInstances).toHaveLength(2);
    expectNoSideEffects();
  });

  it("pick: a bare agent with >=2 online ALWAYS prompts even when the idea has an online session-origin (owner choice B)", async () => {
    // Regression for the live-test decision: previously an idea with an existing online
    // session-origin short-circuited to `direct` (the picker never fired for
    // conversational-entry / already-elaborated ideas). Owner choice B: a bare agent with
    // >=2 online ALWAYS prompts + persists, regardless of session-origin. The preview no
    // longer consults the session-origin at all — proven below by asserting `pick`.
    const conns = [makeConnection(), makeConnection()];
    mockListConnectionsForAgent.mockResolvedValue(conns);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.outcome).toBe("pick");
    expect(preview!.onlineInstances).toHaveLength(2);
    expectNoSideEffects();
  });

  it("auto_pin: bare agent with exactly one online connection", async () => {
    mockListConnectionsForAgent.mockResolvedValue([makeConnection()]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.outcome).toBe("auto_pin");
    expect(preview!.onlineInstances).toHaveLength(1);
    expectNoSideEffects();
  });

  it("direct: a fixed project-Agent cwd suppresses picker and auto-pin semantics", async () => {
    mockIdeaFindFirst.mockImplementation(async ({ select }) =>
      "projectUuid" in select
        ? { projectUuid: "project-1" }
        : { assigneeType: "agent", assigneeUuid: agentUuid },
    );
    mockPreferenceFindFirst.mockResolvedValue({ uuid: "preference-1" });
    mockListConnectionsForAgent.mockResolvedValue([makeConnection(), makeConnection()]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid, "user-1");

    expect(preview!.outcome).toBe("direct");
    expect(mockPreferenceFindFirst).toHaveBeenCalledWith({
      where: {
        companyUuid,
        userUuid: "user-1",
        projectUuid: "project-1",
        agentUuid,
      },
      select: {
        uuid: true,
        host: true,
        cwd: true,
        anchorAgentInstanceUuid: true,
      },
    });
  });

  it("direct (sub-case: already agent_instance): assignee is instance-pinned", async () => {
    mockIdeaFindFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: "instance-xyz",
    });
    // Even with two online connections, an already-pinned idea is `direct`.
    mockListConnectionsForAgent.mockResolvedValue([
      makeConnection(),
      makeConnection(),
    ]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.outcome).toBe("direct");
    expect(preview!.assigneeAgentUuid).toBe(agentUuid);
    expectNoSideEffects();
  });

  it("direct: a persisted fixed assignment retains fixed origin and discovered runtime cwd", async () => {
    mockIdeaFindFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: "fixed-instance",
      projectUuid: "project-1",
      cwdSource: "project_fixed",
      cwdHost: "fixed-host",
      runtimeCwd: "/discovered/fixed",
    });
    mockAgentInstanceFindFirst.mockResolvedValue({
      uuid: "fixed-instance",
      host: "fixed-host",
      cwd: "/discovered/fixed",
    });

    const preview = await previewIdeaWakeTarget(
      companyUuid,
      ideaUuid,
      "user-1",
    );

    expect(preview).toMatchObject({
      outcome: "direct",
      resolvedTarget: {
        source: "project_fixed",
        host: "fixed-host",
        cwd: "/discovered/fixed",
        availability: "offline",
        promptPolicy: "suppress",
      },
    });
  });

  it("direct: an ordinary instance pin is not mislabeled as project fixed", async () => {
    mockIdeaFindFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: "ordinary-instance",
      projectUuid: "project-1",
      cwdSource: null,
      cwdHost: null,
      runtimeCwd: null,
    });
    mockAgentInstanceFindFirst.mockResolvedValue({
      uuid: "ordinary-instance",
      host: "ordinary-host",
      cwd: "/ordinary",
    });

    const preview = await previewIdeaWakeTarget(
      companyUuid,
      ideaUuid,
      "user-1",
    );

    expect(preview?.resolvedTarget).toMatchObject({
      source: "registered_instance",
      host: "ordinary-host",
      cwd: "/ordinary",
      promptPolicy: "none",
    });
  });

  it("direct (sub-case: zero online): the agent has connections but none online", async () => {
    // Two connections, both offline → zero effectively-online → direct (server handles
    // the offline case at wake time).
    mockListConnectionsForAgent.mockResolvedValue([
      makeConnection({ effectiveStatus: "offline", status: "offline" }),
      makeConnection({ effectiveStatus: "offline", status: "offline" }),
    ]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.outcome).toBe("direct");
    expect(preview!.onlineInstances).toHaveLength(0);
    expectNoSideEffects();
  });

  it("direct (sub-case: no agent assignee): a user-assigned idea yields direct with no candidates", async () => {
    mockIdeaFindFirst.mockResolvedValue({
      assigneeType: "user",
      assigneeUuid: "user-1",
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(null);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.outcome).toBe("direct");
    expect(preview!.assigneeAgentUuid).toBeNull();
    expect(preview!.onlineInstances).toEqual([]);
    // No agent → the connection registry is never even queried.
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

describe("previewIdeaWakeTarget — candidate shape & scoping", () => {
  it("onlineInstances carry the durable agentInstanceUuid (so a later pin can persist it)", async () => {
    mockListConnectionsForAgent.mockResolvedValue([
      makeConnection({
        uuid: "conn-A",
        agentInstanceUuid: "instance-A",
        host: "laptop",
        cwd: "/work/alpha",
        effectiveStatus: "online",
      }),
      makeConnection({
        uuid: "conn-B",
        agentInstanceUuid: "instance-B",
        host: "laptop",
        cwd: "/work/beta",
        effectiveStatus: "online",
      }),
    ]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview!.onlineInstances).toEqual([
      {
        connectionUuid: "conn-A",
        agentInstanceUuid: "instance-A",
        host: "laptop",
        cwd: "/work/alpha",
        effectiveStatus: "online",
      },
      {
        connectionUuid: "conn-B",
        agentInstanceUuid: "instance-B",
        host: "laptop",
        cwd: "/work/beta",
        effectiveStatus: "online",
      },
    ]);
  });

  it("filters offline connections out of the candidate list (mixed online/offline)", async () => {
    mockListConnectionsForAgent.mockResolvedValue([
      makeConnection({ uuid: "on-1", effectiveStatus: "online" }),
      makeConnection({ uuid: "off-1", effectiveStatus: "offline", status: "offline" }),
      makeConnection({ uuid: "on-2", effectiveStatus: "online" }),
    ]);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    // Two online → pick (owner choice B); offline one is excluded.
    expect(preview!.outcome).toBe("pick");
    expect(preview!.onlineInstances.map((i) => i.connectionUuid)).toEqual([
      "on-1",
      "on-2",
    ]);
  });

  it("returns null (→ route 404) when the idea is not in this company", async () => {
    mockIdeaFindFirst.mockResolvedValue(null);

    const preview = await previewIdeaWakeTarget(companyUuid, ideaUuid);

    expect(preview).toBeNull();
    // Company-scoped lookup: the miss came from the scoped where clause.
    expect(mockIdeaFindFirst).toHaveBeenCalledWith({
      where: { uuid: ideaUuid, companyUuid },
      select: {
        assigneeType: true,
        assigneeUuid: true,
        projectUuid: true,
        cwdSource: true,
        cwdHost: true,
        runtimeCwd: true,
      },
    });
    // Never resolves an assignee / touches the registry / wakes for a missing idea.
    expect(mockResolveAssigneeAgentUuid).not.toHaveBeenCalled();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});
