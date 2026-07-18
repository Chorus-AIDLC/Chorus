// src/app/api/project-visits/route.ts
// Project quick-access REST surface — user-authenticated (human-only).
// GET returns the sidebar quick-access aggregate for the signed-in user.
// UUID-Based Architecture: scoped by companyUuid + actorUuid.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { getSidebarQuickAccess } from "@/services/project-visit.service";

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
