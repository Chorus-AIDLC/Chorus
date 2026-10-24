import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { errors, success } from "@/lib/api-response";
import { issueIdeaAssignmentAuthorization } from "@/services/idea-assignment-authorization.service";
import { requireEntityAccess } from "@/services/project-access.service";

const schema = z.object({ agentUuid: z.string().uuid(), requestUuid: z.string().uuid() }).strict();

export const POST = withErrorHandler<{ uuid: string }>(async (request, context) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (auth.type !== "user") return errors.forbidden("Human assignment confirmation required");
  const { uuid } = await context.params;
  const parsed = schema.safeParse(await parseBody(request));
  if (!parsed.success) return errors.validationError(parsed.error.issues);
  await requireEntityAccess(auth, "idea", uuid, "editor");
  const proof = await issueIdeaAssignmentAuthorization(auth, { ideaUuid: uuid, ...parsed.data });
  return success({ uuid: proof.uuid, ideaUuid: proof.ideaUuid, agentUuid: proof.agentUuid, expiresAt: proof.expiresAt });
});
