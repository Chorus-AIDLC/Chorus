// src/app/api/daemon-sessions/[sessionUuid]/repoint/route.ts
// Re-point a read-only (origin-offline) daemon session onto a chosen ONLINE connection of
// the SAME agent, then send a fresh human instruction there — KEEPING the same DaemonSession
// (same uuid, same sessionId, same directIdeaUuid). This is the corrected "Continue on an
// online directory" escape hatch (T12): it does NOT mint a new ad-hoc session (the T11
// mistake), so the conversation keeps its identity. The daemon, finding no transcript at the
// new cwd, spawns `claude --session-id <sameId>` — a fresh transcript under the same id.
//
// POST — for a session the caller owns whose CURRENT origin is offline, re-points its
// `originConnectionUuid` to the (online, same-agent) target connection and creates the first
// `human_instruction` turn on the SAME session (via the 子1 chokepoint), delivered to the new
// origin. The single deliberate reversal of the origin write-once invariant lives in the
// service; this route only maps the typed errors.
//
// Auth posture mirrors the other daemon routes: any valid auth context, no MCP tool, no new
// permission bit — visibility is enforced by the service's owner/self scope. Typed errors →
// status: not-visible session OR not-same-agent target → 404 (non-disclosure); current origin
// still LIVE OR target offline → 409; empty/over-length text → 400.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  repointSessionOriginAndSend,
  SessionNotVisibleError,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  RepointOriginLiveError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// Request body schema. `instructionText` length is validated in the service (against the
// single `MAX_INSTRUCTION_CHARS` constant) so the cap is single-sourced; here we only require
// the target connection + text fields to be present as identifiers.
const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  instructionText: z.string(),
});

// POST /api/daemon-sessions/{sessionUuid}/repoint — re-point origin + first instruction turn.
export const POST = withErrorHandler<{ sessionUuid: string }>(
  async (request: NextRequest, context) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { sessionUuid } = await context.params;
    if (!sessionUuid) {
      return errors.badRequest("sessionUuid is required");
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
    const { connectionUuid, instructionText } = parsed.data;

    try {
      const { session, turn } = await repointSessionOriginAndSend(auth, {
        sessionUuid,
        connectionUuid,
        instructionText,
      });
      return success({ session, turn });
    } catch (err) {
      // not-visible session OR target connection not of the same agent → 404 (never confirm
      // another owner's session/connection exists).
      if (
        err instanceof SessionNotVisibleError ||
        err instanceof ConnectionNotVisibleError
      ) {
        return errors.notFound("Daemon session");
      }
      // current origin still online (nothing to rescue) → 409; never re-point a live session.
      if (err instanceof RepointOriginLiveError) {
        return errors.conflict(err.message);
      }
      // target connection offline → 409 (no re-point, no turn created).
      if (err instanceof ConnectionOfflineError) {
        return errors.conflict(err.message);
      }
      // empty / over-length text → 400 (no re-point, no turn created).
      if (err instanceof InstructionTextError) {
        return errors.badRequest(err.message);
      }
      throw err;
    }
  },
);
