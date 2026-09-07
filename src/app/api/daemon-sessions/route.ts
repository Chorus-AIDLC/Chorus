// src/app/api/daemon-sessions/route.ts
// Owner-scoped daemon session targeting list (子2 — send side).
//
// GET — the caller's owner-scoped, company-fenced daemon sessions (via 子1's
// `getVisibleSessions`), each enriched with a derived `originOnline` flag so the send UI
// renders an enabled/disabled send box per session without a second call. Returns NO
// turn/transcript bodies — transcript rendering is the separate 子3 capability.
//
// Three modes, selected by query params (paginate-daemon-session-list) — pagination is
// OPT-IN and backward-compatible; the no-param response is unchanged:
//   - `?view=agents`               → { agents } : the agent index (cheap grouped aggregate,
//                                     no enrichment/reconcile) for the chat modal's Select.
//   - `?agentUuid=&limit=&before=` → { sessions, nextCursor, hasMore } : one keyset page of
//                                     that agent's conversations, enriched over the page only.
//   - (no params)                  → { sessions } : the full enriched list (LEGACY, unchanged) —
//                                     used by the connections view + the send box targeting.
//
// Auth posture mirrors /api/agent-connections and the daemon read routes: any valid auth
// context (agent API key → its own sessions; user/super_admin → sessions of agents they
// own), no MCP tool, no new permission bit. Visibility is enforced by the service's
// owner/self scope, never cross-owner or cross-company.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getVisibleAgentIndex } from "@/services/daemon-session.service";
import {
  getVisibleSessionsWithOrigin,
  getVisibleSessionsPageWithOrigin,
} from "@/services/daemon-instruction.service";

// GET /api/daemon-sessions — list the caller's daemon sessions with originOnline.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const { searchParams } = new URL(request.url);

  // Agent-index mode — the left-pane Select + default-agent selection, no rows.
  if (searchParams.get("view") === "agents") {
    const agents = await getVisibleAgentIndex(auth);
    return success({ agents });
  }

  // Per-agent page mode — one keyset page of a single agent's conversations. Invalid
  // `limit` / `before` are clamped/ignored by the service, never an error.
  const agentUuid = searchParams.get("agentUuid");
  if (agentUuid) {
    const limitParam = searchParams.get("limit");
    const limit = limitParam !== null ? Number(limitParam) : undefined;
    const before = searchParams.get("before");
    const page = await getVisibleSessionsPageWithOrigin(auth, agentUuid, {
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      before: before || null,
    });
    return success(page);
  }

  // Legacy full-list mode — unchanged shape for the connections view + send box.
  const sessions = await getVisibleSessionsWithOrigin(auth);
  return success({ sessions });
});
