import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { prismaMock, emitted, getAuthContext } = vi.hoisted(() => ({
  emitted: [] as Array<[string, Record<string, unknown>]>,
  getAuthContext: vi.fn(),
  prismaMock: {
    agent: { findFirst: vi.fn() },
    daemonConnection: { findFirst: vi.fn() },
    daemonDirectoryRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ getAuthContext }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: {
    emit: (channel: string, event: Record<string, unknown>) => emitted.push([channel, event]),
  },
  controlEventName: (uuid: string) => `control:${uuid}`,
}));

import { createDirectoryRequest } from "@/services/project-agent-cwd.service";
import { POST as reportResult } from "@/app/api/daemon/directory-request/report/route";
import { createControlHandler } from "../../../cli/control-handler.mjs";
import { createDaemonRestClient } from "../../../cli/daemon-rest-client.mjs";

describe("directory request server-daemon boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted.length = 0;
    getAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: "company-1",
      actorUuid: "agent-1",
    });
    prismaMock.agent.findFirst.mockResolvedValue({ uuid: "agent-1" });
    prismaMock.daemonDirectoryRequest.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.daemonConnection.findFirst.mockResolvedValue({
      uuid: "conn-1",
      host: "host-1",
      agentInstanceUuid: "instance-1",
    });
  });

  it("creates, delivers, reports, and completes a correlated successful request", async () => {
    const deadlineAt = new Date(Date.now() + 15_000);
    prismaMock.daemonDirectoryRequest.create.mockResolvedValue({
      uuid: "request-1",
      limit: 50,
      deadlineAt,
      status: "pending",
    });
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      uuid: "request-1",
      companyUuid: "company-1",
      agentUuid: "agent-1",
      targetConnectionUuid: "conn-1",
      status: "pending",
      deadlineAt,
    });
    prismaMock.daemonDirectoryRequest.update.mockResolvedValue({
      uuid: "request-1",
      status: "success",
      result: { items: [{ name: "repo", path: "/work/repo" }], nextCursor: null },
    });

    await createDirectoryRequest({
      companyUuid: "company-1",
      userUuid: "user-1",
      agentUuid: "agent-1",
      targetConnectionUuid: "conn-1",
      operation: "list",
      prefix: "/work/re",
    });

    expect(emitted).toHaveLength(1);
    const [channel, controlEvent] = emitted[0];
    expect(channel).toBe("control:conn-1");
    expect(controlEvent).toMatchObject({
      command: "browse_directory",
      requestUuid: "request-1",
      targetConnectionUuid: "conn-1",
      operation: "list",
      prefix: "/work/re",
    });

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://chorus.test/api/daemon/directory-request/report");
      const request = new NextRequest(String(url), {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
      return reportResult(request, { params: Promise.resolve({}) });
    });
    const restClient = createDaemonRestClient({
      url: "https://chorus.test",
      apiKey: "cho_test",
      getConnectionUuid: () => "conn-1",
      fetchImpl,
    });
    const handler = createControlHandler({
      waker: { executions: new Map() },
      getConnectionUuid: () => "conn-1",
      handleDirectoryRequest: vi.fn(async () => ({
        items: [{ name: "repo", path: "/work/repo" }],
        nextCursor: null,
      })),
      reportDirectoryRequest: restClient.reportDirectoryRequest,
    });

    handler(controlEvent);
    await vi.waitFor(() => expect(prismaMock.daemonDirectoryRequest.update).toHaveBeenCalled());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      requestUuid: "request-1",
      connectionUuid: "conn-1",
      status: "succeeded",
      items: [{ name: "repo", path: "/work/repo" }],
      nextCursor: null,
    });
    expect(prismaMock.daemonDirectoryRequest.update).toHaveBeenCalledWith({
      where: { uuid: "request-1" },
      data: {
        status: "success",
        result: {
          items: [{ name: "repo", path: "/work/repo" }],
          nextCursor: null,
          normalizedPath: undefined,
        },
        errorCode: null,
        completedAt: expect.any(Date),
      },
    });
  });

  it("preserves a typed daemon failure instead of turning it into empty success", async () => {
    const deadlineAt = new Date(Date.now() + 15_000);
    prismaMock.daemonDirectoryRequest.findFirst.mockResolvedValue({
      uuid: "request-2",
      status: "pending",
      deadlineAt,
    });
    prismaMock.daemonDirectoryRequest.update.mockResolvedValue({
      uuid: "request-2",
      status: "error",
      errorCode: "OUTSIDE_ROOT",
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      reportResult(
        new NextRequest(String(url), {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        }),
        { params: Promise.resolve({}) },
      ),
    );
    const restClient = createDaemonRestClient({
      url: "https://chorus.test",
      apiKey: "cho_test",
      getConnectionUuid: () => "conn-1",
      fetchImpl,
    });
    const handler = createControlHandler({
      waker: { executions: new Map() },
      getConnectionUuid: () => "conn-1",
      handleDirectoryRequest: vi.fn(async () => {
        throw Object.assign(new Error("outside"), { code: "OUTSIDE_ROOT" });
      }),
      reportDirectoryRequest: restClient.reportDirectoryRequest,
    });

    handler({
      type: "control",
      command: "browse_directory",
      targetConnectionUuid: "conn-1",
      requestUuid: "request-2",
      operation: "list",
      prefix: "/outside",
    });
    await vi.waitFor(() => expect(prismaMock.daemonDirectoryRequest.update).toHaveBeenCalled());

    expect(prismaMock.daemonDirectoryRequest.update).toHaveBeenCalledWith({
      where: { uuid: "request-2" },
      data: {
        status: "error",
        result: undefined,
        errorCode: "OUTSIDE_ROOT",
        completedAt: expect.any(Date),
      },
    });
  });
});
