// src/app/api/project-visits/pin/route.ts
// Pin / unpin a project for the signed-in user — user-authenticated (human-only).
// Both verbs return the FRESH { pinned, recent } aggregate so the client updates
// in one round-trip without a follow-up GET.
// UUID-Based Architecture: scoped by companyUuid + actorUuid.

import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors, type ApiErrorResponse } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import type { UserAuthContext } from "@/types/auth";
import {
  pinProject,
  unpinProject,
  getSidebarQuickAccess,
} from "@/services/project-visit.service";

// Shared preamble: authenticate a user, parse + validate projectUuid.
// Returns either an error response or the resolved { auth, projectUuid }.
async function resolvePinRequest(
  request: NextRequest,
): Promise<
  | { auth: UserAuthContext; projectUuid: string }
  | { error: NextResponse<ApiErrorResponse> }
> {
  const auth = await getAuthContext(request);
  if (!auth) {
    return { error: errors.unauthorized() };
  }
  if (!isUser(auth)) {
    return { error: errors.forbidden("This operation requires user authentication") };
  }

  const body = await parseBody<{ projectUuid?: string }>(request);
  if (!body.projectUuid || body.projectUuid.trim() === "") {
    return { error: errors.validationError({ projectUuid: "projectUuid is required" }) };
  }

  return { auth, projectUuid: body.projectUuid };
}

// PUT /api/project-visits/pin — pin a project, return fresh aggregate
export const PUT = withErrorHandler(async (request: NextRequest) => {
  const resolved = await resolvePinRequest(request);
  if ("error" in resolved) return resolved.error;
  const { auth, projectUuid } = resolved;

  await pinProject(auth.companyUuid, auth.actorUuid, projectUuid);
  const aggregate = await getSidebarQuickAccess(auth.companyUuid, auth.actorUuid);
  return success(aggregate);
});

// DELETE /api/project-visits/pin — unpin a project, return fresh aggregate
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const resolved = await resolvePinRequest(request);
  if ("error" in resolved) return resolved.error;
  const { auth, projectUuid } = resolved;

  await unpinProject(auth.companyUuid, auth.actorUuid, projectUuid);
  const aggregate = await getSidebarQuickAccess(auth.companyUuid, auth.actorUuid);
  return success(aggregate);
});
