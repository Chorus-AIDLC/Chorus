import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockGetProjectProposals = vi.fn();
const mockProjectExists = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("@/services/proposal.service", () => ({
  getProjectProposals: (...args: unknown[]) => mockGetProjectProposals(...args),
}));

vi.mock("@/services/project.service", () => ({
  projectExists: (...args: unknown[]) => mockProjectExists(...args),
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

import { GET } from "@/app/api/projects/[uuid]/proposals/summary/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const mockAuth = { type: "user", companyUuid, actorUuid: "user-uuid-1" };

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

function makeContext(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

describe("GET /api/projects/[uuid]/proposals/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(mockAuth);
    mockProjectExists.mockResolvedValue(true);
    mockGetProjectProposals.mockResolvedValue([]);
  });

  it("returns proposal summary data in correct format", async () => {
    const mockData = [
      { uuid: "proposal-1", title: "Proposal One", sequenceNumber: 1, taskCount: 3 },
      { uuid: "proposal-2", title: "Proposal Two", sequenceNumber: 2, taskCount: 5 },
    ];
    mockGetProjectProposals.mockResolvedValue(mockData);

    const req = makeRequest(`/api/projects/${projectUuid}/proposals/summary`);
    const response = await GET(req, makeContext(projectUuid));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(mockData);
  });

  it("calls getProjectProposals with correct companyUuid and projectUuid", async () => {
    const req = makeRequest(`/api/projects/${projectUuid}/proposals/summary`);
    await GET(req, makeContext(projectUuid));

    expect(mockGetProjectProposals).toHaveBeenCalledWith(companyUuid, projectUuid);
  });

  it("returns empty array when no approved proposals exist", async () => {
    mockGetProjectProposals.mockResolvedValue([]);

    const req = makeRequest(`/api/projects/${projectUuid}/proposals/summary`);
    const response = await GET(req, makeContext(projectUuid));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const req = makeRequest(`/api/projects/${projectUuid}/proposals/summary`);
    const response = await GET(req, makeContext(projectUuid));

    expect(response.status).toBe(401);
  });

  it("returns 404 when project does not exist", async () => {
    mockProjectExists.mockResolvedValue(false);

    const req = makeRequest(`/api/projects/${projectUuid}/proposals/summary`);
    const response = await GET(req, makeContext(projectUuid));

    expect(response.status).toBe(404);
  });
});
