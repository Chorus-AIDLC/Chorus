import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockCreate = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  hasPermission: (auth: { permissions?: string[] }, perm: string) => auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: () => null,
}));

vi.mock("@/lib/prisma", () => ({ prisma: { projectGroup: { findFirst: vi.fn() } } }));

vi.mock("@/services/project-agent-cwd.service", () => ({
  createProjectWithAgentCwds: (...args: unknown[]) => mockCreate(...args),
  CwdServiceError: class CwdServiceError extends Error {},
}));

import { POST } from "@/app/api/projects/route";

const companyUuid = "company-1";
const now = new Date("2026-10-01T00:00:00Z");

function post(body: unknown) {
  return POST(
    new NextRequest(new URL("/api/projects", "http://localhost:3000"), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({}) },
  );
}

describe("POST /api/projects — access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ uuid: "p-new", name: "N", description: null, createdAt: now, updatedAt: now });
  });

  it("user creator becomes createdByUuid; visibility defaults to public", async () => {
    mockGetAuthContext.mockResolvedValue({ type: "user", companyUuid, actorUuid: "u-1" });
    const res = await post({ name: "N" });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      visibility: "public",
      createdByUuid: "u-1",
      actor: { type: "user", uuid: "u-1" },
    }));
  });

  it("agent creator records its owner as createdByUuid", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent", companyUuid, actorUuid: "a-1", ownerUuid: "u-owner", permissions: ["project:write"],
    });
    await post({ name: "N", visibility: "private" });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      visibility: "private",
      createdByUuid: "u-owner",
      actor: { type: "agent", uuid: "a-1" },
    }));
  });

  it("rejects invalid visibility", async () => {
    mockGetAuthContext.mockResolvedValue({ type: "user", companyUuid, actorUuid: "u-1" });
    const res = await post({ name: "N", visibility: "secret" });
    expect(res.status).toBe(422);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an ownerless agent creating a private project", async () => {
    mockGetAuthContext.mockResolvedValue({ type: "agent", companyUuid, actorUuid: "a-1", permissions: ["project:write"] });
    const res = await post({ name: "N", visibility: "private" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
