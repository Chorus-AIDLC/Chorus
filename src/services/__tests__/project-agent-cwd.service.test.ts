import { beforeEach, describe, expect, it, vi } from "vitest";

const { emit, prismaMock } = vi.hoisted(() => ({
  emit: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    project: { findFirst: vi.fn(), create: vi.fn() },
    daemonConnection: { findFirst: vi.fn(), findMany: vi.fn() },
    daemonDirectoryRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    projectAgentCwdPreference: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    agentInstance: { findFirst: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
  controlEventName: (uuid: string) => `control:${uuid}`,
}));

import {
  CwdServiceError,
  clearProjectAgentCwdPreference,
  cleanupDirectoryRequests,
  completeDirectoryRequest,
  createProjectWithAgentCwds,
  createDirectoryRequest,
  getDirectoryRequest,
  listProjectAgentCwdPreferences,
  resolveProjectAgentCwdTarget,
  resolveTemporaryRuntimeCwd,
  saveProjectAgentCwdPreference,
} from "@/services/project-agent-cwd.service";

const base = {
  companyUuid: "company-1",
  userUuid: "user-1",
  agentUuid: "agent-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.agent.findFirst.mockResolvedValue({ uuid: "agent-1" });
  prismaMock.project.findFirst.mockResolvedValue({ uuid: "project-1" });
  prismaMock.agentInstance.upsert.mockResolvedValue({ uuid: "instance-1" });
  prismaMock.$transaction.mockImplementation(
    (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
  );
});

describe("project-agent cwd request service", () => {
  it("creates a project and its fixed cwd in one transaction", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      targetConnectionUuid: "conn-1",
      result: { normalizedPath: "/workspace" },
    });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({ host: "host-1" });
    prismaMock.project.create.mockResolvedValue({
      uuid: "project-new",
      name: "New",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await createProjectWithAgentCwds({
      companyUuid: "company-1",
      userUuid: "user-1",
      name: "New",
      description: null,
      groupUuid: null,
      agentCwds: [{
        agentUuid: "agent-1",
        validationRequestUuid: "validation-1",
      }],
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.projectAgentCwdPreference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectUuid: "project-new",
        agentUuid: "agent-1",
        host: "host-1",
        cwd: "/workspace",
      }),
    });
  });

  it("lists online Agents plus configured offline preferences only", async () => {
    prismaMock.agent.findMany.mockResolvedValue([
      { uuid: "online", name: "Online" },
      { uuid: "offline-configured", name: "Configured" },
      { uuid: "offline-empty", name: "Hidden" },
    ]);
    prismaMock.projectAgentCwdPreference.findMany.mockResolvedValue([{
      uuid: "pref-1",
      agentUuid: "offline-configured",
      host: "old-host",
      cwd: "/old",
      anchorAgentInstanceUuid: "instance-old",
      updatedAt: new Date(),
    }]);
    prismaMock.daemonConnection.findMany.mockResolvedValue([{
      uuid: "conn-1",
      agentUuid: "online",
      agentInstanceUuid: "instance-1",
      host: "host-1",
      cwd: "/work",
      lastSeenAt: new Date(),
    }]);

    const result = await listProjectAgentCwdPreferences(
      "company-1",
      "user-1",
      "project-1",
    );

    expect(result.map((item) => item.agent.uuid)).toEqual([
      "online",
      "offline-configured",
    ]);
    expect(result[1].preference?.status).toBe("offline");
  });

  it("returns non-disclosing NOT_FOUND when the agent is not owned in the tenant", async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null);
    await expect(
      createDirectoryRequest({
        ...base,
        targetConnectionUuid: "conn-1",
        operation: "list",
        prefix: "/work/a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.daemonConnection.findFirst).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("requires an online connection belonging to the same company and agent", async () => {
    prismaMock.daemonConnection.findFirst.mockResolvedValue(null);
    await expect(
      createDirectoryRequest({
        ...base,
        targetConnectionUuid: "foreign-conn",
        operation: "validate",
        cwd: "/work/a",
      }),
    ).rejects.toMatchObject({ code: "HOST_OFFLINE" });
    expect(prismaMock.daemonConnection.findFirst).toHaveBeenCalledWith({
      where: {
        uuid: "foreign-conn",
        companyUuid: "company-1",
        agentUuid: "agent-1",
        status: "online",
      },
      select: { uuid: true, host: true, agentInstanceUuid: true },
    });
  });

  it("persists then dispatches a bounded correlated request", async () => {
    prismaMock.daemonDirectoryRequest.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({
      uuid: "conn-1",
      host: "host-1",
      agentInstanceUuid: "instance-1",
    });
    const created = {
      uuid: "request-1",
      limit: 100,
      deadlineAt: new Date(Date.now() + 15_000),
    };
    prismaMock.daemonDirectoryRequest.create.mockResolvedValue(created);

    await createDirectoryRequest({
      ...base,
      targetConnectionUuid: "conn-1",
      operation: "list",
      prefix: "/work/a",
      limit: 999,
    });

    expect(prismaMock.daemonDirectoryRequest.deleteMany).toHaveBeenCalledOnce();
    expect(prismaMock.daemonDirectoryRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyUuid: "company-1",
        callerUserUuid: "user-1",
        agentUuid: "agent-1",
        targetConnectionUuid: "conn-1",
        operation: "list",
        prefix: "/work/a",
        limit: 100,
      }),
    });
    expect(emit).toHaveBeenCalledWith(
      "control:conn-1",
      expect.objectContaining({
        command: "browse_directory",
        requestUuid: "request-1",
        limit: 100,
      }),
    );
  });

  it("dispatches a roots request without accepting a client path", async () => {
    prismaMock.daemonDirectoryRequest.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({
      uuid: "conn-1",
      host: "host-1",
      agentInstanceUuid: "instance-1",
    });
    prismaMock.daemonDirectoryRequest.create.mockResolvedValue({
      uuid: "roots-1",
      limit: 50,
      deadlineAt: new Date(Date.now() + 15_000),
    });

    await createDirectoryRequest({
      ...base,
      targetConnectionUuid: "conn-1",
      operation: "roots",
    });

    expect(prismaMock.daemonDirectoryRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "roots",
        prefix: null,
        cwd: null,
      }),
    });
    expect(emit).toHaveBeenCalledWith(
      "control:conn-1",
      expect.objectContaining({
        operation: "roots",
        prefix: undefined,
        cwd: undefined,
      }),
    );
  });

  it("turns an overdue pending request into a terminal TIMEOUT", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      uuid: "request-1",
      status: "pending",
      deadlineAt: new Date(0),
    });
    prismaMock.daemonDirectoryRequest.update.mockResolvedValue({
      uuid: "request-1",
      status: "error",
      errorCode: "TIMEOUT",
    });

    const result = await getDirectoryRequest("company-1", "user-1", "request-1");
    expect(result).toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    expect(prismaMock.daemonDirectoryRequest.findFirst).toHaveBeenCalledWith({
      where: { uuid: "request-1", companyUuid: "company-1", callerUserUuid: "user-1" },
    });
  });

  it("accepts completion only from the targeted agent connection", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue(null);
    await expect(
      completeDirectoryRequest({
        companyUuid: "company-1",
        agentUuid: "agent-1",
        connectionUuid: "wrong-conn",
        requestUuid: "request-1",
        status: "success",
        result: { items: [] },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.daemonDirectoryRequest.findFirst).toHaveBeenCalledWith({
      where: {
        uuid: "request-1",
        companyUuid: "company-1",
        agentUuid: "agent-1",
        targetConnectionUuid: "wrong-conn",
        status: "pending",
      },
    });
  });

  it("terminalizes a malformed successful roots report as INTERNAL_ERROR", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      uuid: "roots-1",
      operation: "roots",
      status: "pending",
      deadlineAt: new Date(Date.now() + 15_000),
    });

    prismaMock.daemonDirectoryRequest.update.mockResolvedValue({
      uuid: "roots-1",
      status: "error",
      errorCode: "INTERNAL_ERROR",
    });

    const result = await completeDirectoryRequest({
      companyUuid: "company-1",
      agentUuid: "agent-1",
      connectionUuid: "conn-1",
      requestUuid: "roots-1",
      status: "success",
      result: { roots: [] },
    });

    expect(result).toMatchObject({ status: "error", errorCode: "INTERNAL_ERROR" });
    expect(prismaMock.daemonDirectoryRequest.update).toHaveBeenCalledWith({
      where: { uuid: "roots-1" },
      data: {
        status: "error",
        result: undefined,
        errorCode: "INTERNAL_ERROR",
        completedAt: expect.any(Date),
      },
    });
  });
});

