import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { UserAuthContext } from "@/types/auth";

export async function updateUserAvatar(auth: UserAuthContext, avatarSeed: string) {
  const users = await prisma.user.updateManyAndReturn({
    where: {
      uuid: auth.actorUuid,
      companyUuid: auth.companyUuid,
      status: "active",
      deletedAt: null,
    },
    data: { avatarSeed },
    select: { uuid: true, avatarSeed: true },
  });
  if (!users[0]) throw new ApiError("NOT_FOUND", "User not found", 404);
  return users[0];
}
