// src/app/api/daemon-sessions/cli/route.ts
// POST — register a foreground `chorus agents run` conversation as a DaemonSession
// (cli-agent-session-sync D2). Agent API key only, self-scoped; no MCP tool, no new
// permission bit. Business logic lives in daemon-cli-session.service.
//
// Body: { agentType, host, cwd, ideaUuid?, backendSessionId?, title?, continuable? }
// 200 → { sessionUuid, sessionId, turnUuid, leaseHolder, leaseTtlSec, heartbeatIntervalSec,
//         leaseExpiresAt, originBound, continuable }
// 400 → invalid idea (unknown / not editable by the agent) or malformed JSON; 422 → schema.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { CliInvalidIdeaError, registerCliSession } from "@/services/daemon-cli-session.service";

const bodySchema = z.object({
  agentType: z.string().min(1).max(64),
  host: z.string().max(255),
  cwd: z.string().min(1).max(4096),
  ideaUuid: z.string().min(1).max(64).nullish(),
  backendSessionId: z.string().min(1).max(255).nullish(),
  title: z.string().max(200).nullish(),
  continuable: z.boolean().optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth || auth.type !== "agent") {
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

  try {
    const result = await registerCliSession(auth, parsed.data);
    return success(result);
  } catch (err) {
    if (err instanceof CliInvalidIdeaError) return errors.badRequest(err.message);
    throw err;
  }
});
