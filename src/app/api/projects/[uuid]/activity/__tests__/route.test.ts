import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), access: vi.fn(),
  activity: { findMany: vi.fn(), count: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { activity: mocks.activity, user: mocks.user } }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth, checkAgentPermission: vi.fn(() => null) }));
vi.mock("@/services/project-access.service", () => ({ requireProjectAccess: mocks.access }));

import { GET } from "../route";
import { ApiError } from "@/lib/api-handler";

const request = () => GET(new NextRequest("http://localhost/api/projects/project/activity"), { params: Promise.resolve({ uuid: "project" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ type: "user", actorUuid: "viewer", companyUuid: "company" });
  mocks.access.mockResolvedValue({ uuid: "project" });
  mocks.activity.count.mockResolvedValue(3);
  mocks.activity.findMany.mockResolvedValue(["user", "agent", "user"].map((type, index) => ({
    uuid: `activity-${index}`, actorType: type, actorUuid: index === 2 ? "missing" : "shared",
    targetType: "task", targetUuid: "task", action: "updated", value: null, createdAt: new Date(),
  })));
  mocks.user.findMany.mockResolvedValue([{ uuid: "shared", name: "Human", avatarSeed: "current-seed" }]);
});

describe("project activity identity seeds", () => {
  it("extends only authorized human actors in the existing nested DTO", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].actor).toEqual({ type: "user", uuid: "shared", avatarSeed: "current-seed" });
    expect(body.data[1].actor).toEqual({ type: "agent", uuid: "shared" });
    expect(body.data[2].actor.avatarSeed).toBeNull();
    expect(mocks.user.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid: "company", uuid: { in: ["shared", "missing"] } },
      select: { uuid: true, name: true, email: true, avatarSeed: true },
    });
    expect(mocks.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid: "company", projectUuid: "project" } }));
  });

  it("does not resolve any identities before project access succeeds", async () => {
    mocks.access.mockRejectedValue(new ApiError("NOT_FOUND", "Project not found", 404));
    expect((await request()).status).toBe(404);
    expect(mocks.activity.findMany).not.toHaveBeenCalled();
    expect(mocks.user.findMany).not.toHaveBeenCalled();
  });
});
