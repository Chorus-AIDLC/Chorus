// src/app/api/search/route.ts
// Global Search API - Unified search across all entity types
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { search, type EntityType, type SearchScope } from "@/services/search.service";

// GET /api/search - Search across entities
export const GET = withErrorHandler(
  async (request: NextRequest) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Parse query parameters
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const scope = (url.searchParams.get("scope") || "global") as SearchScope;
    const scopeUuid = url.searchParams.get("scopeUuid") || undefined;
    const typesParam = url.searchParams.get("types");
    const limitParam = url.searchParams.get("limit");

    // Validate required parameter: q
    if (!q || q.trim() === "") {
      return errors.badRequest("Query parameter 'q' is required and cannot be empty");
    }

    // Validate scope
    const validScopes: SearchScope[] = ["global", "group", "project"];
    if (!validScopes.includes(scope)) {
      return errors.badRequest(`Invalid scope. Must be one of: ${validScopes.join(", ")}`);
    }

    // Validate scopeUuid requirement
    if ((scope === "group" || scope === "project") && !scopeUuid) {
      return errors.badRequest(`Parameter 'scopeUuid' is required when scope is '${scope}'`);
    }

    // Parse types parameter (comma-separated)
    let entityTypes: EntityType[] | undefined;
    if (typesParam) {
      const validTypes: EntityType[] = ["task", "idea", "proposal", "document", "project", "project_group"];
      entityTypes = typesParam
        .split(",")
        .map(t => t.trim())
        .filter(Boolean) as EntityType[];

      // Validate each type
      const invalidTypes = entityTypes.filter(t => !validTypes.includes(t));
      if (invalidTypes.length > 0) {
        return errors.badRequest(
          `Invalid entity types: ${invalidTypes.join(", ")}. Valid types are: ${validTypes.join(", ")}`
        );
      }
    }

    // Parse and validate limit
    let limit = 20; // default
    if (limitParam) {
      const parsedLimit = parseInt(limitParam, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        return errors.badRequest("Parameter 'limit' must be a positive integer");
      }
      limit = Math.min(parsedLimit, 100); // max 100
    }

    // Call search service
    const result = await search({
      query: q.trim(),
      companyUuid: auth.companyUuid,
      scope,
      scopeUuid,
      entityTypes,
      limit,
    });

    return success(result);
  }
);
