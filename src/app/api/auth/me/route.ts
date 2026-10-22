import { NextRequest } from "next/server";
import { success, errors } from "@/lib/api-response";
import { prisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api-handler";

// Only verified cookies/Bearer tokens may select a tenant-bound user.
const handler = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth || auth.type !== "user") return errors.unauthorized();
  const user = await prisma.user.findFirst({
    where: { uuid: auth.actorUuid, companyUuid: auth.companyUuid },
    select: { uuid: true, email: true, name: true, avatarSeed: true, authType: true, workspaceAdmin: true,
      company: { select: { uuid: true, name: true, localAuthEnabled: true } } },
  });
  if (!user) return errors.unauthorized();
  return success({ user: { uuid: user.uuid, email: user.email, name: user.name,
    avatarSeed: user.avatarSeed,
    authType: user.authType, workspaceAdmin: user.authType === "local" && user.workspaceAdmin }, company: user.company });
});

export async function GET(request: NextRequest) {
  return handler(request, { params: Promise.resolve({}) });
}
