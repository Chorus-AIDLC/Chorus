// src/app/api/mentionables/route.ts
// Mentionables API — Search for users/agents that can be @mentioned

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isAgent } from "@/lib/auth";
import * as mentionService from "@/services/mention.service";
import type { LineageEntityType } from "@/services/lineage.service";

// The entity kinds the mention search accepts as comment context (pin-cwd-before-wake,
// Part 2a). Any other value is ignored (treated as "no entity context").
const VALID_ENTITY_TYPES: readonly LineageEntityType[] = ["idea", "task", "proposal", "document"];

// GET /api/mentionables?q=keyword&limit=10&entityType=task&entityUuid=<uuid>
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const query = parseQuery(request);
  const q = query.q || "";
  const limit = Math.min(50, Math.max(1, parseInt(query.limit || "10", 10)));
  // Opt-in: the @mention flow requests per-instance (host, cwd) candidates so it
  // can surface the secondary instance picker (cwd-addressable instances, T3).
  // Default off so existing callers (and the cheap suggestion list) are unchanged.
  const withInstances = query.withInstances === "1" || query.withInstances === "true";

  // Optional comment entity context (pin-cwd-before-wake, Part 2a): the comment's
  // target entity, so the search can resolve the comment's root idea and annotate
  // each agent candidate with `isRootIdeaAssignee` + the idea's pin. Only accepted
  // when BOTH parts are present and `entityType` is a recognized kind — otherwise
  // omitted (the service treats a missing part as "no context" → unchanged search).
  const entityType = VALID_ENTITY_TYPES.includes(query.entityType as LineageEntityType)
    ? (query.entityType as LineageEntityType)
    : undefined;
  const entityUuid = query.entityUuid || undefined;

  const results = await mentionService.searchMentionables({
    companyUuid: auth.companyUuid,
    query: q.trim(),
    actorType: auth.type,
    actorUuid: auth.actorUuid,
    ownerUuid: isAgent(auth) ? auth.ownerUuid : auth.actorUuid,
    limit,
    withInstances,
    entityType,
    entityUuid,
  });

  return success(results);
});
