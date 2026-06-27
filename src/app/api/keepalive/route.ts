// src/app/api/keepalive/route.ts
//
// Defense-in-depth endpoint for the OIDC session keepalive (src/lib/oidc-keepalive.ts).
// Its ONLY purpose is to be a cheap, middleware-covered path the client can ping while
// idle so the Edge middleware refreshes the `oidc_access_token` cookie before it expires.
//
// IMPORTANT: this path must stay OUTSIDE the middleware's `api/auth` exclusion (the
// matcher runs for `/api/keepalive` but not for `/api/auth/*`). The actual token refresh
// happens in the middleware BEFORE this handler runs; the handler itself just returns a
// tiny no-store response. It is intentionally unauthenticated and side-effect-free — a
// logged-out client pinging it simply gets ok:true and no cookie change.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } }
  );
}
