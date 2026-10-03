// src/app/api/notifications/[uuid]/archive/route.ts
// Notifications API — Archive a notification

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as notificationService from "@/services/notification.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// PATCH /api/notifications/[uuid]/archive — Archive notification
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid } = await context.params;
    const recipientType = isUser(auth) ? "user" : "agent";
    const recipientUuid = auth.actorUuid;

    try {
      const notification = await notificationService.archive(
        uuid,
        auth.companyUuid,
        recipientType,
        recipientUuid,
        auth
      );

      return success(notification);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return errors.notFound("Notification");
      }
      throw error;
    }
  }
);
