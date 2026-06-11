import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockIsDefaultAuthEnabled = vi.hoisted(() => vi.fn());
const mockGetDefaultUserEmail = vi.hoisted(() => vi.fn());
const mockIsSuperAdminEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/default-auth", () => ({
  isDefaultAuthEnabled: mockIsDefaultAuthEnabled,
  getDefaultUserEmail: mockGetDefaultUserEmail,
}));
vi.mock("@/lib/super-admin", () => ({
  isSuperAdminEmail: mockIsSuperAdminEmail,
}));

import { GET } from "@/app/api/auth/check-default/route";

function makeRequest(): NextRequest {
  return new NextRequest(
    new URL("http://localhost:3000/api/auth/check-default"),
    { method: "GET" }
  );
}

const emptyCtx = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsDefaultAuthEnabled.mockReturnValue(false);
  mockGetDefaultUserEmail.mockReturnValue(null);
  mockIsSuperAdminEmail.mockReturnValue(false);
});

describe("GET /api/auth/check-default", () => {
  it("reports enabled=false and no collision when default auth is disabled", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(false);

    const res = await GET(makeRequest(), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: false, superAdminCollision: false });
    // When disabled we never consult the super-admin predicate for a collision.
    expect(mockIsSuperAdminEmail).not.toHaveBeenCalled();
  });

  it("reports collision=true when default auth is enabled and the default user is the super admin", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("root@example.com");
    mockIsSuperAdminEmail.mockReturnValue(true);

    const res = await GET(makeRequest(), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: true, superAdminCollision: true });
    // The collision check delegates to the unchanged super-admin predicate,
    // and the email is never echoed back in the payload.
    expect(mockIsSuperAdminEmail).toHaveBeenCalledWith("root@example.com");
    expect(JSON.stringify(json.data)).not.toContain("root@example.com");
  });

  it("reports collision=false when default auth is enabled but the default user is not the super admin", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue("dev@example.com");
    mockIsSuperAdminEmail.mockReturnValue(false);

    const res = await GET(makeRequest(), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: true, superAdminCollision: false });
  });

  it("reports collision=false when default auth is enabled but the default user email is null", async () => {
    mockIsDefaultAuthEnabled.mockReturnValue(true);
    mockGetDefaultUserEmail.mockReturnValue(null);

    const res = await GET(makeRequest(), emptyCtx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: true, superAdminCollision: false });
    // A null default email short-circuits before the super-admin predicate.
    expect(mockIsSuperAdminEmail).not.toHaveBeenCalled();
  });
});
