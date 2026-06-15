// src/app/api/agent-connections/route.ts
// Agent Connections API - List the daemon connections visible to the caller.
//
// Visibility is enforced by the query scope itself, not by a permission bit:
//   - user / super_admin → connections of every agent they own (listConnectionsForOwner)
//   - agent (API key)     → only the agent's own connections (listConnectionsForAgent)
// This mirrors the root-idea-resolution endpoint precedent: no MCP tool, no new
// permission bit, but auth is still required (401 without it).

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  listConnectionsForOwner,
  listConnectionsForAgent,
} from "@/services/daemon-connection.service";

// GET /api/agent-connections - List daemon connections visible to the caller
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const connections =
    auth.type === "agent"
      ? await listConnectionsForAgent(auth.companyUuid, auth.actorUuid)
      : await listConnectionsForOwner(auth.companyUuid, auth.actorUuid);

  return success({ connections });
});
