// src/app/api/documents/[uuid]/route.ts
// Documents API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission, checkAgentPermission } from "@/lib/auth";
import {
  getDocument,
  getDocumentByUuid,
  updateDocument,
  deleteDocument,
} from "@/services/document.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/documents/[uuid] - Document Detail
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "document:read");
    if (denied) return denied;

    const { uuid } = await context.params;
    const document = await getDocument(auth.companyUuid, uuid);

    if (!document) {
      return errors.notFound("Document");
    }

    return success(document);
  }
);

// PATCH /api/documents/[uuid] - Update Document
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Updating requires document:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "document:write")) {
        return errors.forbidden("Missing permission: document:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can update documents");
    }

    const { uuid } = await context.params;

    // Get the original Document data
    const document = await getDocumentByUuid(auth.companyUuid, uuid);
    if (!document) {
      return errors.notFound("Document");
    }

    const body = await parseBody<{
      title?: string;
      content?: string;
      incrementVersion?: boolean;
    }>(request);

    // Validate title
    if (body.title !== undefined && body.title.trim() === "") {
      return errors.validationError({ title: "Title cannot be empty" });
    }

    const updated = await updateDocument(document.uuid, {
      title: body.title?.trim(),
      content: body.content !== undefined ? (body.content.trim() || null) : undefined,
      incrementVersion: body.incrementVersion,
    });

    return success(updated);
  }
);

// DELETE /api/documents/[uuid] - Delete Document
export const DELETE = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Deleting requires document:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "document:write")) {
        return errors.forbidden("Missing permission: document:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can delete documents");
    }

    const { uuid } = await context.params;

    const document = await getDocumentByUuid(auth.companyUuid, uuid);
    if (!document) {
      return errors.notFound("Document");
    }

    await deleteDocument(document.uuid);
    return success({ deleted: true });
  }
);
