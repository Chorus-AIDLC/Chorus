import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, createDirectoryRequest } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  createDirectoryRequest: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuthContext }));
vi.mock("@/services/project-agent-cwd.service", () => {
  class CwdServiceError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return { CwdServiceError, createDirectoryRequest };
});

import { POST } from "@/app/api/daemon-directory-requests/route";
import { CwdServiceError } from "@/services/project-agent-cwd.service";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/daemon-directory-requests", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const valid = {
  operation: "validate",
  agentUuid: "agent-1",
  targetConnectionUuid: "conn-1",
  cwd: "/work/repo",
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue({
    type: "user",
    companyUuid: "company-1",
    actorUuid: "user-1",
  });
});

describe("POST /api/daemon-directory-requests", () => {
  it("requires authentication and a human user", async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await POST(request(valid), { params: Promise.resolve({}) })).status).toBe(401);

    getAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: "company-1",
      actorUuid: "agent-1",
    });
    expect((await POST(request(valid), { params: Promise.resolve({}) })).status).toBe(403);
    expect(createDirectoryRequest).not.toHaveBeenCalled();
  });

  it("passes only authenticated tenant/user identity to the service", async () => {
    createDirectoryRequest.mockResolvedValue({ uuid: "request-1", status: "pending" });
    const response = await POST(request(valid), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(createDirectoryRequest).toHaveBeenCalledWith({
      companyUuid: "company-1",
      userUuid: "user-1",
      ...valid,
    });
  });

  it("accepts roots without forwarding a client-provided path", async () => {
    createDirectoryRequest.mockResolvedValue({ uuid: "roots-1", status: "pending" });
    const roots = {
      operation: "roots",
      agentUuid: "agent-1",
      targetConnectionUuid: "conn-1",
    };
    const response = await POST(request({ ...roots, prefix: "/client-root" }), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(200);
    expect(createDirectoryRequest).toHaveBeenCalledWith({
      companyUuid: "company-1",
      userUuid: "user-1",
      ...roots,
    });
  });

  it("returns stable typed failures and rejects malformed operations", async () => {
    createDirectoryRequest.mockRejectedValue(
      new CwdServiceError("HOST_OFFLINE", "Target host is offline"),
    );
    const offline = await POST(request(valid), { params: Promise.resolve({}) });
    expect(offline.status).toBe(409);
    expect((await offline.json()).error.code).toBe("HOST_OFFLINE");

    const invalid = await POST(
      request({ ...valid, operation: "unknown" }),
      { params: Promise.resolve({}) },
    );
    expect(invalid.status).toBe(422);
  });
});
