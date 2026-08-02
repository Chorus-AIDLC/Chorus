import { beforeEach, describe, expect, it, vi } from "vitest";

const { emit, prismaMock } = vi.hoisted(() => ({
  emit: vi.fn(),
  prismaMock: {
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    project: { findFirst: vi.fn() },
    daemonConnection: { findFirst: vi.fn(), findMany: vi.fn() },
    daemonDirectoryRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    projectAgentCwdPreference: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
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
  createDirectoryRequest,
  getDirectoryRequest,
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
});

describe("project-agent cwd request service", () => {
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
});

describe("project-agent cwd preference service", () => {
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
