// src/app/api/notifications/read-all/route.ts
// Notifications API — Mark all notifications as read

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as notificationService from "@/services/notification.service";

// POST /api/notifications/read-all — Mark all as read
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const recipientType = isUser(auth) ? "user" : "agent";
  const recipientUuid = auth.actorUuid;

  let projectUuid: string | undefined;

  // Body is optional — try to parse it
  try {
    const body = await parseBody<{ projectUuid?: string }>(request);
    projectUuid = body.projectUuid || undefined;
  } catch {
    // No body or invalid JSON is fine — mark all as read
  }

  const result = await notificationService.markAllRead(
    auth.companyUuid,
    recipientType,
    recipientUuid,
    projectUuid,
    auth
  );

  return success(result);
});
