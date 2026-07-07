// src/middleware.ts
// Edge Middleware: URL redirects + server-side OIDC token refresh (the single
// renewal authority — every matcher-covered request refreshes an expiring cookie)

import { NextRequest, NextResponse } from "next/server";
import { getCookieOptions, resolveRefreshCookieMaxAge } from "@/lib/cookie-utils";
import { tokenFingerprint } from "@/lib/token-fingerprint";
import { resolveIdeaRedirect } from "@/lib/idea-url-redirect";
import logger from "@/lib/logger";

const mwLogger = logger.child({ module: "middleware" });

// In-memory cache for OIDC discovery documents (per edge instance)
const discoveryCache = new Map<string, { tokenEndpoint: string; expiresAt: number }>();

// Decode JWT payload without verification (Edge Runtime compatible, no Buffer)
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Base64url → Base64 → decode
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Get token endpoint from OIDC discovery, with 10-minute cache
async function getTokenEndpoint(issuer: string): Promise<string | null> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tokenEndpoint;
  }

  try {
    const wellKnownUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(wellKnownUrl);
    if (!response.ok) return null;

    const doc = await response.json();
    const tokenEndpoint = doc.token_endpoint;
    if (!tokenEndpoint) return null;

    // Cache for 10 minutes
    discoveryCache.set(issuer, {
      tokenEndpoint,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return tokenEndpoint;
  } catch {
    return null;
  }
}

// ─── OIDC refresh diagnostics ────────────────────────────────────────────────
// One structured log line per refresh attempt. `outcome` is the enum tests assert
// on; failures log at warn so a resume-burst race (several failed_idp lines within
// ~1s of one refreshed line) is visible in production logs without DB writes.
type OidcRefreshOutcome =
  | "refreshed"
  | "failed_idp"
  | "failed_network"
  | "failed_discovery"
  | "failed_malformed"
  | "skipped_missing_materials";

function logOidcRefresh(
  outcome: OidcRefreshOutcome,
  fields: {
    pathname: string;
    expDelta: number | null; // seconds until/since access-token exp (negative = expired); null = no/undecodable token
    rtFp?: string; // refresh-token fingerprint (8-hex SHA-256 prefix) — traces token IDENTITY across attempts
    authTime?: number; // access token's auth_time claim — traces which LOGIN the token descends from
    status?: number; // IdP HTTP status when applicable
    errorCode?: string; // OAuth `error` field when parseable
    rotated?: boolean; // success only: whether a new refresh_token was returned
    newRtFp?: string; // rotation only: fingerprint of the newly issued refresh token
    durationMs?: number; // token-endpoint round-trip
    err?: unknown; // network-error detail (failed_network only)
  }
): void {
  const line = { event: "oidc_refresh", outcome, ...fields };
  if (outcome === "refreshed") {
    mwLogger.info(line, "OIDC refresh attempt");
  } else {
    mwLogger.warn(line, "OIDC refresh attempt");
  }
}

// ─── Main middleware ─────────────────────────────────────────────────────────
export async function middleware(request: NextRequest) {
  // --- 0. URL redirects ---
  const { pathname, searchParams } = request.nextUrl;

  // The Idea List page was removed (idea browsing lives in the Dashboard Idea
  // Tracker). Keep the RESTful idea URLs alive by 308-redirecting them into the
  // Dashboard + side-panel address. Also collapses the legacy ?idea={id} link
  // straight to the panel (was a two-hop /ideas/{id} redirect). See
  // src/lib/idea-url-redirect.ts for the mapping.
  const ideaRedirect = resolveIdeaRedirect(pathname, searchParams.get("idea"));
  if (ideaRedirect) {
    const url = request.nextUrl.clone();
    url.pathname = ideaRedirect.pathname;
    // Drop list-page filter params (status/assignedToMe) and the legacy ?idea=;
    // rebuild the query with only the panel param when there is one.
    url.search = "";
    if (ideaRedirect.panel) url.searchParams.set("panel", ideaRedirect.panel);
    return NextResponse.redirect(url, 308);
  }

  // The standalone /agent-connections page was removed — that view now lives in
  // the "View all" modal opened from the sidebar presence pill. Keep bookmarked /
  // external links alive by 308-redirecting the former path (and any sub-path) to
  // the dashboard (the /projects landing) rather than returning a broken route.
  // Same convention as the /ideas redirect above.
  if (pathname === "/agent-connections" || pathname.startsWith("/agent-connections/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/projects";
    url.search = "";
    return NextResponse.redirect(url, 308);
  }

  const tasksMatch = pathname.match(/^\/projects\/([^/]+)\/tasks$/);
  if (tasksMatch && searchParams.has("task")) {
    const taskUuid = searchParams.get("task")!;
    const url = request.nextUrl.clone();
    url.pathname = `/projects/${tasksMatch[1]}/tasks/${taskUuid}`;
    url.searchParams.delete("task");
    return NextResponse.redirect(url, 307);
  }

  // --- OIDC token refresh ---
  // (Default-auth `user_session` needs no middleware arm: no `user_refresh` cookie is
  // ever minted — the default-login session is a single long-lived JWT, and its expiry
  // is handled by the client probe's normal re-login path.)
  //
  // ⚠️ Every failure below is treated as TRANSIENT: pass the request through, never
  // clear cookies, never redirect. Under refresh-token rotation, a middleware
  // invocation cannot distinguish "I lost a concurrent-refresh race" (another request
  // just rotated the token; its Set-Cookie hasn't landed in this request's cookies)
  // from "the refresh token is genuinely revoked" — both surface as invalid_grant.
  // Only the client's session probe can tell them apart (by the time it retries the
  // matcher-covered probe, the winner's cookie has landed), so session death is
  // decided exclusively at the client's probe-retry 401 verdict (auth-context
  // fetchSession).
  const accessToken = request.cookies.get("oidc_access_token")?.value;

  // No access token at all — check if we have refresh materials
  if (!accessToken) {
    const refreshToken = request.cookies.get("oidc_refresh_token")?.value;
    if (!refreshToken) {
      // No tokens at all — let the request through (page-level auth will handle redirect)
      return NextResponse.next();
    }
    // Fall through to refresh logic below
  }

  // Seconds until/since the access token's exp at decision time (for diagnostics).
  let expDelta: number | null = null;
  // auth_time claim — identifies which LOGIN this token descends from (diagnostics).
  let authTime: number | undefined;

  // If we have an access token, check expiry
  if (accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (payload && typeof payload.auth_time === "number") {
      authTime = payload.auth_time;
    }
    if (payload && typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      expDelta = payload.exp - now;
      // If more than 30 seconds until expiry, let it through
      if (payload.exp - now > 30) {
        return NextResponse.next();
      }
    }
  }

  // Token is expired or about to expire — attempt refresh
  const { pathname: reqPathname } = request.nextUrl;
  const refreshToken = request.cookies.get("oidc_refresh_token")?.value;
  const clientId = request.cookies.get("oidc_client_id")?.value;
  const issuer = request.cookies.get("oidc_issuer")?.value;

  // Fingerprint the refresh token so its IDENTITY is traceable across attempts —
  // distinguishes "one token died" from "cookie was overwritten with another token".
  const rtFp = await tokenFingerprint(refreshToken);

  if (!refreshToken || !clientId || !issuer) {
    // Missing refresh materials — cannot refresh. Pass through; downstream auth and
    // the client probe decide the outcome.
    logOidcRefresh("skipped_missing_materials", { pathname: reqPathname, expDelta, rtFp, authTime });
    return NextResponse.next();
  }

  // Get the token endpoint
  const tokenEndpoint = await getTokenEndpoint(issuer);
  if (!tokenEndpoint) {
    logOidcRefresh("failed_discovery", { pathname: reqPathname, expDelta, rtFp, authTime });
    return NextResponse.next();
  }

  // Call the token endpoint
  const refreshStartedAt = Date.now();
  try {
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });
    const durationMs = Date.now() - refreshStartedAt;

    if (!tokenResponse.ok) {
      // Parse the OAuth error code defensively — the body may not be JSON.
      let errorCode: string | undefined;
      try {
        const errBody = await tokenResponse.json();
        if (errBody && typeof errBody.error === "string") errorCode = errBody.error;
      } catch {
        // Non-JSON error body — leave errorCode undefined.
      }
      logOidcRefresh("failed_idp", {
        pathname: reqPathname,
        expDelta,
        rtFp,
        authTime,
        status: tokenResponse.status,
        errorCode,
        durationMs,
      });
      return NextResponse.next();
    }

    const tokenData = await tokenResponse.json();
    const newAccessToken = tokenData.access_token;

    if (!newAccessToken) {
      logOidcRefresh("failed_malformed", {
        pathname: reqPathname,
        expDelta,
        rtFp,
        authTime,
        status: tokenResponse.status,
        durationMs,
      });
      return NextResponse.next();
    }

    // Determine maxAge from expires_in or default to 3600
    const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;

    // Write the new access token to the request cookie so downstream Server Components can read it
    request.cookies.set("oidc_access_token", newAccessToken);

    const response = NextResponse.next({
      request: {
        headers: request.headers,
      },
    });

    // Write the new access token to the response cookie for the browser
    response.cookies.set("oidc_access_token", newAccessToken, getCookieOptions(expiresIn));

    // If the provider returned a new refresh token (token rotation), update it.
    // This is the only cookie-write site that sees the IdP token response, so it can
    // honor the IdP's stated refresh-token lifetime; falls back to the centralized
    // default when the IdP omits refresh_expires_in.
    if (tokenData.refresh_token) {
      const refreshMaxAge = resolveRefreshCookieMaxAge(tokenData.refresh_expires_in);
      request.cookies.set("oidc_refresh_token", tokenData.refresh_token);
      response.cookies.set("oidc_refresh_token", tokenData.refresh_token, getCookieOptions(refreshMaxAge));
    }

    logOidcRefresh("refreshed", {
      pathname: reqPathname,
      expDelta,
      rtFp,
      authTime,
      rotated: Boolean(tokenData.refresh_token),
      newRtFp: tokenData.refresh_token ? await tokenFingerprint(tokenData.refresh_token) : undefined,
      durationMs,
    });

    return response;
  } catch (error) {
    // Network error (e.g. device radio not up yet after tab resume) — transient.
    logOidcRefresh("failed_network", {
      pathname: reqPathname,
      expDelta,
      rtFp,
      authTime,
      durationMs: Date.now() - refreshStartedAt,
      err: error,
    });
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    // Match all paths except static assets, login, auth API, and special paths
    "/((?!_next|login|api/auth|skill|favicon\\.ico|.*\\.).*)",
  ],
};
