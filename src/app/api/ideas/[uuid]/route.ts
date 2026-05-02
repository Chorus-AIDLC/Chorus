// src/app/api/ideas/[uuid]/route.ts
// Ideas API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAssignee, checkAgentPermission } from "@/lib/auth";
import {
  getIdea,
  getIdeaByUuid,
  updateIdea,
  deleteIdea,
  isValidIdeaStatusTransition,
} from "@/services/idea.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/ideas/[uuid] - Idea Detail
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:read");
    if (denied) return denied;

    const { uuid } = await context.params;
    const idea = await getIdea(auth.companyUuid, uuid);

    if (!idea) {
      return errors.notFound("Idea");
    }

    return success(idea);
  }
);

// PATCH /api/ideas/[uuid] - Update Idea
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "idea:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    // Get original Idea data for permission check
    const idea = await getIdeaByUuid(auth.companyUuid, uuid);
    if (!idea) {
      return errors.notFound("Idea");
    }

    const body = await parseBody<{
      title?: string;
      content?: string;
      status?: string;
    }>(request);

    // Build update data
    const updateData: {
      title?: string;
      content?: string | null;
      status?: string;
    } = {};

    // Title validation
    if (body.title !== undefined) {
      if (body.title.trim() === "") {
        return errors.validationError({ title: "Title cannot be empty" });
      }
      updateData.title = body.title.trim();
    }

    // Content update
    if (body.content !== undefined) {
      updateData.content = body.content.trim() || null;
    }

    // Status update
    if (body.status !== undefined) {
      // Check if state transition is valid
      if (!isValidIdeaStatusTransition(idea.status, body.status)) {
        return errors.invalidStatusTransition(idea.status, body.status);
      }

      // Non-users can only update the status of Ideas they have claimed
      if (!isUser(auth)) {
        if (!isAssignee(auth, idea.assigneeType, idea.assigneeUuid)) {
          return errors.permissionDenied("Only assignee can update status");
        }
      }

      updateData.status = body.status;
    }

    const updated = await updateIdea(idea.uuid, auth.companyUuid, updateData);
    return success(updated);
  }
);

// DELETE /api/ideas/[uuid] - Delete Idea
export const DELETE = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Only users can delete Ideas
    if (!isUser(auth)) {
      return errors.forbidden("Only users can delete ideas");
    }

    const { uuid } = await context.params;

    const idea = await getIdeaByUuid(auth.companyUuid, uuid);
    if (!idea) {
      return errors.notFound("Idea");
    }

    await deleteIdea(idea.uuid);
    return success({ deleted: true });
  }
);
