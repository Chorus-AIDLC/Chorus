import { NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { errors, success } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { resolveUserMentions } from "@/services/mention.service";
import { requireEntityAccess } from "@/services/project-access.service";

const resolveSchema = z.strictObject({
  userUuids: z.array(z.uuid()).max(100).refine(
    (uuids) => new Set(uuids.map((uuid) => uuid.toLowerCase())).size === uuids.length,
    "User UUIDs must be unique",
  ),
  entityType: z.enum(["idea", "task", "proposal", "document"]),
  entityUuid: z.uuid(),
});

const handler = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();

  const parsed = resolveSchema.safeParse(await parseBody(request));
  if (!parsed.success) return errors.badRequest("Invalid mention resolution request");

  const { userUuids, entityType, entityUuid } = parsed.data;
  await requireEntityAccess(auth, entityType, entityUuid, "viewer");
  const users = await resolveUserMentions({
    companyUuid: auth.companyUuid,
    userUuids: userUuids.map((uuid) => uuid.toLowerCase()),
    entityType,
    entityUuid,
  });
  return success({ users });
});

export async function POST(request: NextRequest) {
  const response = await handler(request, { params: Promise.resolve({}) });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
