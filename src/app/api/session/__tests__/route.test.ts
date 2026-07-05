// Route tests for /api/session — the matcher-covered session probe + logout.
// The probe living OUTSIDE /api/auth is load-bearing: the middleware matcher
// excludes api/auth, so only at this path does the probe request itself get the
// middleware's token refresh (which is why the prime dance could be deleted).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getAuthContext: (...a: unknown[]) => getAuthContext(...a) };
});
const getUserByUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/user.service", () => ({
  getUserByUuid: (...a: unknown[]) => getUserByUuid(...a),
}));

import { GET, DELETE } from "@/app/api/session/route";

function makeRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:8637/api/session"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/session", () => {
  it("returns the session for an authenticated user", async () => {
    getAuthContext.mockResolvedValue({ type: "user", companyUuid: "c1", actorUuid: "u1" });
    getUserByUuid.mockResolvedValue({
      uuid: "u1",
      email: "a@b.c",
      name: "A",
      company: { uuid: "c1", name: "Co" },
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.user.uuid).toBe("u1");
    expect(json.data.company.uuid).toBe("c1");
  });

  it("401s with no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("401s and clears session cookies when the user row is gone", async () => {
    getAuthContext.mockResolvedValue({ type: "user", companyUuid: "c1", actorUuid: "gone" });
    getUserByUuid.mockResolvedValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(res.cookies.get("user_session")?.value).toBe("");
  });

  it("the probe path is INSIDE the middleware matcher (the reason this route exists)", () => {
    // Mirror of src/middleware.ts config.matcher.
    const MATCHER = "^/((?!_next|login|api/auth|skill|favicon\\.ico|.*\\.).*)$";
    expect(new RegExp(MATCHER).test("/api/session")).toBe(true);
  });
});

describe("DELETE /api/session", () => {
  it("logs out and clears session cookies", async () => {
    const res = await DELETE();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(res.cookies.get("user_session")?.value).toBe("");
  });
});
