// src/app/api/comments/route.ts
// Comments API (ARCHITECTURE.md §4.2)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parsePagination, parseQuery } from "@/lib/api-handler";
import { success, paginated, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import * as commentService from "@/services/comment.service";
import type { TargetType } from "@/lib/uuid-resolver";

const validTargetTypes = ["idea", "proposal", "task", "document"];

// GET /api/comments?targetType=&targetUuid= - Get Comments
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const query = parseQuery(request);
  const { page, pageSize, skip, take } = parsePagination(request);

  // Validate required parameters
  if (!query.targetType || !query.targetUuid) {
    return errors.validationError({
      targetType: "targetType is required",
      targetUuid: "targetUuid is required",
    });
  }

  if (!validTargetTypes.includes(query.targetType)) {
    return errors.validationError({
      targetType: "Invalid target type",
    });
  }

  const { comments, total } = await commentService.listComments({
    companyUuid: auth.companyUuid,
    targetType: query.targetType as TargetType,
    targetUuid: query.targetUuid,
    skip,
    take,
    auth,
  });

  return paginated(comments, page, pageSize, total);
});

// POST /api/comments - Add Comment
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const body = await parseBody<{
    targetType: string;
    targetUuid: string;
    content: string;
  }>(request);

  // Validate required fields
  if (!body.targetType || !validTargetTypes.includes(body.targetType)) {
    return errors.validationError({
      targetType: "Invalid target type",
    });
  }
  if (!body.targetUuid) {
    return errors.validationError({
      targetUuid: "Target UUID is required",
    });
  }
  if (!body.content || body.content.trim() === "") {
    return errors.validationError({
      content: "Content is required",
    });
  }

  try {
    const comment = await commentService.createComment({
      companyUuid: auth.companyUuid,
      targetType: body.targetType as TargetType,
      targetUuid: body.targetUuid,
      content: body.content.trim(),
      authorType: isUser(auth) ? "user" : "agent",
      authorUuid: auth.actorUuid,
      auth,
    });

    return success(comment);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return errors.notFound(error.message);
    }
    throw error;
  }
});
