// src/app/api/projects/[uuid]/observability/entity/route.ts
// User-facing endpoint: per-entity token/tool aggregation.

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getProject } from "@/services/project.service";
import {
  getEntityTokens,
  getProposalTokens,
  type EntityType,
} from "@/services/observability.service";

type RouteContext = { params: Promise<{ uuid: string }> };

const VALID_ENTITY_TYPES: EntityType[] = ["task", "idea", "proposal", "document"];

export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) return errors.unauthorized();

    const { uuid: projectUuid } = await context.params;
    const project = await getProject(auth.companyUuid, projectUuid);
    if (!project) return errors.notFound("Project");

    const q = parseQuery(request);
    const entityType = q.entityType as EntityType | undefined;
    const entityUuid = q.entityUuid;
    if (!entityType || !VALID_ENTITY_TYPES.includes(entityType)) {
      return errors.badRequest(
        `entityType must be one of: ${VALID_ENTITY_TYPES.join(", ")}`
      );
    }
    if (!entityUuid) return errors.badRequest("entityUuid is required");

    const data = await getEntityTokens(auth.companyUuid, entityType, entityUuid);

    // Enrich proposals with drafting/review split.
    if (entityType === "proposal") {
      const proposal = await getProposalTokens(auth.companyUuid, entityUuid);
      return success({ ...data, proposal });
    }
    return success(data);
  }
);
