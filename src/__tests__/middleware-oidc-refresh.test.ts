// Integration tests for the OIDC refresh branch of the Edge middleware
// (src/middleware.ts, §2). IdP-AGNOSTIC: a mock OIDC discovery document + mock token
// endpoint stand in for any standard issuer — there is no real IdP and no
// Cognito-specific assumption. Proves: an about-to-expire access token is refreshed via
// the standard `grant_type=refresh_token` exchange, refresh-token rotation updates the
// cookie with the IdP's refresh_expires_in (else the centralized default), and EVERY
// refresh failure is non-destructive — the request passes through with zero cookie
// mutation and zero redirects (under rotation the middleware cannot distinguish losing
// a concurrent-refresh race from genuine revocation; session death is decided only by
// the client's post-prime double-401 site). Each attempt emits one structured
// `oidc_refresh` diagnostic line whose `outcome` is asserted per failure class.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: logInfo, error: vi.fn(), warn: logWarn, debug: vi.fn() }) },
}));

import { middleware } from "@/middleware";
import { REFRESH_TOKEN_COOKIE_MAX_AGE } from "@/lib/cookie-utils";

const AUTH_COOKIES = [
  "oidc_access_token",
  "oidc_refresh_token",
  "oidc_client_id",
  "oidc_issuer",
  "user_session",
  "user_refresh",
] as const;

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

// The non-destructive pass-through contract: not a redirect, and NO auth cookie is
// touched on the response (in particular, none is expired via maxAge 0 / empty value).
function expectPassThroughUntouched(res: NextResponse) {
  expect(res.headers.get("location")).toBeNull();
  expect(res.status).toBe(200);
  for (const name of AUTH_COOKIES) {
    expect(res.cookies.get(name)).toBeUndefined();
  }
}

// The single structured diagnostic line for the attempt, asserted by outcome.
function expectRefreshLog(fn: ReturnType<typeof vi.fn>, outcome: string) {
  const calls = [...logInfo.mock.calls, ...logWarn.mock.calls].filter(
    (c) => c[0] && typeof c[0] === "object" && c[0].event === "oidc_refresh"
  );
  expect(calls).toHaveLength(1);
  const line = calls[0][0];
  expect(line.outcome).toBe(outcome);
  expect(typeof line.pathname).toBe("string");
  expect("expDelta" in line).toBe(true);
  // Level: refreshed → info, everything else → warn.
  const expectedFn = outcome === "refreshed" ? logInfo : logWarn;
  expect(expectedFn.mock.calls.some((c) => c[0]?.event === "oidc_refresh")).toBe(true);
  expect(fn.mock.calls.some((c) => c[0]?.event === "oidc_refresh")).toBe(true);
  return line;
}

// fetch mock: first call = discovery document, second = token endpoint.
function mockDiscoveryAndToken(issuer: string, tokenResponse: { ok: boolean; body?: unknown; jsonThrows?: boolean }) {
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
        json: async () => {
          if (tokenResponse.jsonThrows) throw new Error("not json");
          return tokenResponse.body ?? {};
        },
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

    // No refresh attempted; not a redirect; no diagnostic line.
    expect(fetch).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
    expect(logInfo.mock.calls.concat(logWarn.mock.calls).filter((c) => c[0]?.event === "oidc_refresh")).toHaveLength(0);
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

    // One structured success line at info level, without rotation.
    const line = expectRefreshLog(logInfo, "refreshed");
    expect(line.rotated).toBe(false);
    expect(typeof line.durationMs).toBe("number");
    expect(line.rtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(line.newRtFp).toBeUndefined(); // no rotation → no new fingerprint
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

    const line = expectRefreshLog(logInfo, "refreshed");
    expect(line.rotated).toBe(true);
    // Rotation logs BOTH the consumed and the newly issued token's fingerprint.
    expect(line.rtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(line.newRtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(line.newRtFp).not.toBe(line.rtFp);
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

  it("passes through untouched when the token endpoint rejects the refresh (invalid_grant race loser)", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, { ok: false, body: { error: "invalid_grant" } });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    const line = expectRefreshLog(logWarn, "failed_idp");
    expect(line.status).toBe(400);
    expect(line.errorCode).toBe("invalid_grant");
    expect(typeof line.durationMs).toBe("number");
    // Refresh-token fingerprint traces token identity across attempts (8-hex, no raw material).
    expect(line.rtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(line)).not.toContain("refresh-token-1");
  });

  it("passes through untouched when the IdP error body is not JSON (errorCode undefined)", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, { ok: false, jsonThrows: true });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    const line = expectRefreshLog(logWarn, "failed_idp");
    expect(line.errorCode).toBeUndefined();
  });

  it("passes through untouched when the token response has no access_token", async () => {
    const issuer = freshIssuer();
    mockDiscoveryAndToken(issuer, { ok: true, body: { expires_in: 3600 } }); // missing access_token
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    expectRefreshLog(logWarn, "failed_malformed");
  });

  it("passes through untouched when discovery cannot resolve a token endpoint", async () => {
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

    expectPassThroughUntouched(res);
    expectRefreshLog(logWarn, "failed_discovery");
  });

  it("passes through untouched when the token-endpoint fetch throws (network error on resume)", async () => {
    const issuer = freshIssuer();
    const tokenEndpoint = `${issuer}/oauth2/token`;
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/.well-known/openid-configuration")) {
        return { ok: true, json: async () => ({ token_endpoint: tokenEndpoint }) } as any;
      }
      throw new TypeError("fetch failed"); // radio not up yet
    });
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5 });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    expectRefreshLog(logWarn, "failed_network");
  });

  it("passes through untouched when refresh materials are missing (no refresh cookie)", async () => {
    const issuer = freshIssuer();
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5, refreshToken: null });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    // No token endpoint should have been contacted.
    expect(fetch).not.toHaveBeenCalled();
    const line = expectRefreshLog(logWarn, "skipped_missing_materials");
    expect(line.expDelta).toBeLessThanOrEqual(5);
  });

  it("passes through untouched when the client_id cookie is missing", async () => {
    const issuer = freshIssuer();
    const req = makeRequest({ issuer, accessExpiresInSeconds: 5, clientId: null });

    const res = await middleware(req);

    expectPassThroughUntouched(res);
    expect(fetch).not.toHaveBeenCalled();
    expectRefreshLog(logWarn, "skipped_missing_materials");
  });
});
