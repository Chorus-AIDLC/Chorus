// src/app/api/session/route.ts
// User session probe + logout.
//
// Lives OUTSIDE /api/auth deliberately: the middleware matcher excludes api/auth
// (to protect cookie-WRITING routes from racing their own Set-Cookie), which meant
// the old /api/auth/session probe could never trigger the middleware's token
// refresh — forcing every caller into a "prime a covered path first, then probe"
// dance, duplicated at four call sites. At /api/session the probe request itself
// is matcher-covered: the middleware refreshes an expiring/expired access cookie
// (OIDC or default-auth) and rewrites request.cookies before this handler runs,
// so a single probe both renews and answers.

import { NextRequest, NextResponse } from "next/server";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { clearUserSessionCookies } from "@/lib/user-session";
import { getUserByUuid } from "@/services/user.service";

// GET /api/session - Get current user session
export async function GET(request: NextRequest) {
  const auth = await getAuthContext(request);

  if (!auth || !isUser(auth)) {
    return errors.unauthorized("No active session");
  }

  // Get fresh user data from database (UUID-based)
  const user = await getUserByUuid(auth.actorUuid);
  if (!user) {
    const response = NextResponse.json(
      { success: false, error: { message: "User not found" } },
      { status: 401 }
    );
    clearUserSessionCookies(response);
    return response;
  }

  return success({
    user: {
      uuid: user.uuid,
      email: user.email,
      name: user.name,
    },
    company: {
      uuid: user.company.uuid,
      name: user.company.name,
    },
  });
}

// DELETE /api/session - Logout (clears superadmin cookies if present)
export async function DELETE() {
  // NOTE: the old /api/auth/session route wrapped success() (already a NextResponse)
  // in another NextResponse.json, serializing an empty body. Callers only rely on
  // the cookie clearing, but return a real envelope anyway.
  const response = NextResponse.json({ success: true, data: { message: "Logged out" } });
  clearUserSessionCookies(response);
  return response;
}
