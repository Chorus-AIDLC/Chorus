// src/app/api/daemon/pending-turns/route.ts
// Daemon reconnect-backfill read of UNSTARTED turns (子1 — daemon-session-conversation).
//
// GET — after the daemon's SSE stream reconnects, it re-derives the turns that arrived
// during the gap from the TURN TABLE (the canonical source), NOT from notifications —
// so a lost delivery ping never loses an instruction. This returns every `pending`
// (unstarted) turn of the sessions whose origin is the daemon's own connection, for the
// authenticated agent within its company.
//
// Auth mirrors the execution-state GET precedent: any valid auth context (notably an
// agent API key) is accepted, there is NO MCP tool and NO new permission bit, and the
// readable set is scoped to the caller's OWN sessions by the service. The connectionUuid
// must belong to the authenticated agent; a connection the agent does not own (or that
// does not exist) yields 404 — never a 403 that would confirm another agent's connection
// exists.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { connectionBelongsToAgent } from "@/services/daemon-execution.service";
import { getPendingTurnsForConnection } from "@/services/daemon-session.service";

// GET /api/daemon/pending-turns?connectionUuid=… — list this connection's origin-pinned
// sessions' unstarted (pending) turns.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const connectionUuid = request.nextUrl.searchParams.get("connectionUuid");
  if (!connectionUuid) {
    return errors.badRequest("connectionUuid is required");
  }

  // Ownership fence (self-scope): the connection must belong to the authenticated
  // agent within its company. A connection owned by another agent (or non-existent) is
  // 404 — never 403 — so it is indistinguishable from a non-existent one. The service
  // additionally fences the session query on this agent + this origin connection.
  const owns = await connectionBelongsToAgent(auth.companyUuid, auth.actorUuid, connectionUuid);
  if (!owns) {
    return errors.notFound("Connection");
  }

  const turns = await getPendingTurnsForConnection({
    companyUuid: auth.companyUuid,
    agentUuid: auth.actorUuid,
    connectionUuid,
  });

  return success({ turns });
});
