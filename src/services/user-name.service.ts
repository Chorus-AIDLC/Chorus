import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import { displayNameSchema } from "@/lib/display-name";
import type { UserAuthContext } from "@/types/auth";

export async function updateUserName(auth: UserAuthContext, name: string) {
  const input = displayNameSchema.safeParse(name);
  if (!input.success) throw new ApiError("BAD_REQUEST", "Invalid display name", 400);

  const users = await prisma.user.updateManyAndReturn({
    where: {
      uuid: auth.actorUuid,
      companyUuid: auth.companyUuid,
      status: "active",
      deletedAt: null,
    },
    data: { name: input.data, nameCustomized: true },
    select: { uuid: true, name: true },
  });
  if (!users[0]) throw new ApiError("NOT_FOUND", "User not found", 404);
  return users[0];
}
