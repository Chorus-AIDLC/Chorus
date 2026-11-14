// src/app/api/daemon-sessions/cli/[sessionUuid]/heartbeat/route.ts
// POST — renew the CLI lease (cli-agent-session-sync D1/D2). Agent API key only.
// Body: { leaseHolder, backendSessionId? }
// 200 → { leaseTtlSec, heartbeatIntervalSec, leaseExpiresAt, originBound }
// 404 → unknown / foreign session (non-disclosure); 409 → stale leaseHolder.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  CliLeaseConflictError,
  CliSessionNotFoundError,
  heartbeatCliSession,
} from "@/services/daemon-cli-session.service";

const bodySchema = z.object({
  leaseHolder: z.string().min(1).max(128),
  backendSessionId: z.string().min(1).max(255).nullish(),
});

export const POST = withErrorHandler<{ sessionUuid: string }>(async (request: NextRequest, context) => {
  const auth = await getAuthContext(request);
  if (!auth || auth.type !== "agent") {
    return errors.unauthorized();
  }
  const { sessionUuid } = await context.params;

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

  try {
    return success(await heartbeatCliSession(auth, sessionUuid, parsed.data));
  } catch (err) {
    if (err instanceof CliSessionNotFoundError) return errors.notFound("Daemon session");
    if (err instanceof CliLeaseConflictError) return errors.conflict(err.message);
    throw err;
  }
});
