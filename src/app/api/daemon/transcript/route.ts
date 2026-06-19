// src/app/api/daemon/transcript/route.ts
// Daemon per-turn transcript ingest (子1 — daemon-session-conversation).
//
// POST — an authenticated daemon uploads the user/assistant transcript text for ONE
// turn of one of its OWN sessions. Distinct from `execution-state` in two ways:
//   - semantics are APPEND (this call ADDS messages to the turn), NOT the
//     snapshot-reconcile of execution-state (which ends rows absent from the body), and
//   - it stores ONLY `user`/`assistant` text — tool-call / tool-result / thinking
//     content is dropped, never persisted.
// After a successful append the service publishes a `transcript:{sessionUuid}` SSE
// event (the `transcript_appended` trigger) on the existing event bus / Redis fan-out,
// so a viewer re-renders live. Retained messages are bounded by a per-session rolling
// window trimmed in application code (no data-mutating migration).
//
// Auth mirrors the execution-state / agent-connections precedent exactly: any valid
// auth context (notably an agent API key) is accepted, there is NO MCP tool and NO new
// permission bit, and the writable set is scoped to the caller's OWN sessions/turns by
// the service. A turn/session the authenticated agent does not own (or that does not
// exist) yields 404 — never a 403 that would confirm another agent's session exists.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  TRANSCRIPT_ROLES,
  appendTranscriptMessages,
  type InboundTranscriptMessage,
} from "@/services/daemon-session.service";

// One inbound transcript message. `role` is constrained to the persisted roles
// (`user` | `assistant`) at the boundary — a tool-call/tool-result/thinking entry is
// expected to be stripped by the daemon, but the service also re-filters defensively.
// `text` is the plain message body.
const messageSchema = z.object({
  role: z.enum([...TRANSCRIPT_ROLES]),
  text: z.string(),
});

// Body: exactly one of `turnUuid` / `sessionId` plus the messages to append.
//  - `turnUuid` targets a specific turn (the daemon's normal path), or
//  - `sessionId` (the conversation BUSINESS KEY — directIdeaUuid or ad-hoc uuid, NOT
//    the session's `uuid`) targets the session's most-recent turn.
// `.refine` enforces the one-of so a body with neither (or both) is a 422, never a
// silent mis-route.
const bodySchema = z
  .object({
    turnUuid: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    messages: z.array(messageSchema),
  })
  .refine((b) => Boolean(b.turnUuid) !== Boolean(b.sessionId), {
    message: "Provide exactly one of turnUuid or sessionId",
  });

// POST /api/daemon/transcript — append a turn's user/assistant transcript text.
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
  const { turnUuid, sessionId, messages } = parsed.data;

  // Ownership + append happen in the service (no turn/session business logic in the
  // route, per convention). companyUuid/agentUuid are stamped from the authenticated
  // context — never trusted from the body. A turn/session the agent does not own (or
  // that does not exist) returns the SAME `not_found` so we never confirm another
  // agent's session exists.
  const result = await appendTranscriptMessages({
    companyUuid: auth.companyUuid,
    agentUuid: auth.actorUuid,
    turnUuid: turnUuid ?? null,
    sessionId: sessionId ?? null,
    messages: messages as InboundTranscriptMessage[],
  });

  if (!result.ok) {
    // 404 (not 403) — non-disclosure, indistinguishable from a non-existent turn.
    return errors.notFound("Turn");
  }

  return success({
    appended: result.appended,
    stored: result.stored,
    messages: result.messages,
  });
});
