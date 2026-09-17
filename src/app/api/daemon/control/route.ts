// src/app/api/daemon/control/route.ts
// Reverse server→daemon control endpoint (子3 — daemon-interrupt-resume).
//
// POST — an authorized caller issues a control command (only `interrupt` this
// slice) targeting a specific daemon connection + entity. On success the endpoint
// publishes ONE `control:{connectionUuid}` event via `dispatchControl` and returns
// without waiting for the kill (fire-and-forward); the daemon reports the resulting
// `interrupted` task state asynchronously via its normal MCP path.
//
// Posture mirrors /api/daemon/execution-state and the root-idea endpoint exactly:
// any valid auth context (notably an agent API key, a user session, or a
// super_admin) is accepted, there is NO MCP tool, and NO new permission bit. This
// is NOT a persisted Notification and the command is NOT a member of the daemon's
// WAKE_ACTIONS — it never enters the wake path.
//
// Phantom-turn convergence (fix-phantom-running-turn C3): for `interrupt` ONLY, after the
// unconditional dispatch, the endpoint additionally settles the session's `running` turn as
// `interrupted(user)` when the server's own state shows no live run can act on the command
// (the connection is not effectively online, OR it reports no `running` execution for the
// entity — the zombie-SSE case). The response carries `settled` so the client can tell
// "asked the daemon" from "cleared it here"; a failed settle never fails the dispatch.
//
// Authorization (q2=a): resolve `targetConnectionUuid` → its DaemonConnection
// within the caller's company → the connection's agent → that agent's human owner.
// Allow iff the caller IS that owner OR holds `task:admin`; else 403. A connection
// absent within the caller's company → 404 non-disclosure (never confirm another
// company's / another owner's connection). Authorization never crosses company
// boundaries (the resolution is companyUuid-scoped).

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, hasPermission } from "@/lib/auth";
import type { AgentAuthContext, SuperAdminAuthContext } from "@/types/auth";
import {
  CONTROL_ENTITY_TYPES,
  resolveConnectionOwner,
  dispatchControl,
  type DispatchControlParams,
} from "@/services/daemon-control.service";
import {
  isConnectionLive,
  hasRunningExecution,
} from "@/services/daemon-execution.service";
import {
  advanceTurnForWake,
  resolveControlSessionId,
} from "@/services/daemon-session.service";
import logger from "@/lib/logger";

// Request body schema. This PUBLIC endpoint accepts ONLY the entity-bearing control
// verbs (`interrupt`/`resume`, 子3): they target a specific running/resumable resource,
// so they carry `entityType` (CONTROL_ENTITY_TYPES) + a non-empty `entityUuid`. An unknown
// command — or a missing entity field — is rejected here with a 422 and nothing published.
//
// `deliver_turn` (子2 — origin-only live delivery) is deliberately NOT accepted over HTTP:
// it is a SERVICE-INTERNAL ping the send path emits directly via `dispatchControl` after
// it has created the turn and knows the precise `turnUuid`. An external HTTP caller has no
// turnUuid to supply, so exposing it here would only admit a malformed, turn-less command.
const bodySchema = z.object({
  command: z.enum(["interrupt", "resume"]),
  targetConnectionUuid: z.string().min(1),
  entityType: z.enum([...CONTROL_ENTITY_TYPES]),
  entityUuid: z.string().min(1),
});

