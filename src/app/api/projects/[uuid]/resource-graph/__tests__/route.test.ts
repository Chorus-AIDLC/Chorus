// src/app/api/projects/[uuid]/resource-graph/__tests__/route.test.ts
// API integration tests for GET /api/projects/[uuid]/resource-graph — verify
// the standard { success, data } envelope, auth scoping, and the empty-graph
// success path. Pattern mirrors src/app/api/__tests__/tasks-route.test.ts:
// mock the service + auth, exercise the route handler with NextRequest.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====

const mockGetProjectResourceGraph = vi.fn();
const mockProjectExists = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("@/services/resource-graph.service", () => ({
  getProjectResourceGraph: (...args: unknown[]) => mockGetProjectResourceGraph(...args),
}));

vi.mock("@/services/project.service", () => ({
  projectExists: (...args: unknown[]) => mockProjectExists(...args),
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  hasPermission: (auth: { permissions?: string[] }, perm: string) =>
    auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: (
    auth: { type: string; permissions?: string[] },
    perm: string
  ) => {
    if (auth.type === "agent" && !(auth.permissions?.includes(perm) ?? false)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: `Missing permission: ${perm}` },
        }),
        { status: 403 }
      );
    }
    return null;
  },
}));

// Import the route handler AFTER the mocks are registered.
import { GET } from "@/app/api/projects/[uuid]/resource-graph/route";

const COMPANY_UUID = "company-0000-0000-0000-000000000001";
const PROJECT_UUID = "project-0000-0000-0000-000000000001";
const USER_AUTH = { type: "user", companyUuid: COMPANY_UUID, actorUuid: "user-1" };

function makeRequest(): NextRequest {
  return new NextRequest(
    new URL(`/api/projects/${PROJECT_UUID}/resource-graph`, "http://localhost:3000")
  );
}

function makeContext(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

describe("GET /api/projects/[uuid]/resource-graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(USER_AUTH);
    mockProjectExists.mockResolvedValue(true);
    mockGetProjectResourceGraph.mockResolvedValue({ nodes: [], edges: [] });
  });

  it("returns { success: true, data: { nodes, edges } } envelope on success", async () => {
    mockGetProjectResourceGraph.mockResolvedValue({
      nodes: [{ uuid: "i1", type: "idea", title: "I", parentIdeaUuid: null }],
      edges: [{ from: "i1", to: "p1", kind: "derive" }],
    });

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        nodes: [{ uuid: "i1", type: "idea", title: "I", parentIdeaUuid: null }],
        edges: [{ from: "i1", to: "p1", kind: "derive" }],
      },
      meta: undefined,
    });
  });

  it("returns empty nodes/edges (not an error) for a project with no entities", async () => {
    // Service returns the canonical empty payload — the route must surface
    // it as a 200 success, not 404 / 500.
    mockGetProjectResourceGraph.mockResolvedValue({ nodes: [], edges: [] });

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ nodes: [], edges: [] });
  });

  it("scopes the aggregation to the caller's companyUuid and the route projectUuid", async () => {
    await GET(makeRequest(), makeContext(PROJECT_UUID));

    expect(mockGetProjectResourceGraph).toHaveBeenCalledTimes(1);
    expect(mockGetProjectResourceGraph).toHaveBeenCalledWith(COMPANY_UUID, PROJECT_UUID);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));

    expect(response.status).toBe(401);
    expect(mockGetProjectResourceGraph).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist in the caller's company", async () => {
    mockProjectExists.mockResolvedValue(false);

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(mockGetProjectResourceGraph).not.toHaveBeenCalled();
  });

  it("returns 403 for an agent lacking task:read", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: "agent-1",
      permissions: [], // missing task:read
    });

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));

    expect(response.status).toBe(403);
    expect(mockGetProjectResourceGraph).not.toHaveBeenCalled();
  });

  it("admits an agent that carries task:read", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: "agent-1",
      permissions: ["task:read"],
    });

    const response = await GET(makeRequest(), makeContext(PROJECT_UUID));

    expect(response.status).toBe(200);
    expect(mockGetProjectResourceGraph).toHaveBeenCalledWith(COMPANY_UUID, PROJECT_UUID);
  });
});
