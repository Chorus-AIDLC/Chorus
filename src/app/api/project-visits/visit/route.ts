// src/app/api/project-visits/visit/route.ts
// Record a project visit for the signed-in user — user-authenticated (human-only).
// Fire-and-forget from the client; returns a minimal ack (no aggregate).
// UUID-Based Architecture: scoped by companyUuid + actorUuid.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { recordVisit } from "@/services/project-visit.service";

// POST /api/project-visits/visit — record a visit ({ ok: true })
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  if (!isUser(auth)) {
    return errors.forbidden("This operation requires user authentication");
  }

  const body = await parseBody<{ projectUuid?: string }>(request);
  if (!body.projectUuid || body.projectUuid.trim() === "") {
    return errors.validationError({ projectUuid: "projectUuid is required" });
  }

  await recordVisit(auth.companyUuid, auth.actorUuid, body.projectUuid);
  return success({ ok: true });
});
