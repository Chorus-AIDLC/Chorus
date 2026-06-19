// src/app/api/daemon/turn-advance/route.ts
// Daemon → server turn lifecycle advance (子1 — daemon-session-conversation).
//
// POST — the daemon advances the lifecycle of the turn it is executing
// (`pending → running → ended`) on ONE of its OWN sessions. It identifies the turn by
// the session BUSINESS KEY (`sessionId` = the directIdeaUuid for an idea-anchored
// session, or the entity uuid for an ad-hoc one — the deterministic Claude session
// anchor the daemon already computes), NOT the server-side turn uuid, which the daemon
// never learns. The service resolves the agent's `(agentUuid, sessionId)` session and
// advances its most-recent turn through the single `advanceTurn` chokepoint (strict
// ordering + `transcript:{sessionUuid}` SSE publish enforced there).
//
// Auth mirrors the execution-state / transcript precedent EXACTLY: any valid auth
// context (notably an agent API key) is accepted, there is NO MCP tool and NO new
// permission bit, and the writable set is scoped to the caller's OWN sessions/turns by
// the service. The connectionUuid must belong to the authenticated agent (so the
// optional executionUuid linkage is resolved against a connection the agent owns); a
// connection or session the agent does not own (or that does not exist) yields 404 —
// never a 403 that would confirm another agent's resource exists.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { connectionBelongsToAgent, EXECUTION_ENTITY_TYPES } from "@/services/daemon-execution.service";
import { TURN_STATUSES, advanceTurnForWake } from "@/services/daemon-session.service";

// Body: the connection reporting the advance, the session business key, the target
// status, and the OPTIONAL wake-triggering entity (for the weak executionUuid link).
// `startedAt`/`endedAt` are optional ISO-8601 strings (the service defaults them to the
// transition time for the running/ended edges when omitted).
const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum([...TURN_STATUSES]),
  entityType: z.enum([...EXECUTION_ENTITY_TYPES]).optional(),
  entityUuid: z.string().min(1).optional(),
  startedAt: z.coerce.date().nullish(),
  endedAt: z.coerce.date().nullish(),
});

// POST /api/daemon/turn-advance — advance a turn's lifecycle by session business key.
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errors.badRequest("Invalid JSON body");
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return errors.validationError(parsed.error.flatten());
  }
  const { connectionUuid, sessionId, status, entityType, entityUuid, startedAt, endedAt } =
    parsed.data;

  // Ownership fence: the connection must belong to the authenticated agent within its
  // company. A connection owned by another agent (or non-existent) is 404 — never 403
  // — so we never confirm another agent's connection exists. (Same posture as
  // execution-state POST.)
  const owns = await connectionBelongsToAgent(auth.companyUuid, auth.actorUuid, connectionUuid);
  if (!owns) {
    return errors.notFound("Connection");
  }

  const result = await advanceTurnForWake({
    companyUuid: auth.companyUuid,
    agentUuid: auth.actorUuid,
    connectionUuid,
    sessionId,
    status,
    entityType: entityType ?? null,
    entityUuid: entityUuid ?? null,
    startedAt: startedAt ?? undefined,
    endedAt: endedAt ?? undefined,
  });

  if (!result.ok) {
    if (result.reason === "invalid_transition") {
      // The daemon reported a transition that is not the single legal forward edge
      // (e.g. a duplicate report). 409 conflict — surfaced, not silently swallowed.
      return errors.conflict(
        `Invalid turn transition ${result.from} → ${result.to}`,
      );
    }
    // 404 (not 403) — non-disclosure, indistinguishable from a non-existent session/turn.
    return errors.notFound("Turn");
  }

  return success({ turn: result.turn });
});
