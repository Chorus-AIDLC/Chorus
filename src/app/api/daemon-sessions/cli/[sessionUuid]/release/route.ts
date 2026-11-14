// src/app/api/daemon-sessions/cli/[sessionUuid]/release/route.ts
// POST — release the CLI lease on exit (cli-agent-session-sync D2/D4): ends the CLI turn,
// clears the lease and immediately drains queued instructions to the origin daemon.
// Agent API key only. Body: { leaseHolder, continuable, reason? }
// 200 → { released: true, continuable, originBound, deliveredTurnUuids }
// 404 → unknown / foreign session (non-disclosure); 409 → stale leaseHolder / already released.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  CliLeaseConflictError,
  CliSessionNotFoundError,
  releaseCliSession,
} from "@/services/daemon-cli-session.service";

const bodySchema = z.object({
  leaseHolder: z.string().min(1).max(128),
  continuable: z.boolean(),
  reason: z.string().max(500).nullish(),
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
    return success(await releaseCliSession(auth, sessionUuid, parsed.data));
  } catch (err) {
    if (err instanceof CliSessionNotFoundError) return errors.notFound("Daemon session");
    if (err instanceof CliLeaseConflictError) return errors.conflict(err.message);
    throw err;
  }
});
