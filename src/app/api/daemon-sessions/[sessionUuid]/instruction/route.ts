// src/app/api/daemon-sessions/[sessionUuid]/instruction/route.ts
// Send a free-text human instruction to an existing daemon session (子2 — send side).
//
// POST — turns the submitted `instructionText` into a `human_instruction` TURN on the
// addressed `DaemonSession`, owner-scoped and gated on the session's origin connection
// being online. The actual turn is created at the single notification chokepoint (子1),
// session-key aligned so it appends to the EXISTING session row. No live wake is emitted
// here (next task); the persisted pending turn is delivered by reconnect-backfill.
//
// Auth posture mirrors the daemon read/write routes (pending-turns, transcript): any
// valid auth context (agent API key, user session, super_admin) is accepted, there is NO
// MCP tool, and NO new permission bit — visibility is enforced by the service's
// owner/self scope. Typed errors → status codes: not-visible → 404 (non-disclosure),
// read-only/offline origin → 409, empty/over-length text → 400.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { SessionReadOnlyError } from "@/services/daemon-session.service";
import {
  sendInstruction,
  SessionNotVisibleError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// POST /api/daemon-sessions/{sessionUuid}/instruction — append a human_instruction turn.
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
    const instructionText =
      raw && typeof raw === "object" && "instructionText" in raw
        ? (raw as { instructionText: unknown }).instructionText
        : undefined;
    if (typeof instructionText !== "string") {
      return errors.badRequest("instructionText (string) is required");
    }

    try {
      const { turn } = await sendInstruction(auth, { sessionUuid, instructionText });
      return success({ turn });
    } catch (err) {
      // not-visible → 404 (never confirm the session exists for another owner).
      if (err instanceof SessionNotVisibleError) {
        return errors.notFound("Daemon session");
      }
      // origin offline → 409 read-only (distinct from 404; history stays readable; never
      // routed to another connection of the same agent).
      if (err instanceof SessionReadOnlyError) {
        return errors.conflict(err.message);
      }
      // empty / over-length text → 400 (no turn was created).
      if (err instanceof InstructionTextError) {
        return errors.badRequest(err.message);
      }
      throw err;
    }
  },
);
