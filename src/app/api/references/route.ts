// src/app/api/references/route.ts
// Reference Artifacts API — collection (list + create)
// UUID-Based Architecture: All operations use UUIDs.
//
// Reuses the `document` permission resource (no new permission bit): reads are
// gated by document:read, mutations by document:write — matching the reference
// artifacts Tech Design (V1). Both humans and permitted agents may create.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody, parseQuery } from "@/lib/api-handler";
import { success, error, errors, ErrorCode } from "@/lib/api-response";
import { getAuthContext, isUser, checkAgentPermission } from "@/lib/auth";
import * as referenceArtifactService from "@/services/reference-artifact.service";
import { REFERENCE_TARGET_TYPES } from "@/services/reference-artifact.service";

const validTargetTypes = REFERENCE_TARGET_TYPES as readonly string[];

// GET /api/references?targetType=&targetUuid= — list references for a target
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  const denied = checkAgentPermission(auth, "document:read");
  if (denied) return denied;

  const query = parseQuery(request);

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

  const references = await referenceArtifactService.listReferences({
    companyUuid: auth.companyUuid,
    targetType: query.targetType,
    targetUuid: query.targetUuid,
  });

  return success({ references });
});

// POST /api/references — create a reference artifact linked to an idea/proposal/task
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }
  const denied = checkAgentPermission(auth, "document:write");
  if (denied) return denied;

  const body = await parseBody<{
    targetType: string;
    targetUuid: string;
    type: string;
    url: string;
    title: string;
    notes?: string | null;
  }>(request);

  if (!body.targetType || !validTargetTypes.includes(body.targetType)) {
    return errors.validationError({
      targetType: "Invalid target type",
    });
  }
  if (!body.targetUuid) {
    return errors.validationError({ targetUuid: "Target UUID is required" });
  }
  if (!body.type) {
    return errors.validationError({ type: "Type is required" });
  }
  if (!body.url || body.url.trim() === "") {
    return errors.validationError({ url: "URL is required" });
  }
  if (!body.title || body.title.trim() === "") {
    return errors.validationError({ title: "Title is required" });
  }

  try {
    const reference = await referenceArtifactService.createReference({
      companyUuid: auth.companyUuid,
      targetType: body.targetType,
      targetUuid: body.targetUuid,
      type: body.type,
      url: body.url,
      title: body.title,
      notes: body.notes ?? null,
      createdByType: isUser(auth) ? "user" : "agent",
      createdByUuid: auth.actorUuid,
    });

    return success(reference);
  } catch (err) {
    // The service throws a full sentence ending in "not found" (e.g. "Target
    // proposal with UUID X not found"); emit it verbatim as a 404 rather than
    // errors.notFound(), which would append a second " not found".
    if (err instanceof Error && err.message.includes("not found")) {
      return error(ErrorCode.NOT_FOUND, err.message);
    }
    // Invalid type / url / unsupported targetType are client errors, not 500s.
    if (err instanceof Error && /^(Invalid reference|Unsupported reference)/.test(err.message)) {
      return errors.badRequest(err.message);
    }
    throw err;
  }
});
