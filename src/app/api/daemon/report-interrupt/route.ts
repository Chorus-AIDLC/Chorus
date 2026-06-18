// src/app/api/daemon/report-interrupt/route.ts
// Daemon → server report of an interrupt/crash outcome (子3 — daemon-interrupt-resume).
//
// After the daemon stops a running wake's subprocess (a user-requested interrupt
// via the control channel, or an unexpected crash it detected), it POSTs here to
// record the outcome on the EXECUTION row — `interrupted` + an `interruptedReason`
// discriminator ("user" | "crash"). This is entity-generic: the daemon executes
// task / idea / proposal / document wakes, so the interrupted state lives on the
// DaemonExecution row (keyed connection + entity), NOT on the Task domain model.
//
// Posture mirrors /api/daemon/execution-state and /api/daemon/control: any valid
// auth context (notably the daemon's own agent API key) is accepted, NOT an MCP
// tool, NO new permission bit. Authorization reuses the shared reverse-control rule
// (owner of the connection's agent OR task:admin) so a caller can only report
// against a connection it is allowed to control. A connection absent within the
// caller's company → 404 non-disclosure.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, hasPermission } from "@/lib/auth";
import type { AgentAuthContext, SuperAdminAuthContext } from "@/types/auth";
import { authorizeConnectionControl, CONTROL_ENTITY_TYPES } from "@/services/daemon-control.service";
import {
  INTERRUPT_REASONS,
  reportExecutionInterrupt,
  publishExecutionChange,
} from "@/services/daemon-execution.service";

const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  entityType: z.enum([...CONTROL_ENTITY_TYPES]),
  entityUuid: z.string().min(1),
  reason: z.enum([...INTERRUPT_REASONS]),
});

// POST /api/daemon/report-interrupt — record an interrupt/crash outcome.
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
  const { connectionUuid, entityType, entityUuid, reason } = parsed.data;

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
      : errors.forbidden("Not authorized to report for this connection");
  }

  const updated = await reportExecutionInterrupt(
    auth.companyUuid,
    connectionUuid,
    entityType,
    entityUuid,
    reason,
  );
  if (!updated) {
    // No active execution row for this connection+entity (the wake already ended,
    // or was never running here). Nothing recorded.
    return errors.notFound("Execution");
  }

  // Push the updated active set so any UI viewing this connection reflects the
  // interrupted row immediately.
  await publishExecutionChange(auth.companyUuid, connectionUuid);

  return success({ recorded: true });
});
