// src/app/api/ideas/[uuid]/wake-preview/route.ts
// Read-only wake-target preview for an Idea (Part 1b — pin-cwd-before-wake).
//
// GET /api/ideas/[uuid]/wake-preview → { outcome, assigneeAgentUuid, onlineInstances[] }.
//
// The stage-advance / proposal wake buttons consult this on click to decide whether to
// prompt for a cwd (`pick`), silently pin the sole online cwd (`auto_pin`), or wake
// directly (`direct`). It is driven by the human user in the UI, so it is callable by a
// `user` or `super_admin` auth type — NOT by an agent (an agent key never drives these
// human wake buttons). Company-scoped: a cross-company idea is a plain 404 (the service
// returns null for any idea not in the caller's company), never a cross-tenant read.
//
// READ-ONLY: the preview causes no wake, no assignee change, and no activity (see
// wake-preview.service). This route only reads.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { previewIdeaWakeTarget } from "@/services/wake-preview.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/ideas/[uuid]/wake-preview
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    // Human-driven UI action: only a `user` or `super_admin` may consult the preview.
    // An agent caller is forbidden — it never drives the human wake buttons.
    if (auth.type !== "user" && auth.type !== "super_admin") {
      return errors.forbidden("Only users can preview the wake target");
    }

    const { uuid } = await context.params;

    const preview = await previewIdeaWakeTarget(auth.companyUuid, uuid, auth.actorUuid);
    // null → the idea does not exist in this company (or a foreign-company idea) → 404.
    if (!preview) {
      return errors.notFound("Idea");
    }

    return success(preview);
  }
);
