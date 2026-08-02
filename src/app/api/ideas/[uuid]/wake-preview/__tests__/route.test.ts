import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockPreviewIdeaWakeTarget = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/wake-preview.service", () => ({
  previewIdeaWakeTarget: (...args: unknown[]) => mockPreviewIdeaWakeTarget(...args),
}));

import { GET } from "@/app/api/ideas/[uuid]/wake-preview/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "actor-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid };
const superAdminAuth = { type: "super_admin", companyUuid, actorUuid };
const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };

const samplePreview = {
  outcome: "pick",
  assigneeAgentUuid: "agent-0000-0000-0000-000000000001",
  onlineInstances: [
    {
      connectionUuid: "conn-1",
      agentInstanceUuid: "instance-1",
      host: "laptop",
      cwd: "/work/alpha",
      effectiveStatus: "online",
    },
  ],
};

function makeRequest(): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/ideas/${ideaUuid}/wake-preview`),
  );
}

const ctx = { params: Promise.resolve({ uuid: ideaUuid }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockPreviewIdeaWakeTarget.mockResolvedValue(samplePreview);
});

describe("GET /api/ideas/[uuid]/wake-preview", () => {
  it("returns 401 and never calls the service when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(401);
    expect(mockPreviewIdeaWakeTarget).not.toHaveBeenCalled();
  });

  it("returns 403 for an agent caller and never calls the service", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(403);
    expect(mockPreviewIdeaWakeTarget).not.toHaveBeenCalled();
  });

  it("returns 200 with the preview envelope for a user caller (company-scoped)", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);

    const res = await GET(makeRequest(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockPreviewIdeaWakeTarget).toHaveBeenCalledTimes(1);
    expect(mockPreviewIdeaWakeTarget).toHaveBeenCalledWith(companyUuid, ideaUuid, actorUuid);
    expect(body).toEqual({ success: true, data: samplePreview, meta: undefined });
  });

  it("allows a super_admin caller", async () => {
    mockGetAuthContext.mockResolvedValue(superAdminAuth);

    const res = await GET(makeRequest(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockPreviewIdeaWakeTarget).toHaveBeenCalledWith(companyUuid, ideaUuid, actorUuid);
    expect(body.data.outcome).toBe("pick");
  });

  it("returns 404 when the service reports the idea is absent / cross-company", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);
    mockPreviewIdeaWakeTarget.mockResolvedValue(null);

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(404);
    // The scoped lookup ran; the null result is what maps to 404.
    expect(mockPreviewIdeaWakeTarget).toHaveBeenCalledWith(companyUuid, ideaUuid, actorUuid);
  });
});
