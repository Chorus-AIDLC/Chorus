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
import { requireEntityAccess, ProjectNotFoundError, type AccessEntityType } from "@/services/project-access.service";
import type { AuthContext } from "@/types/auth";

type RouteContext = { params: Promise<{ uuid: string }> };

// Look up the reference (company-scoped) and require `min` on its target's
// project. Returns a 404 response when the reference is missing OR its target
// is hidden from the caller (indistinguishable), null when access is granted.
async function requireReferenceAccess(auth: AuthContext, uuid: string, min: "viewer" | "editor") {
  const reference = await referenceArtifactService.getReference(auth.companyUuid, uuid);
  if (!reference) return { denied: errors.notFound("Reference"), reference: null };
  try {
    await requireEntityAccess(auth, reference.targetType as AccessEntityType, reference.targetUuid, min);
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return { denied: errors.notFound("Reference"), reference: null };
    throw e;
  }
  return { denied: null, reference };
}

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
    const { denied: accessDenied, reference } = await requireReferenceAccess(auth, uuid, "viewer");
    if (accessDenied) return accessDenied;

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
    const { denied: accessDenied } = await requireReferenceAccess(auth, uuid, "editor");
    if (accessDenied) return accessDenied;

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
    const { denied: accessDenied } = await requireReferenceAccess(auth, uuid, "editor");
    if (accessDenied) return accessDenied;

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
