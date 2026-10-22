import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { localAuth, makeLocalTx, password, rawToken } from "@/services/__tests__/local-user.fixture";

const mocks = vi.hoisted(() => ({
  db: { $transaction: vi.fn(), user: { findFirst: vi.fn() } },
  session: vi.fn(), superAdmin: vi.fn(), apiKey: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/user-session", () => ({ getUserSessionFromRequest: mocks.session }));
vi.mock("@/lib/super-admin", () => ({ getSuperAdminFromRequest: mocks.superAdmin }));
vi.mock("@/lib/api-key", () => ({ extractApiKey: vi.fn(), validateApiKey: mocks.apiKey }));
vi.mock("@/lib/oidc-auth", () => ({ isOidcToken: () => false, verifyOidcAccessToken: vi.fn() }));
vi.mock("@/lib/uuid-resolver", () => ({ isAssignmentOwnedByActor: vi.fn() }));

// Routes, service, error handling and auth decorators are real. Only persistence
// and credential/session resolution are mocked, so service guards are exercised.
import { POST as bootstrap } from "@/app/api/admin/companies/local/route";
import { GET as list, POST as create } from "@/app/api/workspace/users/route";
import { PATCH as edit, DELETE as remove } from "@/app/api/workspace/users/[uuid]/route";
import { POST as credential } from "@/app/api/workspace/users/[uuid]/credentials/route";
import { POST as accept } from "@/app/api/auth/local/accept/route";
import { resetAuthThrottleForTests } from "@/lib/auth-throttle";

let fixture: ReturnType<typeof makeLocalTx>;
const context = { params: Promise.resolve({ uuid: "target-a" }) };
function request(method: string, body?: unknown, path = "/api/workspace/users", headers: Record<string, string> = {}) {
  return new NextRequest(`https://attacker.example${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const account = { username: " ALICE ", email: " Alice@example.com " };
function expectSecretHandoff(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAuthThrottleForTests();
  vi.stubEnv("APP_URL", "https://trusted.example");
  fixture = makeLocalTx();
  mocks.db.$transaction.mockImplementation(async (fn: (tx: typeof fixture.tx) => Promise<unknown>) => fn(fixture.tx));
  mocks.session.mockResolvedValue(localAuth);
  mocks.superAdmin.mockResolvedValue(null);
  mocks.apiKey.mockResolvedValue({ valid: false });
});
afterEach(() => vi.unstubAllEnvs());

describe('public credential acceptance throttling', () => {
  it('limits attempts before credential processing and does not expose token/account details', async () => {
    for (let i = 0; i < 10; i++) expect((await accept(request('POST', { token: 'invalid', password }, '/api/auth/local/accept'), context)).status).toBe(400);
    const response = await accept(request('POST', { token: 'invalid', password }, '/api/auth/local/accept'), context);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    const unrelated = await accept(request('POST', { token: rawToken, password }, '/api/auth/local/accept'), context);
    expect(unrelated.status).toBe(200);
    expectSecretHandoff(unrelated);
  });
});

describe("local workspace bootstrap route", () => {
  it("requires real SuperAdmin gate even when an ordinary human session exists", async () => {
    const response = await bootstrap(request("POST", { name: "Workspace", initialAdmin: account }), context);
    expect(response.status).toBe(401);
    expect(mocks.superAdmin).toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("returns a relative secret-safe handoff, independent of APP_URL, Host or forwarded headers", async () => {
    vi.stubEnv("APP_URL", "invalid URL");
    mocks.superAdmin.mockResolvedValue({ type: "super_admin", email: "root@example.com" });
    const response = await bootstrap(request("POST", { name: "Workspace", initialAdmin: account }, "/api/admin/companies/local", { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }), context);
    expect(response.status).toBe(200);
    expectSecretHandoff(response);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.user).toMatchObject({ username: "alice", email: "alice@example.com", workspaceAdmin: true, status: "invited" });
    expect(body.data.credentialLink.url).toMatch(/^\/login\/local\/accept\?token=/);
    expect(body.data.user).not.toHaveProperty("passwordHash");
    const raw = new URL(body.data.credentialLink.url, "https://browser.example").searchParams.get("token")!;
    expect(JSON.stringify(fixture.tx.localUserAudit.create.mock.calls)).not.toContain(raw);
  });
  it("invalid bootstrap input creates no workspace", async () => {
    mocks.superAdmin.mockResolvedValue({ type: "super_admin", email: "root@example.com" });
    const response = await bootstrap(request("POST", { name: "Workspace", initialAdmin: { username: "bad@name", email: "bad" } }), context);
    expect(response.status).toBe(400);
    expect(fixture.tx.company.create).not.toHaveBeenCalled();
  });
});

describe("workspace users routes through real service guards", () => {
  it.each(["list", "create", "edit", "remove", "credential"])("unauthenticated caller cannot %s", async action => {
    mocks.session.mockResolvedValue(null);
    const response = action === "list" ? await list(request("GET"), context) : action === "create" ? await create(request("POST", account), context) : action === "edit" ? await edit(request("PATCH", { name: "Changed" }), context) : action === "remove" ? await remove(request("DELETE"), context) : await credential(request("POST", { purpose: "reset" }), context);
    expect(response.status).toBe(401);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("Agent API-key authentication cannot list/manage workspace users even with admin permissions", async () => {
    mocks.apiKey.mockResolvedValue({ valid: true, agent: { uuid: "agent-a", companyUuid: "tenant-a", name: "Agent", roles: ["admin_agent"], permissions: [], ownerUuid: "admin-a" } });
    const response = await list(request("GET", undefined, "/api/workspace/users", { authorization: "Bearer cho_test" }), context);
    expect(response.status).toBe(403);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it.each([{ workspaceAdmin: false }, { status: "disabled" }, { authType: "oidc" }])("rejects non-admin/inactive/SSO actor %j", async patch => {
    Object.assign(fixture.actor, patch);
    const response = await create(request("POST", account), context);
    expect(response.status).toBe(403);
    expect(fixture.tx.user.create).not.toHaveBeenCalled();
  });
  it("GET returns paginated DTOs without hashes and no-store", async () => {
    const response = await list(request("GET", undefined, "/api/workspace/users?page=2&pageSize=10"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("passwordHash");
    expect(body.data[0]).not.toHaveProperty("sessionVersion");
    expect(fixture.tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  });
  it("GET rejects invalid pagination without hitting database", async () => {
    const response = await list(request("GET", undefined, "/api/workspace/users?page=NaN&pageSize=101"), context);
    expect(response.status).toBe(400);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("POST creates normalized invited user with secret handoff headers", async () => {
    const response = await create(request("POST", account), context);
    expect(response.status).toBe(200);
    expectSecretHandoff(response);
    const body = await response.json();
    expect(body.data.user).toMatchObject({ username: "alice", email: "alice@example.com", status: "invited" });
    expect(body.data.credentialLink.purpose).toBe("invite");
  });
  it("PATCH invalidates stale links, respects target UUID and returns secret-safe DTO", async () => {
    const response = await edit(request("PATCH", { status: "disabled" }), context);
    expect(response.status).toBe(200);
    expectSecretHandoff(response);
    expect((await response.json()).data.user.status).toBe("disabled");
    expect(fixture.tx.user.update).toHaveBeenCalledWith({ where: { uuid: "target-a" }, data: expect.objectContaining({ sessionVersion: { increment: 1 }, status: "disabled" }) });
  });
  it("DELETE retains tombstone UUID and clears password eligibility", async () => {
    const response = await remove(request("DELETE"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.user).toMatchObject({ uuid: "target-a", status: "deleted", workspaceAdmin: false });
    expect(body.data.user).not.toHaveProperty("passwordHash");
    expect(fixture.tx.user.update).toHaveBeenCalledWith({ where: { uuid: "target-a" }, data: expect.objectContaining({ deletedAt: expect.any(Date), passwordHash: null }) });
  });
  it("PATCH cannot remove last admin, returns conflict and performs no edit", async () => {
    fixture.target.workspaceAdmin = true;
    fixture.tx.user.count.mockResolvedValue(0);
    const response = await edit(request("PATCH", { workspaceAdmin: false }), context);
    expect(response.status).toBe(409);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("foreign UUID is not found rather than leaking target tenant", async () => {
    fixture.tx.user.findFirst.mockResolvedValueOnce(fixture.actor).mockResolvedValueOnce(null);
    const response = await remove(request("DELETE"), { params: Promise.resolve({ uuid: "foreign-uuid" }) });
    expect(response.status).toBe(404);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("credentials POST returns version-bound reset link with secret-safe headers", async () => {
    const response = await credential(request("POST", { purpose: "reset" }), context);
    expect(response.status).toBe(200);
    expectSecretHandoff(response);
    expect((await response.json()).data.credentialLink.purpose).toBe("reset");
    expect(fixture.tx.userCredentialToken.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sessionVersion: 4 }) });
  });
  it("credentials POST refuses disabled resets and malformed purpose", async () => {
    fixture.target.status = "disabled";
    expect((await credential(request("POST", { purpose: "reset" }), context)).status).toBe(400);
    expect((await credential(request("POST", { purpose: "activate" }), context)).status).toBe(400);
    expect(fixture.tx.userCredentialToken.create).not.toHaveBeenCalled();
  });
  it("malformed JSON is handled without transaction or reflecting raw secrets", async () => {
    const response = await create(new NextRequest("https://trusted.example/api/workspace/users", { method: "POST", body: '{"password":"sensitive' }), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
});

describe("public local credential acceptance route", () => {
  it("accepts body token without session creation or cookie, regardless of authentication", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await accept(request("POST", { token: rawToken, password }, "/api/auth/local/accept"), context);
    expect(response.status).toBe(200);
    expectSecretHandoff(response);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ success: true, data: { accepted: true } });
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.superAdmin).not.toHaveBeenCalled();
  });
  it("query token is not accepted in place of body token", async () => {
    const response = await accept(request("POST", { password }, `/api/auth/local/accept?token=${rawToken}`), context);
    expect(response.status).toBe(400);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it("bad password leaves token unconsumed and errors never reflect it", async () => {
    const response = await accept(request("POST", { token: rawToken, password: "short" }), context);
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(rawToken);
    expect(body).not.toContain("short");
    expect(fixture.tx.userCredentialToken.updateMany).not.toHaveBeenCalled();
  });
  it("replay/expired link is a generic error with no secret material", async () => {
    fixture.token.expiresAt = new Date(0);
    const response = await accept(request("POST", { token: rawToken, password }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: { code: "BAD_REQUEST", message: "Invalid or expired credential link" } });
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("late DB error cannot expose password, token, or query arguments in API response", async () => {
    fixture.tx.user.update.mockRejectedValue(new Error(`Prisma data: ${password} ${rawToken}`));
    const response = await accept(request("POST", { token: rawToken, password }), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Local account operation failed" } });
  });
});
