// src/app/api/entities/[type]/[uuid]/root-idea/route.ts
// Resolve any entity (task/document/proposal/idea) to its root idea in one call.
// Standalone REST endpoint callable with any valid auth (notably an agent API
// key) — no fine-grained permission gate. The CLI daemon calls this once per
// inbound notification to anchor its local Claude session on the root idea.
//
// Tenant isolation (auth.companyUuid scoping) still applies — that's not a
// permission, it's multi-tenancy safety, enforced inside the service's getters.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  resolveRootIdea,
  type LineageEntityType,
} from "@/services/lineage.service";

type RouteContext = { params: Promise<{ type: string; uuid: string }> };

const ENTITY_TYPES: readonly LineageEntityType[] = ["task", "document", "proposal", "idea"];

function isEntityType(value: string): value is LineageEntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

// GET /api/entities/[type]/[uuid]/root-idea
export const GET = withErrorHandler<{ type: string; uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    // Intentionally no checkAgentPermission gate — any authenticated caller
    // (agent key included) may resolve lineage. Resolution is read-only and
    // scoped to auth.companyUuid inside the service.

    const { type, uuid } = await context.params;
    if (!isEntityType(type)) {
      return errors.badRequest(
        `Invalid entity type "${type}". Expected one of: ${ENTITY_TYPES.join(", ")}.`
      );
    }

    const result = await resolveRootIdea(auth.companyUuid, type, uuid);
    // A null rootIdeaUuid is a successful "no idea ancestor" result, not an error.
    // `result` is passed through verbatim, so `directIdeaUuid` (the daemon's session-id
    // anchor — the first idea node on `lineage`) is part of the response contract too.
    return success(result);
  }
);
