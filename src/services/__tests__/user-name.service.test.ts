import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { user: { updateManyAndReturn: update } } }));
import { updateUserName } from "../user-name.service";

const auth = { type: "user" as const, actorUuid: "self", companyUuid: "tenant" };
beforeEach(() => vi.resetAllMocks());

describe("self display name writes", () => {
  it("atomically scopes to an active tenant user and changes only trimmed name and marker", async () => {
    update.mockResolvedValue([{ uuid: "self", name: "New  Name" }]);
    await expect(updateUserName(auth, "  New  Name  ")).resolves.toEqual({ uuid: "self", name: "New  Name" });
    expect(update).toHaveBeenCalledWith({
      where: { uuid: "self", companyUuid: "tenant", status: "active", deletedAt: null },
      data: { name: "New  Name", nameCustomized: true },
      select: { uuid: true, name: true },
    });
  });

  it.each(["", " ", "😀".repeat(33), "\uD800", "\u0000"])("revalidates before writing %j", async name => {
    await expect(updateUserName(auth, name)).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { uuid: "other", companyUuid: "tenant", status: "active", deletedAt: null },
    { uuid: "self", companyUuid: "other", status: "active", deletedAt: null },
    { uuid: "self", companyUuid: "tenant", status: "disabled", deletedAt: null },
    { uuid: "self", companyUuid: "tenant", status: "invited", deletedAt: null },
    { uuid: "self", companyUuid: "tenant", status: "active", deletedAt: new Date() },
    null,
  ])("does not update ineligible target %j", async row => {
    update.mockImplementation(async ({ where }) => row && Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value) ? [row] : []);
    await expect(updateUserName(auth, "New Name")).rejects.toMatchObject({ status: 404 });
  });

  it("allows repeated saves and nonunique names", async () => {
    update.mockResolvedValue([{ uuid: "self", name: "Shared Name" }]);
    await updateUserName(auth, "Shared Name");
    await updateUserName(auth, "Shared Name");
    expect(update).toHaveBeenCalledTimes(2);
  });
});
