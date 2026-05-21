// Move-route REST tests — narrow contract: the response carries the cascade
// counts from the service (`moved`) and basic auth/validation paths return the
// expected error shapes. Service-level cascade behavior is covered separately
// in idea.service.test.ts and the cascade-move integration test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockMoveIdea = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/services/idea.service", () => ({
  moveIdea: (...args: unknown[]) => mockMoveIdea(...args),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

import { PATCH } from "@/app/api/ideas/[uuid]/move/route";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const USER_UUID = "22222222-2222-2222-2222-222222222222";
const IDEA_UUID = "33333333-3333-3333-3333-333333333333";
const TARGET_PROJECT_UUID = "44444444-4444-4444-4444-444444444444";

function jsonRequest(body: unknown) {
  return new NextRequest(new URL(`/api/ideas/${IDEA_UUID}/move`, "http://localhost:3000"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
});

describe("PATCH /api/ideas/[uuid]/move — moved cascade counts", () => {
  it("includes the `moved` cascade counts from the service in the success payload", async () => {
    mockMoveIdea.mockResolvedValue({
      uuid: IDEA_UUID,
      title: "Test Idea",
      content: null,
      attachments: null,
      status: "elaborating",
      assignee: null,
      createdBy: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      project: { uuid: TARGET_PROJECT_UUID, name: "Target Project" },
      moved: { proposals: 2, documents: 1, tasks: 5, activities: 9 },
    });

    const res = await PATCH(jsonRequest({ targetProjectUuid: TARGET_PROJECT_UUID }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.uuid).toBe(IDEA_UUID);
    expect(body.data.moved).toEqual({ proposals: 2, documents: 1, tasks: 5, activities: 9 });
    expect(mockMoveIdea).toHaveBeenCalledWith(
      COMPANY_UUID,
      IDEA_UUID,
      TARGET_PROJECT_UUID,
      USER_UUID,
      "user",
    );
  });

  it("propagates zero-cascade results (an Idea with no Proposals reports 0s)", async () => {
    mockMoveIdea.mockResolvedValue({
      uuid: IDEA_UUID,
      title: "Lonely Idea",
      content: null,
      attachments: null,
      status: "open",
      assignee: null,
      createdBy: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      project: { uuid: TARGET_PROJECT_UUID, name: "Target Project" },
      moved: { proposals: 0, documents: 0, tasks: 0, activities: 1 },
    });

    const res = await PATCH(jsonRequest({ targetProjectUuid: TARGET_PROJECT_UUID }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.moved).toEqual({ proposals: 0, documents: 0, tasks: 0, activities: 1 });
  });

  it("returns 401 when there is no auth context", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await PATCH(jsonRequest({ targetProjectUuid: TARGET_PROJECT_UUID }), ctx());
    expect(res.status).toBe(401);
    expect(mockMoveIdea).not.toHaveBeenCalled();
  });

  it("returns 400 when targetProjectUuid is missing", async () => {
    const res = await PATCH(jsonRequest({}), ctx());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mockMoveIdea).not.toHaveBeenCalled();
  });

  it("returns 403 for an agent without idea:write", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: USER_UUID,
      roles: ["developer_agent"],
      permissions: ["idea:read"],
    });

    const res = await PATCH(jsonRequest({ targetProjectUuid: TARGET_PROJECT_UUID }), ctx());
    expect(res.status).toBe(403);
    expect(mockMoveIdea).not.toHaveBeenCalled();
  });
});
