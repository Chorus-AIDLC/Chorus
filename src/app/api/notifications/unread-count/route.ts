// src/app/api/notifications/unread-count/route.ts
// Notifications API — Get unread notification count

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as notificationService from "@/services/notification.service";

// GET /api/notifications/unread-count — Return unread count
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const recipientType = isUser(auth) ? "user" : "agent";
  const recipientUuid = auth.actorUuid;

  const count = await notificationService.getUnreadCount(
    auth.companyUuid,
    recipientType,
    recipientUuid,
    auth
  );

  return success({ count });
});
