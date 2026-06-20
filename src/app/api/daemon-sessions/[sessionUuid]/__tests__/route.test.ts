import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockGetSessionDetail = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-session.service", () => ({
  getSessionDetail: (...args: unknown[]) => mockGetSessionDetail(...args),
}));

import { GET } from "@/app/api/daemon-sessions/[sessionUuid]/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const sessionUuid = "sess-0000-0000-0000-000000000001";

const detail = {
  session: { uuid: sessionUuid, sessionId: "sid", directIdeaUuid: null },
  turns: [],
  hasMore: false,
  oldestSeq: null,
};

function req(query = ""): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/daemon-sessions/${sessionUuid}${query}`),
  );
}
const ctx = { params: Promise.resolve({ sessionUuid }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockGetSessionDetail.mockResolvedValue(detail);
});

describe("GET /api/daemon-sessions/[sessionUuid]", () => {
  it("401 + no read when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mockGetSessionDetail).not.toHaveBeenCalled();
  });

  it("404 (non-disclosure) when the service returns null", async () => {
    mockGetSessionDetail.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("returns the detail envelope and defaults to the newest page (no cursor)", async () => {
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: detail, meta: undefined });
    // No query params → beforeSeq null, no limit forwarded.
    expect(mockGetSessionDetail).toHaveBeenCalledWith(userAuth, sessionUuid, {
      beforeSeq: null,
    });
  });

  it("parses ?beforeSeq + ?limit and forwards them to the service", async () => {
    await GET(req("?beforeSeq=12&limit=10"), ctx);
    expect(mockGetSessionDetail).toHaveBeenCalledWith(userAuth, sessionUuid, {
      beforeSeq: 12,
      limit: 10,
    });
  });

  it("ignores a non-numeric beforeSeq (falls back to the newest page)", async () => {
    await GET(req("?beforeSeq=abc"), ctx);
    expect(mockGetSessionDetail).toHaveBeenCalledWith(userAuth, sessionUuid, {
      beforeSeq: null,
    });
  });
});
