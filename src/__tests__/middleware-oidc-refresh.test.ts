// Integration tests for the OIDC refresh branch of the Edge middleware
// (src/middleware.ts, §2). IdP-AGNOSTIC: a mock OIDC discovery document + mock token
// endpoint stand in for any standard issuer — there is no real IdP and no
// Cognito-specific assumption. Proves: an about-to-expire access token is refreshed via
// the standard `grant_type=refresh_token` exchange, refresh-token rotation updates the
// cookie with the IdP's refresh_expires_in (else the centralized default), and a refresh
// failure clears auth and redirects to /login.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { middleware } from "@/middleware";
import { REFRESH_TOKEN_COOKIE_MAX_AGE } from "@/lib/cookie-utils";

// Build a minimal JWT (header.payload.sig) with the given exp/iss. The middleware only
// base64url-decodes the payload to read `exp` — it does not verify the signature.
function makeAccessToken(opts: { expiresInSeconds: number; iss?: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: opts.iss ?? "https://idp.example.com",
      exp: Math.floor(Date.now() / 1000) + opts.expiresInSeconds,
    })
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

// Unique issuer per test so the middleware's in-memory discovery cache never leaks
// between tests.
let issuerCounter = 0;
function freshIssuer(): string {
  issuerCounter += 1;
  return `https://idp-${issuerCounter}.example.com`;
}

function makeRequest(opts: {
  issuer: string;
  accessExpiresInSeconds?: number; // omit → no access token cookie
  refreshToken?: string | null; // null → no refresh cookie
  clientId?: string | null;
  pathname?: string;
}): NextRequest {
  const req = new NextRequest(new URL(`http://localhost:8637${opts.pathname ?? "/projects"}`));
  if (opts.accessExpiresInSeconds !== undefined) {
    req.cookies.set(
      "oidc_access_token",
      makeAccessToken({ expiresInSeconds: opts.accessExpiresInSeconds, iss: opts.issuer })
    );
  }
  if (opts.refreshToken !== null) {
    req.cookies.set("oidc_refresh_token", opts.refreshToken ?? "refresh-token-1");
  }
  if (opts.clientId !== null) {
    req.cookies.set("oidc_client_id", opts.clientId ?? "client-1");
  }
  req.cookies.set("oidc_issuer", opts.issuer);
  return req;
}

// fetch mock: first call = discovery document, second = token endpoint.
function mockDiscoveryAndToken(issuer: string, tokenResponse: { ok: boolean; body?: unknown }) {
  const tokenEndpoint = `${issuer}/oauth2/token`;
  vi.mocked(fetch).mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/.well-known/openid-configuration")) {
      return { ok: true, json: async () => ({ token_endpoint: tokenEndpoint }) } as any;
    }
    if (url === tokenEndpoint) {
      return {
        ok: tokenResponse.ok,
        status: tokenResponse.ok ? 200 : 400,
        json: async () => tokenResponse.body ?? {},
      } as any;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return tokenEndpoint;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("middleware OIDC refresh (IdP-agnostic)", () => {
  it("passes through without refreshing when the access token is comfortably valid", async () => {
    const issuer = freshIssuer();
    const req = makeRequest({ issuer, accessExpiresInSeconds: 3600 });

    const res = await middleware(req);

    // No refresh attempted; not a redirect.
    expect(fetch).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("refreshes via standard grant_type=refresh_token when the access token is about to expire", async () => {
    const issuer = freshIssuer();
    const tokenEndpoint = mockDiscoveryAndToken(issuer, {
      ok: true,
      body: { access_token: makeAccessToken({ expiresInSeconds: 3600, iss: issuer }), expires_in: 3600 },
    });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 10 }); // within the 30s threshold

    const res = await middleware(req);

    // Discovery + token-endpoint calls happened.
    const tokenCall = vi.mocked(fetch).mock.calls.find((c) => c[0] === tokenEndpoint);
    expect(tokenCall).toBeTruthy();
    const body = (tokenCall![1] as RequestInit).body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token-1");
    expect(body.get("client_id")).toBe("client-1");

    // New access token written to the response cookie; not a redirect.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("oidc_access_token")?.value).toBeTruthy();
  });

  it("rotates the refresh cookie using refresh_expires_in when the IdP returns one", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, {
      ok: true,
      body: {
        access_token: makeAccessToken({ expiresInSeconds: 3600, iss: issuer }),
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        refresh_expires_in: 7 * 24 * 3600, // 7 days
      },
    });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    const rotated = res.cookies.get("oidc_refresh_token");
    expect(rotated?.value).toBe("rotated-refresh-token");
    expect(rotated?.maxAge).toBe(7 * 24 * 3600);
  });

  it("rotates the refresh cookie with the centralized default when refresh_expires_in is absent", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, {
      ok: true,
      body: {
        access_token: makeAccessToken({ expiresInSeconds: 3600, iss: issuer }),
        expires_in: 3600,
        refresh_token: "rotated-refresh-token-2",
        // no refresh_expires_in
      },
    });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    const rotated = res.cookies.get("oidc_refresh_token");
    expect(rotated?.value).toBe("rotated-refresh-token-2");
    expect(rotated?.maxAge).toBe(REFRESH_TOKEN_COOKIE_MAX_AGE);
  });

  it("clears auth and redirects to /login when the token endpoint rejects the refresh", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, { ok: false, body: { error: "invalid_grant" } });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expect(res.headers.get("location")).toContain("/login");
    // Auth cookies are expired (maxAge 0).
    expect(res.cookies.get("oidc_access_token")?.maxAge).toBe(0);
    expect(res.cookies.get("oidc_refresh_token")?.maxAge).toBe(0);
  });

  it("clears auth and redirects when the token response has no access_token", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, { ok: true, body: { expires_in: 3600 } }); // missing access_token
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expect(res.headers.get("location")).toContain("/login");
  });

  it("clears auth and redirects when discovery cannot resolve a token endpoint", async () => {
    const issuer = freshIssuer();
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/.well-known/openid-configuration")) {
        return { ok: true, json: async () => ({}) } as any; // no token_endpoint
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects to /login when refresh materials are missing (no refresh cookie)", async () => {
    const issuer = freshIssuer();
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5, refreshToken: null });

    const res = await middleware(req);

    expect(res.headers.get("location")).toContain("/login");
    // No token endpoint should have been contacted.
    expect(fetch).not.toHaveBeenCalled();
  });
});
