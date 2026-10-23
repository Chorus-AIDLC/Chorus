import type { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api-handler";
import { error, errors, success } from "@/lib/api-response";
import { ProjectTeamError } from "@/services/project-agent-team.service";
import { handoffProjectTeam } from "@/services/project-team-handoff.service";
import { requireProjectAccess } from "@/services/project-access.service";

export const POST = withErrorHandler<{ uuid: string }>(async (request: NextRequest, context) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (auth.type !== "user") return errors.forbidden("Only users can hand off project ideas");
  const { uuid } = await context.params;
  await requireProjectAccess(auth, uuid, "editor");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("VALIDATION_ERROR", "Invalid JSON body");
  }
  try {
    return success(await handoffProjectTeam(auth, uuid, body));
  } catch (caught) {
    if (caught instanceof ProjectTeamError) return error(caught.code, caught.message, caught.details);
    throw caught;
  }
});
