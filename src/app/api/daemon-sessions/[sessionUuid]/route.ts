// src/app/api/daemon-sessions/[sessionUuid]/route.ts
// Owner-scoped single-session transcript read (子3 — daemon-session-transcript-read).
//
// GET — the caller's owner-scoped, company-fenced single daemon session WITH a PAGE of
// its ordered turns (newest-first window), each turn carrying its retained
// `user`/`assistant` transcript messages (via 子1's `getSessionDetail`). The chat-style
// modal uses this for the right-pane transcript: the first paint loads the latest page,
// and a "load earlier" affordance passes `?beforeSeq=<oldest loaded seq>` to walk back.
// Live updates flow over the `transcript:{sessionUuid}` SSE channel (newer turns only).
//
// Query params (both optional): `beforeSeq` (cursor — load turns older than this seq)
// and `limit` (page size in turns; the service clamps it to 1..200).
//
// Auth posture mirrors /api/daemon-sessions and the daemon read routes: any valid auth
// context (agent API key → its own session; user/super_admin → a session of an agent
// they own), no MCP tool, no new permission bit. A session that does not exist, lives
// in another company, or belongs to a non-owned agent all yield the SAME 404
// (non-disclosure) — the service returns `null`, never confirming another caller's
// session exists.

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { getSessionDetail } from "@/services/daemon-session.service";

type RouteContext = { params: Promise<{ sessionUuid: string }> };

// GET /api/daemon-sessions/[sessionUuid] — read one session's turns-with-messages.
export const GET = withErrorHandler<{ sessionUuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { sessionUuid } = await context.params;

    // Parse the optional pagination cursor + page size. A non-numeric value is ignored
    // (the service treats it as "newest page" / default size); the service clamps limit.
    const beforeSeqRaw = request.nextUrl.searchParams.get("beforeSeq");
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const beforeSeqNum = beforeSeqRaw !== null ? Number(beforeSeqRaw) : NaN;
    const limitNum = limitRaw !== null ? Number(limitRaw) : NaN;

    const detail = await getSessionDetail(auth, sessionUuid, {
      beforeSeq: Number.isFinite(beforeSeqNum) ? beforeSeqNum : null,
      ...(Number.isFinite(limitNum) ? { limit: limitNum } : {}),
    });
    if (!detail) {
      // null = not visible (non-existent, cross-company, or non-owned agent) → one
      // 404 in every negative case, indistinguishable (non-disclosure).
      return errors.notFound("Session");
    }

    return success(detail);
  },
);
