// src/app/api/mentionables/route.ts
// Mentionables API — Search for users/agents that can be @mentioned

import { NextRequest } from "next/server";
import { withErrorHandler, parseQuery } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isAgent } from "@/lib/auth";
import * as mentionService from "@/services/mention.service";

// GET /api/mentionables?q=keyword&limit=10&forMembers=1
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const query = parseQuery(request);
  const q = query.q || "";
  const limit = Math.min(50, Math.max(1, parseInt(query.limit || "10", 10)));
  // forMembers=1 powers the member-add picker, which also lists recent company
  // users on an empty query. Absent/unset preserves the default @mention
  // behavior (agents only on empty query).
  const forMembers = query.forMembers === "1" || query.forMembers === "true";

  const results = await mentionService.searchMentionables({
    companyUuid: auth.companyUuid,
    query: q.trim(),
    actorType: auth.type,
    actorUuid: auth.actorUuid,
    ownerUuid: isAgent(auth) ? auth.ownerUuid : auth.actorUuid,
    limit,
    includeUsersOnEmpty: forMembers,
  });

  return success(results);
});
