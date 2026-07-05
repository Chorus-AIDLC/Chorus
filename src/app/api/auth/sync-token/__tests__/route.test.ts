// Route-level tests for POST /api/auth/sync-token — strict mode and the
// recoverSession mode added for the iOS cookie-purge recovery (idea 3bf0819c).
// The oidc-auth verify functions are mocked at the module boundary (JWKS/network
// is not exercisable in unit tests); what these tests pin is the ROUTE's contract:
// which mode verifies with which function, which cookies are written / withheld,
// which requests are rejected, and the recovery log line.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const verifyOidcAccessToken = vi.hoisted(() => vi.fn());
const verifyOidcAccessTokenAllowExpired = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oidc-auth", () => ({
  verifyOidcAccessToken: (...a: unknown[]) => verifyOidcAccessToken(...a),
  verifyOidcAccessTokenAllowExpired: (...a: unknown[]) => verifyOidcAccessTokenAllowExpired(...a),
}));

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: logInfo, error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
    error: vi.fn(),
  },
}));

import { POST } from "@/app/api/auth/sync-token/route";
import { REFRESH_TOKEN_COOKIE_MAX_AGE } from "@/lib/cookie-utils";

// A structurally-valid JWT so getMaxAgeFromJwt can decode exp in strict mode.
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}
const FRESH_AT = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
const STALE_AT = makeJwt({ exp: Math.floor(Date.now() / 1000) - 86400 });

function makeRequest(body: Record<string, unknown>, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL("http://localhost:8637/api/auth/sync-token"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/sync-token — strict mode (unchanged)", () => {
  it("writes the access cookie when the token verifies", async () => {
    verifyOidcAccessToken.mockResolvedValue({ type: "user", companyUuid: "c1", actorUuid: "u1" });

    const res = await POST(makeRequest({ accessToken: FRESH_AT }));

    expect(res.status).toBe(200);
    expect(res.cookies.get("oidc_access_token")?.value).toBe(FRESH_AT);
    // Strict mode never touches config cookies.
    expect(res.cookies.get("oidc_client_id")).toBeUndefined();
    expect(res.cookies.get("oidc_issuer")).toBeUndefined();
    expect(verifyOidcAccessTokenAllowExpired).not.toHaveBeenCalled();
  });

  it("rejects an expired/invalid token with 401 (no recovery without the flag)", async () => {
    verifyOidcAccessToken.mockResolvedValue(null); // strict verify rejects expired

    const res = await POST(makeRequest({ accessToken: STALE_AT, refreshToken: "rt-1" }));

    expect(res.status).toBe(401);
    expect(res.cookies.get("oidc_access_token")).toBeUndefined();
    expect(res.cookies.get("oidc_refresh_token")).toBeUndefined();
  });

  it("rejects a missing accessToken with 400", async () => {
    const res = await POST(makeRequest({ refreshToken: "rt-1" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/sync-token — recoverSession mode", () => {
  it("rebuilds refresh materials from a stale-but-signature-valid token", async () => {
    verifyOidcAccessTokenAllowExpired.mockResolvedValue({
      companyUuid: "c1",
      issuer: "https://idp.example.com",
      clientId: "client-abc",
    });

    const res = await POST(
      makeRequest({ accessToken: STALE_AT, refreshToken: "rt-live", recoverSession: true })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.recovered).toBe(true);
    // Verified with the tolerance bounded by the refresh cookie lifetime.
    expect(verifyOidcAccessTokenAllowExpired).toHaveBeenCalledWith(STALE_AT, REFRESH_TOKEN_COOKIE_MAX_AGE);
    expect(verifyOidcAccessToken).not.toHaveBeenCalled();
    // All three refresh materials written; client_id/issuer from the SERVER-side
    // company record (the mock's values), never echoed from the client body.
    expect(res.cookies.get("oidc_refresh_token")?.value).toBe("rt-live");
    expect(res.cookies.get("oidc_client_id")?.value).toBe("client-abc");
    expect(res.cookies.get("oidc_issuer")?.value).toBe("https://idp.example.com");
    // The EXPIRED access token is deliberately NOT written.
    expect(res.cookies.get("oidc_access_token")).toBeUndefined();
  });

  it("logs the recovery with refresh-token fingerprints, never token material", async () => {
    verifyOidcAccessTokenAllowExpired.mockResolvedValue({
      companyUuid: "c1",
      issuer: "https://idp.example.com",
      clientId: "client-abc",
    });

    await POST(
      makeRequest(
        { accessToken: STALE_AT, refreshToken: "rt-live", recoverSession: true },
        { oidc_refresh_token: "rt-old-cookie" }
      )
    );

    const recover = logInfo.mock.calls.find((c) => c[0]?.event === "sync_token" && c[0]?.mode === "recover");
    expect(recover).toBeTruthy();
    expect(recover![0].incomingRtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(recover![0].cookieRtFp).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(recover![0])).not.toContain("rt-live");
  });

  it("rejects recoverSession without a refreshToken (400, no cookies)", async () => {
    const res = await POST(makeRequest({ accessToken: STALE_AT, recoverSession: true }));

    expect(res.status).toBe(400);
    expect(verifyOidcAccessTokenAllowExpired).not.toHaveBeenCalled();
    expect(res.cookies.get("oidc_refresh_token")).toBeUndefined();
  });

  it("rejects when even the tolerant verification fails (bad signature / unknown issuer)", async () => {
    verifyOidcAccessTokenAllowExpired.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ accessToken: STALE_AT, refreshToken: "rt-x", recoverSession: true })
    );

    expect(res.status).toBe(401);
    expect(res.cookies.get("oidc_refresh_token")).toBeUndefined();
    expect(res.cookies.get("oidc_client_id")).toBeUndefined();
  });

  it("rejects when the company has no OIDC client configured", async () => {
    verifyOidcAccessTokenAllowExpired.mockResolvedValue({
      companyUuid: "c1",
      issuer: "https://idp.example.com",
      clientId: null,
    });

    const res = await POST(
      makeRequest({ accessToken: STALE_AT, refreshToken: "rt-x", recoverSession: true })
    );

    expect(res.status).toBe(400);
    expect(res.cookies.get("oidc_refresh_token")).toBeUndefined();
  });
});
