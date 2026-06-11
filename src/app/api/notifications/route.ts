// src/app/api/notifications/route.ts
// Notifications API — List notifications for authenticated user/agent

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as notificationService from "@/services/notification.service";

// GET /api/notifications — List notifications
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const query = parseQuery(request);

  const recipientType = isUser(auth) ? "user" : "agent";
  const recipientUuid = auth.actorUuid;

  const limit = Math.min(100, Math.max(1, parseInt(query.limit || "50", 10)));
  const offset = Math.max(0, parseInt(query.offset || "0", 10));

  const readFilter =
    query.unreadOnly === "true"
      ? "unread"
      : (undefined as "all" | "unread" | "read" | undefined);

  const result = await notificationService.list({
    companyUuid: auth.companyUuid,
    recipientType,
    recipientUuid,
    projectUuid: query.projectUuid || undefined,
    readFilter,
    archived: false,
    skip: offset,
    take: limit,
    auth,
  });

  return success({
    notifications: result.notifications,
    unreadCount: result.unreadCount,
  });
});
