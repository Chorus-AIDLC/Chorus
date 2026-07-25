import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockTouchConnection = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-connection.service", () => ({
  touchConnection: (...args: unknown[]) => mockTouchConnection(...args),
}));

import { POST } from "@/app/api/daemon/connection-heartbeat/route";

const companyUuid = "company-1";
const agentUuid = "agent-1";
const connectionUuid = "connection-1";
const connectedAt = "2026-07-25T08:00:00.000Z";
const emptyCtx = { params: Promise.resolve({}) };

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/daemon/connection-heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    type: "agent",
    companyUuid,
    actorUuid: agentUuid,
    permissions: [],
  });
  mockTouchConnection.mockResolvedValue(true);
});

describe("POST /api/daemon/connection-heartbeat", () => {
  it("acknowledges the authenticated agent's active generation", async () => {
    const res = await POST(request({ connectionUuid, connectedAt }), emptyCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { acknowledged: true },
      meta: undefined,
    });
    expect(mockTouchConnection).toHaveBeenCalledWith(
      companyUuid,
      { uuid: connectionUuid, connectedAt: new Date(connectedAt) },
      agentUuid,
    );
  });

  it("rejects unauthenticated and non-daemon callers without touching", async () => {
    mockGetAuthContext.mockResolvedValueOnce(null);
    expect((await POST(request({ connectionUuid, connectedAt }), emptyCtx)).status).toBe(401);

    mockGetAuthContext.mockResolvedValueOnce({
      type: "user",
      companyUuid,
      actorUuid: "owner-1",
    });
    expect((await POST(request({ connectionUuid, connectedAt }), emptyCtx)).status).toBe(401);
    expect(mockTouchConnection).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { connectionUuid },
    { connectedAt },
    { connectionUuid: "", connectedAt },
    { connectionUuid, connectedAt: "not-a-date" },
  ])("rejects malformed payload %#", async (body) => {
    const res = await POST(request(body), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockTouchConnection).not.toHaveBeenCalled();
  });

  it("returns non-disclosing 404 for another owner, company, or obsolete generation", async () => {
    mockTouchConnection.mockResolvedValue(false);
    const res = await POST(request({ connectionUuid, connectedAt }), emptyCtx);

    expect(res.status).toBe(404);
    expect(mockTouchConnection).toHaveBeenCalledWith(
      companyUuid,
      { uuid: connectionUuid, connectedAt: new Date(connectedAt) },
      agentUuid,
    );
  });
});
