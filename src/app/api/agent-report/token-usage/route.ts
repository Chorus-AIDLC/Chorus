// src/app/api/agent-report/token-usage/route.ts
// Agent-only endpoint: receive transcript turns + tool timeline, attribute and store token usage.
// Supports incremental upload with server-side dedup on (sourceSessionId, turnTimestamp).
// Server resolves projectUuid from entity UUIDs — client doesn't need to provide it.
// Auth: Bearer API Key only (auth.type === "agent").

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isAgent } from "@/lib/auth";
import {
  attributeTokenUsage,
  insertAttributedTokenUsage,
  resolveProjectUuids,
  type TurnUsage,
  type TimelineEntry,
} from "@/services/observability.service";

interface Body {
  sessionUuid?: string;
  sourceSessionId?: string;
  isReviewer?: boolean;
  turns?: TurnUsage[];
  timeline?: TimelineEntry[];
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isAgent(auth)) {
    return errors.forbidden("Agent authentication required");
  }

  const body = await parseBody<Body>(request);
  const turns = Array.isArray(body.turns) ? body.turns : [];
  if (turns.length === 0) {
    return errors.badRequest("turns must be a non-empty array");
  }

  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  const sessionUuid =
    typeof body.sessionUuid === "string" ? body.sessionUuid : null;
  const sourceSessionId =
    typeof body.sourceSessionId === "string" ? body.sourceSessionId : null;
  const isReviewer = body.isReviewer === true;

  const records = attributeTokenUsage(
    turns,
    timeline,
    sessionUuid,
    auth.actorUuid,
    auth.companyUuid,
    sourceSessionId,
    isReviewer
  );

  const projectMap = await resolveProjectUuids(auth.companyUuid, records);

  const result = await insertAttributedTokenUsage(
    records.map((r) => ({
      ...r,
      projectUuid:
        r.entityUuid ? (projectMap.get(r.entityUuid) ?? null) : null,
    }))
  );
  return success(result);
});
