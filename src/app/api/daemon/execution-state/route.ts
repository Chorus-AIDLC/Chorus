// src/app/api/daemon/execution-state/route.ts
// Daemon execution-state ingest + first-paint read.
//
// POST — the daemon uploads a full execution snapshot for ONE of its
// connections (the WakeQueue's running/queued keys mapped to task/root-idea
// uuids). The server reconciles the connection's DaemonTaskExecution rows to the
// snapshot and pushes an `execution:{connectionUuid}` SSE event.
//
// GET — the Agent Connections detail pane reads a single connection's current
// running/queued set for first paint, before any SSE event arrives.
//
// Auth mirrors the agent-connections / root-idea precedent exactly: any valid
// auth context (notably an agent API key) is accepted, there is NO MCP tool and
// NO new permission bit, and the writable/readable set is scoped to the caller's
// own connections by the query itself. The connectionUuid must belong to the
// authenticated agent (POST) or be visible to the caller (GET), else 404 — never
// a 403 that would reveal another agent's connection.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  ACTIVE_EXECUTION_STATUSES,
  reconcileSnapshot,
  publishExecutionChange,
  connectionBelongsToAgent,
  connectionVisibleToCaller,
  getExecutionsForConnection,
  validateExecutionEntities,
  type SnapshotExecution,
} from "@/services/daemon-execution.service";

// Request body schema. `status` is constrained to the two active values a daemon
// can report — `ended` is a server-only terminal state set by reconcile, never
// accepted from the wire. `startedAt`/`rootIdeaUuid` are nullable/optional
// (a queued task has no start time; a quick task has no root idea). `startedAt`
// is coerced from an ISO-8601 string to a Date.
const snapshotEntrySchema = z.object({
  taskUuid: z.string().min(1),
  rootIdeaUuid: z.string().min(1).nullish(),
  status: z.enum([...ACTIVE_EXECUTION_STATUSES]),
  startedAt: z.coerce.date().nullish(),
});

const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  executions: z.array(snapshotEntrySchema),
});

// POST /api/daemon/execution-state — ingest a connection's execution snapshot.
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
  const { connectionUuid, executions } = parsed.data;

  // Ownership fence: the connection must belong to the authenticated agent within
  // its company. A connection owned by another agent (or non-existent) is 404 —
  // NOT 403 — so we never confirm another agent's connection exists. No rows are
  // touched on the negative path.
  const owns = await connectionBelongsToAgent(
    auth.companyUuid,
    auth.actorUuid,
    connectionUuid,
  );
  if (!owns) {
    return errors.notFound("Connection");
  }

  // Multi-tenancy fence on the snapshot body: every referenced task/root-idea
  // must resolve within the caller's company before it is persisted.
  const entitiesValid = await validateExecutionEntities(
    auth.companyUuid,
    executions as SnapshotExecution[],
  );
  if (!entitiesValid) {
    return errors.badRequest("Snapshot references unknown task or root idea");
  }

  // Snapshot is authoritative: reconcile this connection's rows to the snapshot
  // (upsert reported tasks; end any active row absent from it), stamping
  // company/agent from the authenticated context (never trusted from the body).
  const reconciled = await reconcileSnapshot(
    auth.companyUuid,
    auth.actorUuid,
    connectionUuid,
    executions as SnapshotExecution[],
  );

  // Push the connection's new active set to subscribed UIs. Fire-and-forget —
  // swallows its own errors and never fails the ingest.
  await publishExecutionChange(auth.companyUuid, connectionUuid);

  return success({ reconciled });
});

// GET /api/daemon/execution-state?connectionUuid=… — first-paint read of a
// single connection's current running/queued set, owner/self scoped.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) {
    return errors.unauthorized();
  }

  const connectionUuid = request.nextUrl.searchParams.get("connectionUuid");
  if (!connectionUuid) {
    return errors.badRequest("connectionUuid is required");
  }

  // Visibility fence: same owner/self scoping as the connection registry. A
  // connection the caller cannot see is 404 (not 403) so it is indistinguishable
  // from a non-existent one.
  const visible = await connectionVisibleToCaller(auth, connectionUuid);
  if (!visible) {
    return errors.notFound("Connection");
  }

  const executions = await getExecutionsForConnection(auth.companyUuid, connectionUuid);
  return success({ executions });
});
