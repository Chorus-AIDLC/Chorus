import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { user: { updateManyAndReturn: update } } }));
import { updateUserAvatar } from "../user-avatar.service";

const auth = { type: "user" as const, actorUuid: "self", companyUuid: "tenant" };
const avatarSeed = "639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc";
beforeEach(() => vi.resetAllMocks());

describe("self avatar writes", () => {
  it("atomically scopes to active tenant user and changes only seed", async () => {
    update.mockResolvedValue([{ uuid: "self", avatarSeed }]);
    await expect(updateUserAvatar(auth, avatarSeed)).resolves.toEqual({ uuid: "self", avatarSeed });
    expect(update).toHaveBeenCalledWith({
      where: { uuid: "self", companyUuid: "tenant", status: "active", deletedAt: null },
      data: { avatarSeed }, select: { uuid: true, avatarSeed: true },
    });
    await expect(updateUserAvatar(auth, avatarSeed)).resolves.toEqual({ uuid: "self", avatarSeed });
  });

  it("does not update missing, disabled, deleted or other-tenant identities", async () => {
    update.mockResolvedValue([]);
    await expect(updateUserAvatar(auth, avatarSeed)).rejects.toMatchObject({ status: 404 });
  });
});
