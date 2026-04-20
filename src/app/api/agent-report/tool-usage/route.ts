// src/app/api/agent-report/tool-usage/route.ts
// Agent-only endpoint: batch upload Layer-2 (CC client-side) ToolUsageEvent rows.
// Auth: Bearer API Key only (auth.type === "agent"). Rejects user/admin.

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isAgent } from "@/lib/auth";
import {
  batchInsertClientToolEvents,
  type ClientToolEventInput,
} from "@/services/observability.service";

interface Body {
  sessionUuid?: string;
  events?: ClientToolEventInput[];
}

// Cap a single batch to avoid runaway payloads.
const MAX_EVENTS_PER_BATCH = 500;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isAgent(auth)) {
    return errors.forbidden("Agent authentication required");
  }

  const body = await parseBody<Body>(request);
  const sessionUuid = typeof body.sessionUuid === "string" ? body.sessionUuid : null;
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return errors.badRequest("events must be an array");
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return errors.badRequest(
      `events exceed per-batch limit of ${MAX_EVENTS_PER_BATCH}`
    );
  }

  // Minimal validation on each event: must have a tool name.
  for (const e of events) {
    if (!e || typeof e.tool !== "string" || e.tool.length === 0) {
      return errors.badRequest("each event must have a 'tool' string");
    }
  }

  const result = await batchInsertClientToolEvents(
    auth.companyUuid,
    auth.actorUuid,
    sessionUuid,
    events
  );
  return success(result);
});
