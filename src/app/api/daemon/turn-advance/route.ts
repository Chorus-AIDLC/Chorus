// src/app/api/daemon/turn-advance/route.ts
// Daemon → server turn lifecycle advance (子1 — daemon-session-conversation).
//
// POST — the daemon advances the lifecycle of the turn it is executing
// (`pending → running → ended | interrupted`) on ONE of its OWN sessions. It identifies the turn by
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
import {
  TURN_STATUSES,
  DAEMON_REPORTABLE_INTERRUPT_REASONS,
  advanceTurnForWake,
} from "@/services/daemon-session.service";

// Body: the connection reporting the advance, the session business key, the target
// status, and the OPTIONAL wake-triggering entity (for the weak executionUuid link).
// `startedAt`/`endedAt` are optional ISO-8601 strings (the service defaults them to the
// transition time for the running/terminal edges when omitted). `interruptedReason`
// MUST accompany `status = interrupted` (and only that status) — the reason column's
// "non-null iff interrupted" invariant is enforced at this boundary, not trusted to
// clients — and is restricted to the DAEMON-reportable subset (`user`/`crash`/
// `shutdown`): `offline` is the server reconcile's verdict about a dead daemon, which
// a daemon alive enough to report cannot truthfully claim.
const bodySchema = z
  .object({
    connectionUuid: z.string().min(1),
    sessionId: z.string().min(1),
    turnUuid: z.string().min(1).max(100).nullish(),
    backendSessionId: z.string().trim().min(1).max(200).nullish(),
    status: z.enum([...TURN_STATUSES]),
    // Number of same-session wakes the daemon coalesced into THIS batch (daemon-wake-
    // coalescing). Optional, defaults to 1 (a single, non-coalesced wake). Meaningful on the
    // running-transition: the service settles the next `coalescedCount − 1` pending turns of
    // the session to `merged`. Positive integer; a smaller/fractional value is a client bug.
    coalescedCount: z.number().int().min(1).default(1),
    entityType: z.enum([...EXECUTION_ENTITY_TYPES]).optional(),
    entityUuid: z.string().min(1).optional(),
    startedAt: z.coerce.date().nullish(),
    endedAt: z.coerce.date().nullish(),
    interruptedReason: z.enum([...DAEMON_REPORTABLE_INTERRUPT_REASONS]).nullish(),
    // Transcript-relay failure annotation (fix #444 follow-up): the daemon KNEW this turn's
    // transcript upload finally failed (retry exhausted / non-2xx / network) even though the
    // wake exited. Free-text cause (e.g. "transcript upload returned 502"); bounded so a
    // malformed/huge value can't bloat the row. Meaningful only on a terminal edge — the
    // service ignores it on → running.
    transcriptRelayError: z.string().min(1).max(500).nullish(),
    // Per-turn token usage (daemon-token-usage): the whole normalized TokenUsage object,
    // captured by the daemon from the Claude Code `result` envelope. Token fields are
    // non-negative ints (nullable — a backend fills only what it can report); `model` is a
    // bounded string; `source` names the producing backend. Meaningful only on a terminal
    // edge — the service persists it on → ended/interrupted and ignores it on → running.
    // `.strict()` rejects unknown keys so a malformed/oversized blob can't ride through.
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullish(),
        outputTokens: z.number().int().nonnegative().nullish(),
        cacheCreationTokens: z.number().int().nonnegative().nullish(),
        cacheReadTokens: z.number().int().nonnegative().nullish(),
        model: z.string().max(200).nullish(),
        source: z.string().min(1).max(60),
      })
      .strict()
      .nullish(),
  })
  .refine((b) => b.status === "interrupted" || b.interruptedReason == null, {
    message: "interruptedReason is only valid with status=interrupted",
    path: ["interruptedReason"],
  })
  .refine((b) => b.status !== "interrupted" || b.interruptedReason != null, {
    message: "interruptedReason is required with status=interrupted",
    path: ["interruptedReason"],
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
  const {
    connectionUuid,
    sessionId,
    turnUuid,
    backendSessionId,
    status,
    coalescedCount,
    entityType,
    entityUuid,
    startedAt,
    endedAt,
    interruptedReason,
    transcriptRelayError,
    usage,
  } = parsed.data;

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
    turnUuid: turnUuid ?? undefined,
    backendSessionId: backendSessionId ?? undefined,
    status,
    coalescedCount,
    entityType: entityType ?? null,
    entityUuid: entityUuid ?? null,
    startedAt: startedAt ?? undefined,
    endedAt: endedAt ?? undefined,
    interruptedReason: interruptedReason ?? undefined,
    relayError: transcriptRelayError ?? undefined,
    // Normalize the Zod-parsed usage (optional fields are number|null|undefined) into the
    // clean TokenUsage shape (number|null) the service persists — undefined → null so the
    // stored JSON has an explicit null for a field the backend didn't report.
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          cacheCreationTokens: usage.cacheCreationTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          model: usage.model ?? null,
          source: usage.source,
        }
      : undefined,
  });

  if (!result.ok) {
    if (result.reason === "backend_session_conflict") {
      return errors.conflict("Backend session ID conflicts with the persisted value");
    }
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
