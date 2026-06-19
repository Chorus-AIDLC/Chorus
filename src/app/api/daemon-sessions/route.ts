// src/app/api/daemon-sessions/route.ts
// Owner-scoped daemon session targeting list (子2 — send side).
//
// GET — the caller's owner-scoped, company-fenced daemon sessions (via 子1's
// `getVisibleSessions`), each enriched with a derived `originOnline` flag so the send UI
// renders an enabled/disabled send box per session without a second call. Returns NO
// turn/transcript bodies — transcript rendering is the separate 子3 capability.
//
// Auth posture mirrors /api/agent-connections and the daemon read routes: any valid auth
// context (agent API key → its own sessions; user/super_admin → sessions of agents they
// own), no MCP tool, no new permission bit. Visibility is enforced by the service's
// owner/self scope, never cross-owner or cross-company.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getVisibleSessionsWithOrigin } from "@/services/daemon-instruction.service";

// GET /api/daemon-sessions — list the caller's daemon sessions with originOnline.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const sessions = await getVisibleSessionsWithOrigin(auth);
  return success({ sessions });
});
