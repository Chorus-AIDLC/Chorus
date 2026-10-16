import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { localAuth, makeLocalTx } from "@/services/__tests__/local-user.fixture";

const mocks = vi.hoisted(() => ({ db: { $transaction: vi.fn() }, superAdmin: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/super-admin", () => ({ getSuperAdminFromRequest: mocks.superAdmin }));
vi.mock("@/lib/user-session", () => ({ getUserSessionFromRequest: mocks.session }));
vi.mock("@/lib/api-key", () => ({ extractApiKey: vi.fn(), validateApiKey: vi.fn() }));
vi.mock("@/lib/oidc-auth", () => ({ isOidcToken: () => false, verifyOidcAccessToken: vi.fn() }));
vi.mock("@/lib/uuid-resolver", () => ({ isAssignmentOwnedByActor: vi.fn() }));
import { GET, POST } from "../route";

let fixture: ReturnType<typeof makeLocalTx>;
let auditReads: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
const root = { type: "super_admin", email: "root@example.com" };
const context = { params: Promise.resolve({ uuid: "tenant-a" }) };
const account = { username: " ALICE ", email: " ALICE@EXAMPLE.COM " };
function request(method: string, body?: unknown) {
  return new NextRequest("https://untrusted.example/api/admin/companies/tenant-a/initial-admin", {
    method, headers: { "content-type": "application/json", host: "evil.example" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function expectHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture = makeLocalTx();
  Object.assign(fixture.target, { status: "invited", passwordHash: null, workspaceAdmin: true });
  auditReads = {
    findMany: vi.fn().mockResolvedValue([{ targetUuid: fixture.target.uuid, action: "local_workspace_bootstrapped" }]),
    findFirst: vi.fn().mockResolvedValue(null),
  };
  Object.assign(fixture.tx.localUserAudit, auditReads);
  fixture.tx.user.create.mockImplementation(async ({ data }) => ({ ...fixture.target, ...data, uuid: "replacement-uuid" }));
  mocks.db.$transaction.mockImplementation(async (fn: (tx: typeof fixture.tx) => Promise<unknown>) => fn(fixture.tx));
  mocks.superAdmin.mockResolvedValue(root);
  mocks.session.mockResolvedValue(localAuth);
});

describe("superadmin initial admin setup route through real auth and service", () => {
  it.each(["GET", "POST"])("requires superadmin for %s even with human session or Agent bearer", async method => {
    mocks.superAdmin.mockResolvedValue(null);
    const req = request(method, method === "POST" ? { action: "revoke", expectedUserUuid: "target-a" } : undefined);
    req.headers.set("authorization", "Bearer cho_admin_agent");
    const response = await (method === "GET" ? GET : POST)(req, context);
    expect(response.status).toBe(401);
    expect(mocks.superAdmin).toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("GET returns the public principal/manageability contract with no cache", async () => {
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    expectHeaders(response);
    expect(await response.json()).toEqual({ success: true, data: { user: expect.objectContaining({ uuid: "target-a", status: "invited" }), manageable: true } });
    expect(auditReads.findMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", actorType: "super_admin", action: { in: expect.any(Array) } } });
    expect(fixture.tx.$queryRaw.mock.calls[0][1]).toBe("tenant-a");
  });
  it("GET reports active bootstrap as unmanageable, never offering reset", async () => {
    fixture.target.status = "active";
    const response = await GET(request("GET"), context);
    expect((await response.json()).data.manageable).toBe(false);
    expect((await POST(request("POST", { action: "reinvite", expectedUserUuid: "target-a" }), context)).status).toBe(409);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "   "])("POST replaces with optional/blank name %j and relative credential URL", async name => {
    const response = await POST(request("POST", { action: "replace", expectedUserUuid: "target-a", initialAdmin: { ...account, ...(name === undefined ? {} : { name }) } }), context);
    expect(response.status).toBe(200);
    expectHeaders(response);
    const body = await response.json();
    expect(body.data).toMatchObject({ user: { uuid: "replacement-uuid", workspaceAdmin: true }, manageable: true, credentialLink: { purpose: "invite" } });
    expect(body.data.credentialLink.url).toMatch(/^\/login\/local\/accept\?token=[A-Za-z0-9_-]{43}$/);
    expect(fixture.tx.user.create.mock.calls[0][0].data.name).toBeUndefined();
    for (const secret of ["passwordHash", "tokenHash", "sessionVersion", "oidcSub"]) expect(JSON.stringify(body)).not.toContain(secret);
  });
  it("POST reinvites and attributes its audit to the superadmin email", async () => {
    const response = await POST(request("POST", { action: "reinvite", expectedUserUuid: "target-a" }), context);
    expect(response.status).toBe(200);
    expectHeaders(response);
    expect((await response.json()).data).toMatchObject({ user: { uuid: "target-a" }, manageable: true, credentialLink: { purpose: "invite" } });
    expect(fixture.tx.localUserAudit.create).toHaveBeenCalledWith({ data: { companyUuid: "tenant-a", actorType: "super_admin", actorUuid: root.email, targetUuid: "target-a", action: "local_initial_admin_reinvited" } });
  });
  it("POST revokes with a null principal and no credentialLink", async () => {
    const response = await POST(request("POST", { action: "revoke", expectedUserUuid: "target-a" }), context);
    expect(response.status).toBe(200);
    expectHeaders(response);
    expect(await response.json()).toEqual({ success: true, data: { user: null, manageable: true } });
  });
  it("POST rejects stale clients and accepted state with conflict", async () => {
    expect((await POST(request("POST", { action: "revoke", expectedUserUuid: "stale" }), context)).status).toBe(409);
    auditReads.findFirst.mockResolvedValue({ action: "local_invite_accepted" });
    expect((await POST(request("POST", { action: "replace", expectedUserUuid: "target-a", initialAdmin: account }), context)).status).toBe(409);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])("rejects OIDC mode for %s", async method => {
    fixture.tx.company.findUnique.mockResolvedValue({ localAuthEnabled: true, oidcEnabled: true });
    const response = await (method === "GET" ? GET : POST)(request(method, method === "POST" ? { action: "revoke", expectedUserUuid: "target-a" } : undefined), context);
    expect(response.status).toBe(403);
    expect(auditReads.findMany).not.toHaveBeenCalled();
  });
  it("POST enforces strict union and malformed JSON before service writes", async () => {
    for (const body of [{ action: "reset", expectedUserUuid: "target-a" }, { action: "revoke", expectedUserUuid: "target-a", initialAdmin: account }, { action: "replace", expectedUserUuid: null, initialAdmin: { ...account, workspaceAdmin: true } }]) {
      expect((await POST(request("POST", body), context)).status).toBe(400);
    }
    expect((await POST(new NextRequest("https://example.test", { method: "POST", body: "{" }), context)).status).toBe(400);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
});
