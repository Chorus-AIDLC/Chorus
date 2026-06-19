// src/app/api/daemon-sessions/ad-hoc/route.ts
// Ad-hoc create-and-send: start a new daemon session on a chosen online connection and
// send its first human instruction in one call (子2 — send side).
//
// POST — for an agent the caller owns, creates a new ad-hoc `DaemonSession`
// (`directIdeaUuid = null`, SERVER-generated `sessionId`) pinned to the chosen online
// connection, plus the first `human_instruction` turn (via the 子1 chokepoint). No live
// wake is emitted here (next task); reconnect-backfill delivers the pending turn.
//
// Auth posture mirrors the other daemon routes: any valid auth context, no MCP tool, no
// new permission bit. Typed errors → status: unowned/absent connection → 404
// (non-disclosure), offline connection → 409, empty/over-length text → 400.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  createAdHocSessionWithInstruction,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// Request body schema. `instructionText` length is validated in the service (against the
// single `MAX_INSTRUCTION_CHARS` constant) so the cap is single-sourced; here we only
// require the three string fields to be present and non-empty as identifiers.
const bodySchema = z.object({
  agentUuid: z.string().min(1),
  connectionUuid: z.string().min(1),
  instructionText: z.string(),
});

// POST /api/daemon-sessions/ad-hoc — create an ad-hoc session + first instruction turn.
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
  const { agentUuid, connectionUuid, instructionText } = parsed.data;

  try {
    const { session, turn } = await createAdHocSessionWithInstruction(auth, {
      agentUuid,
      connectionUuid,
      instructionText,
    });
    return success({ session, turn });
  } catch (err) {
    // unowned agent / absent / foreign connection → 404 non-disclosure.
    if (err instanceof ConnectionNotVisibleError) {
      return errors.notFound("Connection");
    }
    // offline connection → 409 (no session/turn created).
    if (err instanceof ConnectionOfflineError) {
      return errors.conflict(err.message);
    }
    // empty / over-length text → 400 (no session/turn created).
    if (err instanceof InstructionTextError) {
      return errors.badRequest(err.message);
    }
    throw err;
  }
});
