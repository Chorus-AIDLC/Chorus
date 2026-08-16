// src/app/api/daemon/resume/route.ts
// User-triggered resume of an interrupted wake (子3 — daemon-interrupt-resume;
// widened by add-crash-execution-resume).
//
// The Agent Connections UI and the daemon chat window call this when a user clicks
// "Resume" on an interrupted execution row. It (1) validates the row is
// `interrupted` with reason `user` OR `crash` (a crash is manually resumable too —
// that covers a subprocess crash while the daemon stays online, which
// reconnect-backfill never reaches; a daemon restart still auto-recovers a crash),
// (2) records the row's transition back to `running`, and (3) dispatches a `resume`
// control command — carrying the prior reason as `resumeReason` so the daemon can
// inject a crash-specific continue instruction — over the same per-connection
// control channel as interrupt, so the daemon re-spawns and continues the session
// via `claude --resume <directIdeaUuid>`.
//
// Entity-generic + connection-targeted (task / idea / proposal / document), so it
// lives on the daemon surface keyed by connection + entity — NOT a Task-level
// endpoint. Authorization reuses the shared reverse-control rule (connection
// agent's owner OR task:admin); a connection absent within the caller's company →
// 404 non-disclosure. NOT an MCP tool, NO new permission bit.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, hasPermission } from "@/lib/auth";
import type { AgentAuthContext, SuperAdminAuthContext } from "@/types/auth";
import {
  authorizeConnectionControl,
  dispatchControl,
  CONTROL_ENTITY_TYPES,
} from "@/services/daemon-control.service";
import {
  resumeExecution,
  publishExecutionChange,
  isConnectionLive,
} from "@/services/daemon-execution.service";
import { prisma } from "@/lib/prisma";
import { resolveResourceOrchestrator } from "@/services/orchestrator.service";

const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  entityType: z.enum([...CONTROL_ENTITY_TYPES]),
  entityUuid: z.string().min(1),
});

// POST /api/daemon/resume — resume an interrupted wake (user- or crash-interrupted).
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
  const { connectionUuid, entityType, entityUuid } = parsed.data;

  const hasTaskAdmin =
    (auth.type === "agent" || auth.type === "super_admin") &&
    hasPermission(auth as AgentAuthContext | SuperAdminAuthContext, "task:admin");
  const authz = await authorizeConnectionControl({
    companyUuid: auth.companyUuid,
    actorUuid: auth.actorUuid,
    hasTaskAdmin,
    connectionUuid,
  });
  if (!authz.ok) {
    return authz.reason === "not_found"
      ? errors.notFound("Connection")
      : errors.forbidden("Not authorized to resume for this connection");
  }

  // The `resume` control command is a transient SSE event (not a persisted,
  // backfill-replayed notification). If the target daemon is OFFLINE, the command
  // would be dropped and the resume silently lost — and a row flipped to `running`
  // on an offline connection is hidden by the live-connection read filter, so it
  // would vanish from the UI. Refuse up front: the row stays `interrupted` (still
  // resumable once the daemon reconnects) and the caller gets a clear error.
  if (!(await isConnectionLive(auth.companyUuid, connectionUuid))) {
    return errors.badRequest(
      "The daemon for this connection is offline; reconnect it before resuming.",
    );
  }

  const orchestrator = await resolveResourceOrchestrator(
    auth.companyUuid,
    entityType,
    entityUuid,
  );

  // Record the row transition. An interrupted row (reason user OR crash) is
  // resumable; any non-interrupted row is rejected with a precise error.
  const result = await resumeExecution(auth.companyUuid, connectionUuid, entityType, entityUuid);
  if (!result.ok) {
    if (result.reason === "not_found") return errors.notFound("Execution");
    return errors.badRequest(
      `Execution is not resumable (status=${result.status}, reason=${result.interruptedReason ?? "none"})`,
    );
  }
  const execution = await prisma.daemonExecution?.findFirst({
    where: { companyUuid: auth.companyUuid, connectionUuid, entityType, entityUuid },
    select: { directIdeaUuid: true },
  });
  const resumedSession = await prisma.daemonSession?.findFirst({
    where: {
      companyUuid: auth.companyUuid,
      agentUuid: authz.target.agentUuid,
      sessionId: execution?.directIdeaUuid ?? entityUuid,
    },
    select: { runtimeCwd: true },
  });

  // Tell the daemon to re-spawn and continue the session, then push the updated
  // active set so the UI reflects the resumed row immediately. `resumeReason` is the
  // row's prior interruptedReason — the daemon branches its continue instruction on it.
  dispatchControl({
    companyUuid: auth.companyUuid,
    targetConnectionUuid: connectionUuid,
    command: "resume",
    entityType,
    entityUuid,
    resumeReason: result.resumedFrom,
    orchestrator,
    ...(resumedSession?.runtimeCwd ? { runtimeCwd: resumedSession.runtimeCwd } : {}),
  });
  await publishExecutionChange(auth.companyUuid, connectionUuid);

  return success({ resumed: true });
});