// POST /api/daemon/control — issue a reverse control command to a daemon.
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
  const body = parsed.data;
  const { targetConnectionUuid } = body;

  // Authz (q2=a): resolve the target connection's owner within the caller's company
  // (absent → 404 non-disclosure, never confirming another company's/owner's
  // connection), then allow iff the caller IS that owner OR holds `task:admin`. A
  // user caller can only pass via ownership (users carry no permission set); an
  // agent/super_admin can pass via task:admin. Never crosses company. On failure:
  // 403, nothing published. (This is the same owner-or-task:admin rule the
  // report-interrupt/resume routes apply via `authorizeConnectionControl`, expressed
  // inline here against `resolveConnectionOwner`.)
  const target = await resolveConnectionOwner(auth.companyUuid, targetConnectionUuid);
  if (!target) {
    return errors.notFound("Connection");
  }
  const isOwner = target.ownerUuid != null && auth.actorUuid === target.ownerUuid;
  const isTaskAdmin =
    (auth.type === "agent" || auth.type === "super_admin") &&
    hasPermission(auth as AgentAuthContext | SuperAdminAuthContext, "task:admin");
  if (!isOwner && !isTaskAdmin) {
    return errors.forbidden("Not authorized to control this connection");
  }

  // Authorized: publish exactly once through the dispatch seam (the only publish
  // path) and return without waiting for the daemon to act — the daemon reports the
  // resulting state asynchronously. The validated body IS the entity-bearing dispatch
  // shape (interrupt/resume only — deliver_turn is service-internal, never accepted here),
  // so it threads through verbatim with the authenticated company.
  dispatchControl({
    companyUuid: auth.companyUuid,
    targetConnectionUuid,
    command: body.command,
    entityType: body.entityType,
    entityUuid: body.entityUuid,
  } satisfies DispatchControlParams);

  // Converge a PHANTOM `running` turn (fix-phantom-running-turn C3). Publishing the
  // control event above is unconditional and unchanged; this is an ADDITIONAL settle, for
  // `interrupt` only, taken exactly when the server's OWN state shows there is no live run
  // that could act on the command:
  //
  //   (a) the target connection is not effectively online — the SSE event is dropped and
  //       never replays (a control command is not a persisted notification), OR
  //   (b) the connection looks online but reports NO `running` execution for this entity —
  //       the zombie-SSE case: a silently-dead reverse channel still keeps `lastSeenAt`
  //       fresh via REST heartbeats, so liveness alone would publish into a channel nobody
  //       listens on and the turn would stay `running` forever.
  //
  // We deliberately do NOT settle when the connection is online AND has a live `running`
  // row: there the daemon is the authority (its SIGINT escalation window is up to 10s), and
  // writing the terminal state first would tell the UI "interrupted" while the child is
  // still winding down. Stale evidence is safe in the other direction: if a `running`
  // upload was lost while a subprocess really is alive, the connection is online, the event
  // IS delivered, the daemon kills the child and reports `interrupted(user)` — the same
  // terminal state written here, absorbed by `advanceTurnForWake`'s idempotent terminal
  // short-circuit. Both paths land on the state the human asked for.
  let settled = false;
  if (body.command === "interrupt") {
    // The gate queries live INSIDE the try together with the settle: the control event is
    // already published, so a transient DB failure while EVALUATING the gate must not turn
    // a dispatched interrupt into a 500 — it must degrade to `settled: false` exactly like a
    // failed settle does.
    try {
      const noLiveRun =
        !(await isConnectionLive(auth.companyUuid, targetConnectionUuid)) ||
        !(await hasRunningExecution(
          auth.companyUuid,
          targetConnectionUuid,
          body.entityType,
          body.entityUuid,
        ));
      if (noLiveRun) {
        // Never assume `sessionId === body.entityUuid`. That identity holds for a modern
        // idea-anchored session and for `daemon_session`, but a LEGACY residual session's
        // key is `${ideaUuid}::${connectionUuid}` — and the client heals the `::` away, so
        // both shapes arrive as `idea:<ideaUuid>`. The resolver picks the candidate that
        // actually holds a `running` turn, and refuses (null) when the choice is ambiguous
        // or nothing matches, rather than clearing an unrelated conversation's turn.
        // `task` / `proposal` / `document` resolve no session here (their key is the
        // resource's DIRECT idea) and the UI never emits them on this path.
        const { sessionId, ambiguous } = await resolveControlSessionId({
          companyUuid: auth.companyUuid,
          agentUuid: target.agentUuid,
          connectionUuid: targetConnectionUuid,
          entityUuid: body.entityUuid,
        });
        if (!sessionId) {
          logger.info(
            {
              targetConnectionUuid,
              entityType: body.entityType,
              entityUuid: body.entityUuid,
              ambiguous,
            },
            ambiguous
              ? "daemon control interrupt: ambiguous session for this entity; settling nothing"
              : "daemon control interrupt: no session resolved for this entity",
          );
          return success({ dispatched: true, settled: false });
        }
        const result = await advanceTurnForWake({
          companyUuid: auth.companyUuid,
          agentUuid: target.agentUuid,
          connectionUuid: targetConnectionUuid,
          sessionId,
          status: "interrupted",
          interruptedReason: "user",
          entityType: body.entityType,
          entityUuid: body.entityUuid,
        });
        settled = result.ok;
        if (!result.ok) {
          // Not an error path: no `running` turn to settle (or an illegal transition) is
          // the common, benign outcome. Logged so it is never silent.
          logger.info(
            {
              targetConnectionUuid,
              entityType: body.entityType,
              entityUuid: body.entityUuid,
              reason: result.reason,
            },
            "daemon control interrupt: no turn settled",
          );
        }
      }
    } catch (error) {
      // A failed gate query OR settle must NEVER fail the dispatch — the control event is
      // already published. Report it in the body (`settled: false`) and log it.
      logger.error(
        { err: error, targetConnectionUuid, entityUuid: body.entityUuid },
        "daemon control interrupt: failed to settle the running turn",
      );
    }
  }

  // `settled` lets the client tell "asked the daemon to stop it" from "cleared it here".
  return success({ dispatched: true, settled });
});
