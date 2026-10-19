import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  resolveUserMentions: vi.fn(),
  entityFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("@/services/mention.service", () => ({ resolveUserMentions: mocks.resolveUserMentions }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    idea: { findFirst: mocks.entityFindFirst },
    task: { findFirst: mocks.entityFindFirst },
    proposal: { findFirst: mocks.entityFindFirst },
    document: { findFirst: mocks.entityFindFirst },
    project: { findFirst: mocks.projectFindFirst },
    projectMember: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/services/project-group-implicit-admin.service", () => ({
  implicitProjectAdmin: vi.fn().mockResolvedValue(null),
}));

import { POST } from "../route";

const companyUuid = "11111111-1111-4111-8111-111111111111";
const entityUuid = "22222222-2222-4222-8222-222222222222";
const projectUuid = "33333333-3333-4333-8333-333333333333";
const userUuid = "44444444-4444-4444-8444-444444444444";
const body = { userUuids: [userUuid], entityType: "task", entityUuid };

function request(payload: unknown) {
  return new NextRequest("http://localhost/api/mentionables/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/mentionables/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthContext.mockImplementation(async () => ({ type: "user", companyUuid, actorUuid: userUuid }));
    mocks.entityFindFirst.mockResolvedValue({ projectUuid });
    mocks.projectFindFirst.mockResolvedValue({ uuid: projectUuid, companyUuid, visibility: "public", groupUuid: null });
    mocks.memberFindUnique.mockResolvedValue(null);
    mocks.resolveUserMentions.mockResolvedValue([{ uuid: userUuid, name: "Current Name" }]);
  });

  it.each(["idea", "task", "proposal", "document"])("resolves names for an accessible %s without caching", async (entityType) => {
    const response = await POST(request({ ...body, entityType }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { users: [{ uuid: userUuid, name: "Current Name" }] } });
    expect(mocks.resolveUserMentions).toHaveBeenCalledWith({ ...body, entityType, companyUuid });
    expect(mocks.entityFindFirst).toHaveBeenCalledWith({ where: { uuid: entityUuid, companyUuid }, select: { projectUuid: true } });
  });

  it("returns 401 before validating unauthenticated requests", async () => {
    mocks.getAuthContext.mockResolvedValue(null);
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.resolveUserMentions).not.toHaveBeenCalled();
    expect(mocks.entityFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { userUuids: [userUuid] },
    { ...body, userUuids: undefined },
    { ...body, userUuids: userUuid },
    { ...body, userUuids: [123] },
    { ...body, userUuids: ["not-a-uuid"] },
    { ...body, userUuids: [userUuid, userUuid] },
    { ...body, entityType: "agent" },
    { ...body, entityUuid: "not-a-uuid" },
    { ...body, entityUuid: null },
    { ...body, companyUuid: "injected-company" },
    { ...body, unknown: true },
    { ...body, userUuids: Array(101).fill(userUuid) },
    { ...body, userUuids: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) },
  ])("rejects invalid or oversized raw payloads: %j", async (payload) => {
    const response = await POST(request(payload));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.resolveUserMentions).not.toHaveBeenCalled();
    expect(mocks.entityFindFirst).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(new NextRequest("http://localhost/api/mentionables/resolve", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.resolveUserMentions).not.toHaveBeenCalled();
  });

  it.each([0, 100])("accepts a batch of %i UUIDs", async (count) => {
    const userUuids = Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect((await POST(request({ ...body, userUuids }))).status).toBe(200);
    expect(mocks.resolveUserMentions).toHaveBeenCalledWith({ ...body, userUuids, companyUuid });
  });

  it("returns 404 for an entity absent from the authenticated tenant", async () => {
    mocks.entityFindFirst.mockResolvedValue(null);
    const response = await POST(request(body));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.resolveUserMentions).not.toHaveBeenCalled();
  });

  it("hides private entities from nonmembers even with an empty batch", async () => {
    mocks.projectFindFirst.mockResolvedValue({ uuid: projectUuid, companyUuid, visibility: "private", groupUuid: null });
    const response = await POST(request({ ...body, userUuids: [] }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.resolveUserMentions).not.toHaveBeenCalled();
  });

  it("allows a private-project viewer to resolve in that entity's scope", async () => {
    mocks.projectFindFirst.mockResolvedValue({ uuid: projectUuid, companyUuid, visibility: "private", groupUuid: null });
    mocks.memberFindUnique.mockResolvedValue({ role: "viewer" });
    expect((await POST(request(body))).status).toBe(200);
    expect(mocks.resolveUserMentions).toHaveBeenCalledWith({ ...body, companyUuid });
  });

  it("returns uncached failures rather than partially resolving a failed batch", async () => {
    mocks.resolveUserMentions.mockRejectedValue(new Error("Database unavailable"));
    const response = await POST(request(body));
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).success).toBe(false);
  });
});
