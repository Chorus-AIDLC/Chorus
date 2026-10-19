import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  resolveEntityProjectUuid: vi.fn(),
  privateProjectMemberUuids: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: mocks.findMany } } }));
vi.mock("@/services/project-access.service", () => ({
  resolveEntityProjectUuid: mocks.resolveEntityProjectUuid,
  privateProjectMemberUuids: mocks.privateProjectMemberUuids,
}));
vi.mock("@/lib/uuid-resolver", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/daemon-connection.service", () => ({}));
vi.mock("@/services/daemon-execution.service", () => ({}));
vi.mock("@/services/project-agent-cwd.service", () => ({}));

import { resolveUserMentions } from "@/services/mention.service";

const companyUuid = "11111111-1111-4111-8111-111111111111";
const entityUuid = "22222222-2222-4222-8222-222222222222";
const projectUuid = "33333333-3333-4333-8333-333333333333";
const userUuid = "44444444-4444-4444-8444-444444444444";
const otherUuid = "55555555-5555-4555-8555-555555555555";
const context = { companyUuid, entityUuid, entityType: "task" as const };

describe("resolveUserMentions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveEntityProjectUuid.mockResolvedValue(projectUuid);
    mocks.privateProjectMemberUuids.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([]);
  });

  it("queries only requested active, nondeleted users in the authenticated tenant", async () => {
    const pool = [
      { uuid: userUuid, companyUuid, name: "Current", email: "current@example.com", status: "active", deletedAt: null },
      { uuid: otherUuid, companyUuid: "other-company", name: "Foreign", email: "foreign@example.com", status: "active", deletedAt: null },
      { uuid: "inactive", companyUuid, name: "Inactive", email: "inactive@example.com", status: "inactive", deletedAt: null },
      { uuid: "deleted", companyUuid, name: "Deleted", email: "deleted@example.com", status: "active", deletedAt: new Date() },
      { uuid: "unrequested", companyUuid, name: "Unrequested", email: "unrequested@example.com", status: "active", deletedAt: null },
    ];
    mocks.findMany.mockImplementation(async ({ where }) => pool.filter((user) =>
      user.companyUuid === where.companyUuid && user.status === where.status &&
      user.deletedAt === where.deletedAt && where.uuid.in.includes(user.uuid),
    ));

    expect(await resolveUserMentions({ ...context, userUuids: [userUuid, otherUuid, "inactive", "deleted", "missing"] }))
      .toEqual([{ uuid: userUuid, name: "Current" }]);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { companyUuid, uuid: { in: [userUuid, otherUuid, "inactive", "deleted", "missing"] }, status: "active", deletedAt: null },
      select: { uuid: true, name: true, email: true },
    });
    expect(mocks.resolveEntityProjectUuid).toHaveBeenCalledWith(companyUuid, "task", entityUuid);
  });

  it.each([null, "", " \t\n "])("falls back to email for a blank name (%j)", async (name) => {
    mocks.findMany.mockResolvedValue([{ uuid: userUuid, name, email: "fallback@example.com" }]);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid] }))
      .toEqual([{ uuid: userUuid, name: "fallback@example.com" }]);
  });

  it("resolves the current name on every read without caching or returning email fields", async () => {
    mocks.findMany.mockResolvedValueOnce([{ uuid: userUuid, name: "First", email: "first@example.com" }])
      .mockResolvedValueOnce([{ uuid: userUuid, name: "  Renamed  ", email: "first@example.com" }]);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid] })).toEqual([{ uuid: userUuid, name: "First" }]);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid] })).toEqual([{ uuid: userUuid, name: "Renamed" }]);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it("omits users with neither a nonblank name nor email", async () => {
    mocks.findMany.mockResolvedValue([
      { uuid: userUuid, name: null, email: null },
      { uuid: otherUuid, name: " ", email: " " },
    ]);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid, otherUuid] })).toEqual([]);
  });

  it("intersects requested UUIDs with private project members before querying", async () => {
    mocks.privateProjectMemberUuids.mockResolvedValue([userUuid, "unrequested-member"]);
    await resolveUserMentions({ ...context, userUuids: [otherUuid, userUuid] });
    expect(mocks.privateProjectMemberUuids).toHaveBeenCalledWith(companyUuid, projectUuid);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ uuid: { in: [userUuid] } }),
    }));
  });

  it.each([{ members: [] }, { members: [otherUuid] }])("omits users outside private membership $members", async ({ members }) => {
    mocks.privateProjectMemberUuids.mockResolvedValue(members);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid] })).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("fails closed when the entity can no longer be resolved", async () => {
    mocks.resolveEntityProjectUuid.mockResolvedValue(null);
    expect(await resolveUserMentions({ ...context, userUuids: [userUuid] })).toEqual([]);
    expect(mocks.privateProjectMemberUuids).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("does not query for an empty batch", async () => {
    expect(await resolveUserMentions({ ...context, userUuids: [] })).toEqual([]);
    expect(mocks.resolveEntityProjectUuid).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("resolves 100 unique UUIDs in one query rather than per mention", async () => {
    const userUuids = Array.from({ length: 100 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    mocks.findMany.mockResolvedValue(userUuids.map((uuid) => ({ uuid, name: uuid, email: "user@example.com" })));
    const results = await resolveUserMentions({ ...context, userUuids });
    expect(results).toHaveLength(100);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ uuid: { in: userUuids } }),
    }));
  });

  it("deduplicates UUIDs for internal callers", async () => {
    await resolveUserMentions({ ...context, userUuids: [userUuid, userUuid] });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ uuid: { in: [userUuid] } }),
    }));
  });
});
