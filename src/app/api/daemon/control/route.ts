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
  CONTROL_COMMANDS,
  CONTROL_ENTITY_TYPES,
  resolveConnectionOwner,
  dispatchControl,
} from "@/services/daemon-control.service";

// Request body schema. `command` is the strict enum derived from CONTROL_COMMANDS
// (`interrupt` | `resume`) — an unknown command is rejected at this boundary with a
// 422 and nothing is published. `entityType` is the targeted resource kind;
// `targetConnectionUuid`/`entityUuid` are non-empty strings.
const bodySchema = z.object({
  command: z.enum([...CONTROL_COMMANDS]),
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
  const { command, targetConnectionUuid, entityType, entityUuid } = parsed.data;

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
  // path) and return without waiting for the kill — the daemon reports the
  // resulting task state asynchronously.
  dispatchControl({
    companyUuid: auth.companyUuid,
    targetConnectionUuid,
    command,
    entityType,
    entityUuid,
  });

  return success({ dispatched: true });
});
