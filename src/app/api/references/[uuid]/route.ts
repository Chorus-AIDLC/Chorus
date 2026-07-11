// src/app/api/references/[uuid]/route.ts
// Reference Artifacts API — item (detail / update / delete)
// UUID-Based Architecture: All operations use UUIDs.
//
// Reads gate agents by document:read, mutations by document:write (reusing the
// existing `document` permission resource — no new bit). A row that is absent or
// belongs to another company resolves to 404 (errors.notFound("Reference")).

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import * as referenceArtifactService from "@/services/reference-artifact.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/references/[uuid] — reference detail
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "document:read");
    if (denied) return denied;

    const { uuid } = await context.params;
    const reference = await referenceArtifactService.getReference(
      auth.companyUuid,
      uuid
    );

    if (!reference) {
      return errors.notFound("Reference");
    }

    return success(reference);
  }
);

// PATCH /api/references/[uuid] — update reference (type/url/title/notes)
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "document:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    const body = await parseBody<{
      type?: string;
      url?: string;
      title?: string;
      notes?: string | null;
    }>(request);

    try {
      const updated = await referenceArtifactService.updateReference(
        auth.companyUuid,
        uuid,
        {
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        }
      );

      return success(updated);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return errors.notFound("Reference");
      }
      if (error instanceof Error && /^(Invalid reference|Unsupported reference)/.test(error.message)) {
        return errors.badRequest(error.message);
      }
      throw error;
    }
  }
);

// DELETE /api/references/[uuid] — delete reference
export const DELETE = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "document:write");
    if (denied) return denied;

    const { uuid } = await context.params;

    try {
      await referenceArtifactService.deleteReference(auth.companyUuid, uuid);
      return success({ deleted: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return errors.notFound("Reference");
      }
      throw error;
    }
  }
);
