// src/app/api/project-visits/route.ts
// Project quick-access REST surface — user-authenticated (human-only).
// GET returns the sidebar quick-access aggregate for the signed-in user.
// DELETE forgets a project's visit ("remove from recent") and returns the fresh
// aggregate so the client updates in one round-trip (mirrors the /pin route).
// UUID-Based Architecture: scoped by companyUuid + actorUuid.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import {
  getSidebarQuickAccess,
  forgetVisit,
} from "@/services/project-visit.service";

// GET /api/project-visits — sidebar quick-access aggregate ({ pinned, recent })
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  // Human-only surface: agents (and any non-user) never render the sidebar.
  if (!isUser(auth)) {
    return errors.forbidden("This operation requires user authentication");
  }

  const aggregate = await getSidebarQuickAccess(auth.companyUuid, auth.actorUuid);
  return success(aggregate);
});

// DELETE /api/project-visits — forget a project's visit ("remove from recent"),
// return the fresh { pinned, recent } aggregate. Soft-remove: the visit row is
// deleted only when the project is NOT pinned (guarded in the service), so the
// project simply drops out of recent and returns on the next visit.
export const DELETE = withErrorHandler(async (request: NextRequest) => {
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

  await forgetVisit(auth.companyUuid, auth.actorUuid, body.projectUuid);
  const aggregate = await getSidebarQuickAccess(auth.companyUuid, auth.actorUuid);
  return success(aggregate);
});