describe("project-agent cwd preference service", () => {
  it.each([
    {
      label: "replacement",
      preference: {
        uuid: "pref-2",
        host: "replacement-host",
        cwd: "/work/replacement",
        anchorAgentInstanceUuid: "replacement-instance",
      },
    },
    { label: "clear", preference: null },
  ])(
    "keeps the persisted root instance after preference $label",
    async ({ preference }) => {
      prismaMock.projectAgentCwdPreference.findFirst.mockResolvedValue(preference);
      prismaMock.agentInstance.findFirst.mockResolvedValue({
        uuid: "root-instance",
        host: "root-host",
        cwd: "/work/root",
      });
      prismaMock.daemonConnection.findMany.mockResolvedValue([
        {
          uuid: "root-connection",
          agentUuid: "agent-1",
          agent: { name: "Agent", ownerUuid: "user-1" },
          clientType: "claude_code",
          clientVersion: null,
          host: "root-host",
          cwd: "/work/root",
          startedAt: null,
          status: "online",
          connectedAt: new Date(),
          lastSeenAt: new Date(),
          disconnectedAt: null,
          agentInstanceUuid: "root-instance",
        },
      ]);

      await expect(
        resolveProjectAgentCwdTarget({
          companyUuid: "company-1",
          actorUserUuid: "user-1",
          projectUuid: "project-1",
          agentUuid: "agent-1",
          temporaryTarget: { host: "temporary-host", cwd: "/work/temporary" },
          registeredInstanceUuid: "root-instance",
        }),
      ).resolves.toEqual({
        actorUserUuid: "user-1",
        source: "registered_instance",
        agentUuid: "agent-1",
        host: "root-host",
        cwd: "/work/root",
        availability: "ready",
        promptPolicy: "none",
        connectionUuid: "root-connection",
        agentInstanceUuid: "root-instance",
      });
      expect(prismaMock.agentInstance.upsert).not.toHaveBeenCalled();
    },
  );

  it("resolves a registered discovered path through an online connection on the same host", async () => {
    prismaMock.projectAgentCwdPreference.findFirst.mockResolvedValue(null);
    prismaMock.agentInstance.findFirst.mockResolvedValue({
      uuid: "root-instance",
      host: "root-host",
      cwd: "/discovered/not-a-startup-cwd",
    });
    prismaMock.daemonConnection.findMany.mockResolvedValue([
      {
        uuid: "root-connection",
        agentUuid: "agent-1",
        agent: { name: "Agent", ownerUuid: "user-1" },
        clientType: "claude_code",
        clientVersion: null,
        host: "root-host",
        cwd: "/daemon/startup",
        startedAt: null,
        status: "online",
        connectedAt: new Date(),
        lastSeenAt: new Date(),
        disconnectedAt: null,
        agentInstanceUuid: "startup-instance",
      },
    ]);

    await expect(
      resolveProjectAgentCwdTarget({
        companyUuid: "company-1",
        actorUserUuid: "user-1",
        projectUuid: "project-1",
        agentUuid: "agent-1",
        registeredInstanceUuid: "root-instance",
        registeredHost: "root-host",
        registeredRuntimeCwd: "/discovered/not-a-startup-cwd",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        source: "registered_instance",
        host: "root-host",
        cwd: "/discovered/not-a-startup-cwd",
        availability: "ready",
        connectionUuid: "root-connection",
      }),
    );
  });

  it.each([
    { label: "replacement", preference: { uuid: "new-pref" } },
    { label: "clear", preference: null },
  ])(
    "preserves fixed origin and runtime cwd after preference $label",
    async ({ preference }) => {
      prismaMock.projectAgentCwdPreference.findFirst.mockResolvedValue(preference);
      prismaMock.agentInstance.findFirst.mockResolvedValue({
        uuid: "fixed-instance",
        host: "fixed-host",
        cwd: "/discovered/fixed",
      });
      prismaMock.daemonConnection.findMany.mockResolvedValue([]);

      await expect(
        resolveProjectAgentCwdTarget({
          companyUuid: "company-1",
          actorUserUuid: "user-1",
          projectUuid: "project-1",
          agentUuid: "agent-1",
          registeredInstanceUuid: "fixed-instance",
          registeredSource: "project_fixed",
          registeredHost: "fixed-host",
          registeredRuntimeCwd: "/discovered/fixed",
        }),
      ).resolves.toEqual({
        actorUserUuid: "user-1",
        source: "project_fixed",
        agentUuid: "agent-1",
        host: "fixed-host",
        cwd: "/discovered/fixed",
        availability: "offline",
        promptPolicy: "suppress",
        connectionUuid: null,
        agentInstanceUuid: "fixed-instance",
      });
      expect(prismaMock.agentInstance.upsert).not.toHaveBeenCalled();
    },
  );

  it("returns an actor-bearing fixed snapshot, materializes its instance, and never degrades offline", async () => {
    prismaMock.projectAgentCwdPreference.findFirst.mockResolvedValue({
      uuid: "pref-1",
      host: "fixed-host",
      cwd: "/work/fixed",
      anchorAgentInstanceUuid: null,
    });
    prismaMock.daemonConnection.findMany.mockResolvedValue([]);
    prismaMock.agentInstance.upsert.mockResolvedValue({ uuid: "fixed-instance" });

    await expect(
      resolveProjectAgentCwdTarget({
        companyUuid: "company-1",
        actorUserUuid: "user-1",
        projectUuid: "project-1",
        agentUuid: "agent-1",
        temporaryTarget: { host: "other-host", cwd: "/other" },
      }),
    ).resolves.toEqual({
      actorUserUuid: "user-1",
      source: "project_fixed",
      agentUuid: "agent-1",
      host: "fixed-host",
      cwd: "/work/fixed",
      availability: "offline",
      promptPolicy: "suppress",
      connectionUuid: null,
      agentInstanceUuid: "fixed-instance",
    });
    expect(prismaMock.agentInstance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyUuid_agentUuid_host_cwd: {
            companyUuid: "company-1",
            agentUuid: "agent-1",
            host: "fixed-host",
            cwd: "/work/fixed",
          },
        },
      }),
    );
    expect(prismaMock.projectAgentCwdPreference.update).toHaveBeenCalledWith({
      where: { uuid: "pref-1" },
      data: { anchorAgentInstanceUuid: "fixed-instance" },
    });
  });

  it("keeps Agent and actor preference lookup isolated", async () => {
    prismaMock.projectAgentCwdPreference.findFirst.mockResolvedValue(null);
    prismaMock.daemonConnection.findMany.mockResolvedValue([]);

    await resolveProjectAgentCwdTarget({
      companyUuid: "company-1",
      actorUserUuid: "user-2",
      projectUuid: "project-1",
      agentUuid: "agent-b",
    });

    expect(prismaMock.projectAgentCwdPreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyUuid: "company-1",
          userUuid: "user-2",
          projectUuid: "project-1",
          agentUuid: "agent-b",
        },
      }),
    );
  });

  it("isolates multiple users and Agents across fixed save, clear, and temporary fallback", async () => {
    const validations = new Map([
      ["validation-user-1-agent-a", { cwd: "/raw/a", normalizedPath: "/work/a", connection: "conn-a" }],
      ["validation-user-1-agent-b", { cwd: "/raw/b", normalizedPath: "/work/b", connection: "conn-b" }],
      ["validation-user-2-agent-a", { cwd: "/raw/u2", normalizedPath: "/work/u2", connection: "conn-u2" }],
    ]);
    prismaMock.daemonDirectoryRequest.findFirst.mockImplementation(async ({ where }) => {
      const row = validations.get(where.uuid);
      return row
        ? {
            uuid: where.uuid,
            cwd: row.cwd,
            result: { normalizedPath: row.normalizedPath },
            targetConnectionUuid: row.connection,
          }
        : null;
    });
    prismaMock.daemonConnection.findFirst.mockImplementation(async ({ where }) => ({
      host: `host-${where.uuid}`,
      agentInstanceUuid: `instance-${where.uuid}`,
    }));
    prismaMock.projectAgentCwdPreference.upsert.mockResolvedValue({ uuid: "preference" });
    prismaMock.projectAgentCwdPreference.deleteMany.mockResolvedValue({ count: 1 });

    for (const input of [
      { userUuid: "user-1", agentUuid: "agent-a", validationRequestUuid: "validation-user-1-agent-a" },
      { userUuid: "user-1", agentUuid: "agent-b", validationRequestUuid: "validation-user-1-agent-b" },
      { userUuid: "user-2", agentUuid: "agent-a", validationRequestUuid: "validation-user-2-agent-a" },
    ]) {
      await saveProjectAgentCwdPreference({
        companyUuid: "company-1",
        projectUuid: "project-1",
        ...input,
      });
    }

    expect(
      prismaMock.projectAgentCwdPreference.upsert.mock.calls.map(([call]) => ({
        key: call.where.userUuid_projectUuid_agentUuid,
        cwd: call.create.cwd,
      })),
    ).toEqual([
      {
        key: { userUuid: "user-1", projectUuid: "project-1", agentUuid: "agent-a" },
        cwd: "/work/a",
      },
      {
        key: { userUuid: "user-1", projectUuid: "project-1", agentUuid: "agent-b" },
        cwd: "/work/b",
      },
      {
        key: { userUuid: "user-2", projectUuid: "project-1", agentUuid: "agent-a" },
        cwd: "/work/u2",
      },
    ]);

    await clearProjectAgentCwdPreference({
      companyUuid: "company-1",
      userUuid: "user-1",
      projectUuid: "project-1",
      agentUuid: "agent-a",
    });
    expect(prismaMock.projectAgentCwdPreference.deleteMany).toHaveBeenCalledWith({
      where: {
        companyUuid: "company-1",
        userUuid: "user-1",
        projectUuid: "project-1",
        agentUuid: "agent-a",
      },
    });
    // Clearing only this scoped row leaves the operation free to use a temporary
    // registered or discovered runtime cwd without writing another preference.
    expect(prismaMock.projectAgentCwdPreference.upsert).toHaveBeenCalledTimes(3);
  });

  it("resolves a fresh temporary cwd without writing a project preference", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      targetConnectionUuid: "conn-1",
      result: { normalizedPath: "/work/temporary" },
    });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({ host: "host-1" });

    await expect(
      resolveTemporaryRuntimeCwd({
        ...base,
        validationRequestUuid: "validation-1",
      }),
    ).resolves.toEqual({ host: "host-1", cwd: "/work/temporary" });
    expect(prismaMock.projectAgentCwdPreference.upsert).not.toHaveBeenCalled();
    expect(prismaMock.projectAgentCwdPreference.deleteMany).not.toHaveBeenCalled();
  });

  it("upserts only from a fresh successful validate request and replaces the same user/project/agent row", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      uuid: "validation-1",
      cwd: "/work/../work/repo",
      result: { normalizedPath: "/work/repo" },
      targetConnectionUuid: "conn-1",
    });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({
      host: "host-1",
      agentInstanceUuid: "instance-1",
    });
    prismaMock.projectAgentCwdPreference.upsert.mockResolvedValue({ uuid: "preference-1" });

    await saveProjectAgentCwdPreference({
      ...base,
      projectUuid: "project-1",
      validationRequestUuid: "validation-1",
    });

    expect(prismaMock.daemonDirectoryRequest.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        uuid: "validation-1",
        companyUuid: "company-1",
        callerUserUuid: "user-1",
        agentUuid: "agent-1",
        operation: "validate",
        status: "success",
        completedAt: { gte: expect.any(Date) },
      }),
    });
    expect(prismaMock.projectAgentCwdPreference.upsert).toHaveBeenCalledWith({
      where: {
        userUuid_projectUuid_agentUuid: {
          userUuid: "user-1",
          projectUuid: "project-1",
          agentUuid: "agent-1",
        },
      },
      create: expect.objectContaining({ host: "host-1", cwd: "/work/repo" }),
      update: {
        host: "host-1",
        cwd: "/work/repo",
        anchorAgentInstanceUuid: "instance-1",
      },
    });
  });

  it("rejects stale or unsuccessful validation and prunes expired request history", async () => {
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue(null);
    await expect(
      saveProjectAgentCwdPreference({
        ...base,
        projectUuid: "project-1",
        validationRequestUuid: "stale",
      }),
    ).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(prismaMock.projectAgentCwdPreference.upsert).not.toHaveBeenCalled();

    prismaMock.daemonDirectoryRequest.deleteMany.mockResolvedValue({ count: 2 });
    await cleanupDirectoryRequests(new Date("2026-08-01T12:00:00Z"));
    expect(prismaMock.daemonDirectoryRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { deadlineAt: { lt: new Date("2026-08-01T11:00:00Z") } },
          { completedAt: { lt: new Date("2026-08-01T11:00:00Z") } },
        ],
      },
    });
  });
});
