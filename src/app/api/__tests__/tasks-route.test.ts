import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockListTasks = vi.fn();
const mockCreateTask = vi.fn();
const mockProjectExists = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("@/services/task.service", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
}));

vi.mock("@/services/project.service", () => ({
  projectExists: (...args: unknown[]) => mockProjectExists(...args),
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isPmAgent: (auth: { roles?: string[] }) => auth.roles?.includes("pm_agent") ?? false,
}));

import { GET } from "@/app/api/projects/[uuid]/tasks/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const mockAuth = { type: "user", companyUuid, actorUuid: "user-uuid-1" };

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

function makeContext(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

describe("GET /api/projects/[uuid]/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(mockAuth);
    mockProjectExists.mockResolvedValue(true);
    mockListTasks.mockResolvedValue({ tasks: [], total: 0 });
  });

  it("passes proposalUuids filter to listTasks when provided", async () => {
    const req = makeRequest(
      `/api/projects/${projectUuid}/tasks?proposalUuids=uuid-1,uuid-2`
    );
    const response = await GET(req, makeContext(projectUuid));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        proposalUuids: ["uuid-1", "uuid-2"],
      })
    );
  });

  it("does not pass proposalUuids when param is absent (backward compat)", async () => {
    const req = makeRequest(`/api/projects/${projectUuid}/tasks`);
    await GET(req, makeContext(projectUuid));

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
      })
    );
    // proposalUuids should be undefined
    const callArg = mockListTasks.mock.calls[0][0];
    expect(callArg.proposalUuids).toBeUndefined();
  });

  it("handles single proposalUuid correctly", async () => {
    const req = makeRequest(
      `/api/projects/${projectUuid}/tasks?proposalUuids=single-uuid`
    );
    await GET(req, makeContext(projectUuid));

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalUuids: ["single-uuid"],
      })
    );
  });

  it("filters out empty strings from proposalUuids", async () => {
    const req = makeRequest(
      `/api/projects/${projectUuid}/tasks?proposalUuids=uuid-1,,uuid-2,`
    );
    await GET(req, makeContext(projectUuid));

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalUuids: ["uuid-1", "uuid-2"],
      })
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const req = makeRequest(`/api/projects/${projectUuid}/tasks`);
    const response = await GET(req, makeContext(projectUuid));

    expect(response.status).toBe(401);
  });

  it("returns 404 when project does not exist", async () => {
    mockProjectExists.mockResolvedValue(false);

    const req = makeRequest(`/api/projects/${projectUuid}/tasks`);
    const response = await GET(req, makeContext(projectUuid));

    expect(response.status).toBe(404);
  });
});
