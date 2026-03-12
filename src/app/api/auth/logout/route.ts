// src/app/api/auth/logout/route.ts
// Clears HTTP-only cookie on logout

import { NextResponse } from "next/server";
import { getCookieOptions } from "@/lib/cookie-utils";

// POST /api/auth/logout - Clear auth cookie
export async function POST() {
  const response = NextResponse.json({ success: true });

  const expireOpts = getCookieOptions(0);

  // Clear OIDC auth cookies
  response.cookies.set("oidc_access_token", "", expireOpts);
  response.cookies.set("oidc_refresh_token", "", expireOpts);
  response.cookies.set("oidc_client_id", "", expireOpts);
  response.cookies.set("oidc_issuer", "", expireOpts);

  // Clear default auth cookies
  response.cookies.set("user_session", "", expireOpts);
  response.cookies.set("user_refresh", "", expireOpts);

  return response;
}
