// Preview-route REST tests — exercise the validation rails and verify the
// shape of the success payload. Cascade-count semantics are tested in
// idea.service.test.ts and the cascade-move integration test; here we only
// assert the route forwards `moved` through and rejects bad input.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockGetIdeaByUuid = vi.fn();
const mockMoveIdeaPreview = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/services/idea.service", () => ({
  getIdeaByUuid: (...args: unknown[]) => mockGetIdeaByUuid(...args),
  moveIdeaPreview: (...args: unknown[]) => mockMoveIdeaPreview(...args),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

import { GET } from "@/app/api/ideas/[uuid]/move/preview/route";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const USER_UUID = "22222222-2222-2222-2222-222222222222";
const IDEA_UUID = "33333333-3333-3333-3333-333333333333";
const SOURCE_PROJECT_UUID = "55555555-5555-5555-5555-555555555555";
const TARGET_PROJECT_UUID = "44444444-4444-4444-4444-444444444444";

function getRequest(targetProjectUuid?: string | null) {
  const url = new URL(`/api/ideas/${IDEA_UUID}/move/preview`, "http://localhost:3000");
  if (targetProjectUuid !== undefined && targetProjectUuid !== null) {
    url.searchParams.set("targetProjectUuid", targetProjectUuid);
  }
  return new NextRequest(url, { method: "GET" });
}

function ctx() {
  return { params: Promise.resolve({ uuid: IDEA_UUID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    type: "user",
    companyUuid: COMPANY_UUID,
    actorUuid: USER_UUID,
  });
  mockGetIdeaByUuid.mockResolvedValue({
    uuid: IDEA_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: SOURCE_PROJECT_UUID,
  });
});

describe("GET /api/ideas/[uuid]/move/preview", () => {
  it("returns the moved-counts shape on the happy path", async () => {
    mockMoveIdeaPreview.mockResolvedValue({
      moved: { proposals: 3, documents: 1, tasks: 4, activities: 8 },
    });

    const res = await GET(getRequest(TARGET_PROJECT_UUID), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      moved: { proposals: 3, documents: 1, tasks: 4, activities: 8 },
    });
    // Service is called with the company-scoped tuple.
    expect(mockMoveIdeaPreview).toHaveBeenCalledWith(
      COMPANY_UUID,
      IDEA_UUID,
      TARGET_PROJECT_UUID,
    );
  });

  it("returns 401 when there is no auth context", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await GET(getRequest(TARGET_PROJECT_UUID), ctx());
    expect(res.status).toBe(401);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });

  it("returns 400 when targetProjectUuid is missing entirely", async () => {
    const res = await GET(getRequest(null), ctx());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/targetProjectUuid/i);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });

  it("returns 400 when targetProjectUuid is not a valid UUID", async () => {
    const res = await GET(getRequest("not-a-uuid"), ctx());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/valid UUID/i);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });

  it("returns 400 when target project equals the idea's current project (same-project guard)", async () => {
    // Idea lives on SOURCE_PROJECT_UUID — preview to that same project should fail
    // before we hit the service layer (which has its own guard, but the route's
    // guard saves a DB round-trip and matches moveIdea's contract).
    const res = await GET(getRequest(SOURCE_PROJECT_UUID), ctx());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/already in the target project/i);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });

  it("returns 404 when the idea doesn't exist in this company", async () => {
    mockGetIdeaByUuid.mockResolvedValue(null);

    const res = await GET(getRequest(TARGET_PROJECT_UUID), ctx());
    expect(res.status).toBe(404);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });

  it("scopes the idea lookup by companyUuid (cross-company isolation)", async () => {
    mockMoveIdeaPreview.mockResolvedValue({
      moved: { proposals: 0, documents: 0, tasks: 0, activities: 0 },
    });

    await GET(getRequest(TARGET_PROJECT_UUID), ctx());

    expect(mockGetIdeaByUuid).toHaveBeenCalledWith(COMPANY_UUID, IDEA_UUID);
    // And the service receives the same companyUuid — no cross-tenant leak.
    expect(mockMoveIdeaPreview).toHaveBeenCalledWith(
      COMPANY_UUID,
      IDEA_UUID,
      TARGET_PROJECT_UUID,
    );
  });

  it("returns 403 for an agent that lacks idea:write", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: USER_UUID,
      roles: ["developer_agent"],
      permissions: ["idea:read"],
    });

    const res = await GET(getRequest(TARGET_PROJECT_UUID), ctx());
    expect(res.status).toBe(403);
    expect(mockMoveIdeaPreview).not.toHaveBeenCalled();
  });
});
