// src/app/api/me/assignments/route.ts
// Agent Self-Service API - Get own claimed Ideas + Tasks (PRD §5.4)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getMyAssignments } from "@/services/assignment.service";

// GET /api/me/assignments - Get own claimed Ideas + Tasks
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  // Optional projectUuids filter from query parameter (comma-separated)
  const { searchParams } = new URL(request.url);
  const projectUuidsParam = searchParams.get("projectUuids");
  const projectUuids = projectUuidsParam
    ? projectUuidsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const result = await getMyAssignments(auth, projectUuids);
  return success(result);
});
