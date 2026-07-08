// src/app/api/ideas/conversational/route.ts
// Conversational-idea dispatch: pre-create the Idea + its idea-anchored root daemon
// session + the first human instruction, in one transactional call
// (add-conversational-idea-root-session).
//
// POST — for an agent the caller owns and a chosen ONLINE connection, creates the Idea
// (createdBy = the calling user, placeholder title, verbatim description, instance-
// assigned + elaborating), a DaemonSession anchored to it from birth (sessionId =
// directIdeaUuid = ideaUuid, origin = the chosen connection), and the first
// `human_instruction` turn whose text is the SERVER-composed create-idea template. The
// frontend sends only the raw description; the server owns the template (the ideaUuid
// must be inside the instruction and only the server knows it pre-creation).
//
// Auth posture mirrors the ad-hoc daemon-session route: any valid auth context, no MCP
// tool, no new permission bit — visibility is enforced by the service's owner/self +
// company scope. Typed errors → status: unowned agent / foreign or absent connection /
// foreign project → 404 (non-disclosure); offline or instance-less connection → 409;
// empty / over-length composed text → 400.

import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  createConversationalIdeaSession,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  ConnectionInstanceMissingError,
  ProjectNotVisibleError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// Request body schema. `descriptionText` length is validated in the service (the
// COMPOSED instruction is checked against the single MAX_INSTRUCTION_CHARS constant);
// here the identifier fields are only required to be present.
const bodySchema = z.object({
  projectUuid: z.string().min(1),
  agentUuid: z.string().min(1),
  connectionUuid: z.string().min(1),
  descriptionText: z.string(),
  // Container-decompose intent (add-container-idea-ui Block 3). When true, the service
  // pre-creates the idea as a container (isContainer=true) and dispatches the decompose
  // instruction template. Optional + defaulting false so the existing conversational
  // path is unchanged. Rides the SAME human_instruction wake — no new action type.
  decompose: z.boolean().optional(),
});

// POST /api/ideas/conversational — pre-create idea + root session + first instruction.
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

  try {
    const { decompose, ...rest } = parsed.data;
    const { idea, session, turn } = await createConversationalIdeaSession(auth, {
      ...rest,
      mode: decompose ? "decompose" : "elaborate",
    });
    return success({ idea, session, turn });
  } catch (err) {
    // Unowned agent / absent or foreign connection → 404 non-disclosure (never confirm
    // another owner's agent/connection exists). A foreign/absent project is the same
    // non-disclosure verdict for its own entity.
    if (err instanceof ConnectionNotVisibleError) {
      return errors.notFound("Connection");
    }
    if (err instanceof ProjectNotVisibleError) {
      return errors.notFound("Project");
    }
    // Offline connection, or a connection whose durable instance is not linked yet →
    // 409 (retryable after the daemon reconnects/handshakes). Nothing was created.
    if (err instanceof ConnectionOfflineError) {
      return errors.conflict(err.message);
    }
    if (err instanceof ConnectionInstanceMissingError) {
      return errors.conflict(err.message);
    }
    // Empty description / over-length composed instruction → 400. Nothing was created.
    if (err instanceof InstructionTextError) {
      return errors.badRequest(err.message);
    }
    throw err;
  }
});
