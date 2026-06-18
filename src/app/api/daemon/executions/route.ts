// src/app/api/daemon/executions/route.ts
// Daemon aggregate executions read — the caller's full active (running/queued)
// execution set across ALL of their visible connections in one response.
//
// GET — the sidebar presence surface reads this once on mount (and on reconnect)
// for first-paint state, so it renders correctly without issuing one
// per-connection `execution-state` request per online daemon.
//
// Auth mirrors the per-connection `execution-state` read and the agent-connections
// precedent exactly: any valid auth context (notably an agent API key) is accepted,
// there is NO MCP tool and NO new permission bit, and the readable set is scoped to
// the caller's own connections by the service query itself — a USER caller sees only
// executions of agents they own (`agent.ownerUuid`), an AGENT-KEY caller sees only
// its own, every query companyUuid-scoped. The scoping is NOT re-implemented here;
// it lives in `getVisibleExecutions`.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getVisibleExecutions } from "@/services/daemon-execution.service";

// GET /api/daemon/executions — aggregate read of the caller's currently active
// (running/queued/interrupted) execution set across all visible connections,
// owner/self scoped and companyUuid-scoped. Reuses the existing ExecutionView
// projection so the client shares one type with the per-connection and SSE paths.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const executions = await getVisibleExecutions(auth);
  return success({ executions });
});
