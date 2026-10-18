import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findFirst: mocks.user } } }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth }));
import { GET } from "../route";
const request = () => new NextRequest("http://localhost/api/auth/me");
beforeEach(() => vi.resetAllMocks());
describe("authenticated current-user projection", () => {
  it.each([null, { type: "agent" }])("rejects absent/nonhuman authentication %j", async auth => {
    mocks.auth.mockResolvedValue(auth);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("only queries the verified user and tenant and exposes local management projection", async () => {
    mocks.auth.mockResolvedValue({ type: "user", actorUuid: "user-a", companyUuid: "tenant-a" });
    mocks.user.mockResolvedValue({ uuid: "user-a", email: "a@example.com", name: "A", authType: "local", workspaceAdmin: true, company: { uuid: "tenant-a", name: "A", localAuthEnabled: true } });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mocks.user).toHaveBeenCalledWith(expect.objectContaining({ where: { uuid: "user-a", companyUuid: "tenant-a" } }));
    expect((await res.json()).data).toEqual({ user: { uuid: "user-a", email: "a@example.com", name: "A", authType: "local", workspaceAdmin: true }, company: { uuid: "tenant-a", name: "A", localAuthEnabled: true } });
  });
  it("does not elevate legacy SSO accounts", async () => {
    mocks.auth.mockResolvedValue({ type: "user", actorUuid: "a", companyUuid: "b" });
    mocks.user.mockResolvedValue({ uuid: "a", authType: "oidc", workspaceAdmin: true, company: { uuid: "b", localAuthEnabled: false } });
    expect((await (await GET(request())).json()).data.user.workspaceAdmin).toBe(false);
  });
  it("includes the saved avatar seed without exposing credentials", async () => {
    mocks.auth.mockResolvedValue({ type: "user", actorUuid: "a", companyUuid: "b" });
    mocks.user.mockResolvedValue({ uuid: "a", avatarSeed: "639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc", passwordHash: "private", authType: "local", company: { uuid: "b" } });
    const user = (await (await GET(request())).json()).data.user;
    expect(user.avatarSeed).toBe("639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc");
    expect(user).not.toHaveProperty("passwordHash");
    expect(mocks.user).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ avatarSeed: true }) }));
  });
  it("rejects a disappeared user", async () => {
    mocks.auth.mockResolvedValue({ type: "user", actorUuid: "a", companyUuid: "b" });
    mocks.user.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
  });
});
