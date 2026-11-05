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

vi.mock("@/services/project-access.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/project-access.service")>();
  return {
    ...actual,
    // Project-access gate backed by the legacy existence mock: missing → 404.
    requireProjectAccess: async (auth: { companyUuid: string }, projectUuid: string) => {
      if (!(await mockProjectExists(auth.companyUuid, projectUuid))) {
        throw new actual.ProjectNotFoundError("project");
      }
      return { uuid: projectUuid, companyUuid: auth.companyUuid, visibility: "public", accessLevel: "editor" };
    },
  };
});

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  isPmAgent: (auth: { roles?: string[] }) => auth.roles?.includes("pm_agent") ?? false,
  hasPermission: (auth: { permissions?: string[] }, perm: string) =>
    auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: (auth: { type: string; permissions?: string[] }, perm: string) => {
    if (auth.type === "agent" && !(auth.permissions?.includes(perm) ?? false)) {
      return new Response(JSON.stringify({ success: false, error: { message: `Missing permission: ${perm}` } }), { status: 403 });
    }
    return null;
  },
}));

import { GET, POST } from "@/app/api/projects/[uuid]/tasks/route";
import { ApiError } from "@/lib/api-handler";

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
    expect(callArg.ideaUuid).toBeUndefined();
  });

  it("passes the ideaUuid filter to listTasks when provided", async () => {
    const req = makeRequest(`/api/projects/${projectUuid}/tasks?ideaUuid=idea-1`);
    await GET(req, makeContext(projectUuid));

    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ ideaUuid: "idea-1" }));
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

describe("POST /api/projects/[uuid]/tasks — ideaUuid", () => {
  function post(body: Record<string, unknown>) {
    return POST(new NextRequest(new URL(`/api/projects/${projectUuid}/tasks`, "http://localhost:3000"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), makeContext(projectUuid));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(mockAuth);
    mockProjectExists.mockResolvedValue(true);
    mockCreateTask.mockResolvedValue({ uuid: "task-1", ideaUuid: "idea-1" });
  });

  it("passes ideaUuid through to createTask", async () => {
    const response = await post({ title: "Fix", ideaUuid: "idea-1" });
    expect(response.status).toBe(200);
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({ projectUuid, ideaUuid: "idea-1" }));
  });

  it("defaults ideaUuid to null when omitted", async () => {
    await post({ title: "Fix" });
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({ ideaUuid: null }));
  });

  it("returns 400 for a non-string ideaUuid without calling the service", async () => {
    const response = await post({ title: "Fix", ideaUuid: 42 });
    expect(response.status).toBe(400);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it.each([
    [400, new ApiError("BAD_REQUEST", "Idea must be in the same project as the task", 400)],
    [400, new ApiError("BAD_REQUEST", "Theme ideas cannot have tasks; link a child idea", 400)],
    [404, new ApiError("NOT_FOUND", "Idea not found", 404)],
  ])("maps service link-validation errors to %i", async (status, error) => {
    mockCreateTask.mockRejectedValue(error);
    const response = await post({ title: "Fix", ideaUuid: "bad-idea" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.message).toBe(error.message);
  });
});
