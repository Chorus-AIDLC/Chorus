import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { decodeJwt } from "jose";

const db = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, apiKey: { findUnique: vi.fn(), update: vi.fn() }, project: { findFirst: vi.fn() }, projectMember: { findUnique: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { POST as login } from "@/app/api/auth/local/login/route";
import { createUserAccessToken, getUserSessionFromRequest, resolveUserSession } from "../user-session";
import { validateApiKey } from "../api-key";
import { getAuthContext } from "../auth";
import { resetAuthThrottleForTests, throttleAuth } from "../auth-throttle";
import { makeLocalUser, password } from "@/services/__tests__/local-user.fixture";

const companyUuid = "00000000-0000-4000-8000-000000000001";
const userUuid = "00000000-0000-4000-8000-000000000002";
const passwordHash = await bcrypt.hash(password, 12);
let account: ReturnType<typeof makeLocalUser> & { company: { localAuthEnabled: boolean; oidcEnabled: boolean } };
const ctx = { params: Promise.resolve({}) };
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/auth/local/login", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
}
const payload = () => ({ type: "user" as const, userUuid, companyUuid, email: account.email!, oidcSub: account.oidcSub, authType: "local" as const, sessionVersion: account.sessionVersion });
beforeEach(() => {
  vi.resetAllMocks(); resetAuthThrottleForTests();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-for-local-auth");
  vi.stubEnv("AUTH_TRUST_PROXY", "false");
  vi.stubEnv("COOKIE_SECURE", "true");
  account = { ...makeLocalUser({ uuid: userUuid, companyUuid, passwordHash }), company: { localAuthEnabled: true, oidcEnabled: false } };
  db.user.findFirst.mockImplementation(async ({ where }) => {
    if (where.companyUuid !== account.companyUuid || (where.uuid && where.uuid !== account.uuid)) return null;
    if (where.username && where.username !== account.username) return null;
    if (where.localEmail && where.localEmail !== account.localEmail) return null;
    if (where.authType && where.authType !== account.authType) return null;
    if (where.company && (!account.company.localAuthEnabled || account.company.oidcEnabled)) return null;
    return account;
  });
  db.apiKey.update.mockResolvedValue({});
  db.apiKey.findUnique.mockResolvedValue({ uuid: "key", revokedAt: null, expiresAt: null, agent: { uuid: "agent", name: "A", companyUuid, ownerUuid: userUuid, roles: ["developer_agent"], permissions: ["project:admin"] } });
});
afterEach(() => vi.unstubAllEnvs());

describe("local login credential and JWT integration", () => {
  it.each([" ALICE ", "ALICE@EXAMPLE.COM"])("normalizes %s and issues a bounded HttpOnly version-bound session", async identifier => {
    const res = await login(request({ companyUuid, identifier, password }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.user).toMatchObject({ uuid: userUuid, companyUuid, workspaceAdmin: false });
    const cookie = res.cookies.get("user_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, maxAge: 3600, sameSite: "lax" });
    const claims = decodeJwt(cookie.value);
    expect(claims).toMatchObject({ authType: "local", sessionVersion: 3 });
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(res.cookies.get("oidc_access_token")?.maxAge).toBe(0);
    expect(await getUserSessionFromRequest(new NextRequest("http://localhost", { headers: { cookie: `user_session=${cookie.value}` } }))).toMatchObject({ actorUuid: userUuid, authType: "local", workspaceAdmin: false });
  });
  it.each(["invited", "disabled", "deleted"])("rejects %s with the same generic credential failure", async status => {
    account.status = status;
    const res = await login(request({ companyUuid, identifier: "alice", password }), ctx);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid credentials");
    expect(res.cookies.get("user_session")).toBeUndefined();
  });
  it.each(["wrong-tenant", "wrong-password", "unknown", "sso", "deleted-at"])("fails closed for %s", async variant => {
    if (variant === "sso") account.company = { localAuthEnabled: false, oidcEnabled: true };
    if (variant === "deleted-at") account.deletedAt = new Date();
    const res = await login(request({ companyUuid: variant === "wrong-tenant" ? "00000000-0000-4000-8000-000000000099" : companyUuid, identifier: variant === "unknown" ? "unknown" : "alice", password: variant === "wrong-password" ? "another-valid-password" : password }), ctx);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid credentials");
  });
  it("throttles repeated login identity before further credential checks", async () => {
    for (let i = 0; i < 10; i++) expect((await login(request({ companyUuid, identifier: "unknown", password }), ctx)).status).toBe(401);
    const response = await login(request({ companyUuid, identifier: "unknown", password }), ctx);
    expect(response.status).toBe(429);
    expect(db.user.findFirst).toHaveBeenCalledTimes(10);
  }, 15_000);
  it("malformed login attempts do not block another valid local account", async () => {
    for (let i = 0; i < 35; i++) expect((await login(request({}), ctx)).status).toBe(401);
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect((await login(request({ companyUuid, identifier: "alice", password }), ctx)).status).toBe(200);
  });
  it("rejects malformed input without exposing validation distinctions", async () => {
    expect((await login(request({ companyUuid, identifier: {}, password }), ctx)).status).toBe(401);
  });
});

describe("per-request session revocation", () => {
  it.each(["reset", "role-change", "disabled", "deleted", "missing", "tenant-change"])("rejects old cookie and Bearer after %s", async mutation => {
    const token = await createUserAccessToken(payload());
    if (mutation === "reset" || mutation === "role-change") account.sessionVersion++;
    if (mutation === "disabled") account.status = "disabled";
    if (mutation === "deleted") account.deletedAt = new Date();
    if (mutation === "missing") db.user.findFirst.mockResolvedValue(null);
    if (mutation === "tenant-change") account.companyUuid = "other";
    const headerOptions: Record<string, string>[] = [{ authorization: `Bearer ${token}` }, { cookie: `user_session=${token}` }];
    for (const headers of headerOptions) {
      expect(await getAuthContext(new NextRequest("http://localhost", { headers }))).toBeNull();
    }
  });
  it("rejects local tokens without generation or local marker", async () => {
    expect(await resolveUserSession({ ...payload(), sessionVersion: undefined })).toBeNull();
    expect(await resolveUserSession({ ...payload(), authType: undefined })).toBeNull();
  });
  it("uses current DB profile and privilege, not token claims", async () => {
    const token = await createUserAccessToken(payload());
    account.workspaceAdmin = true; account.name = "Current name";
    expect(await getUserSessionFromRequest(new NextRequest("http://localhost", { headers: { authorization: `Bearer ${token}` } }))).toMatchObject({ name: "Current name", workspaceAdmin: true });
  });
  it("rejects forged signature and expired tokens", async () => {
    const token = await createUserAccessToken(payload());
    const [header, body] = token.split(".");
    expect(await getAuthContext(new NextRequest("http://localhost", { headers: { authorization: `Bearer ${header}.${body}.forged` } }))).toBeNull();
    const expired = await createUserAccessToken(payload(), "-1s");
    expect(await getAuthContext(new NextRequest("http://localhost", { headers: { cookie: `user_session=${expired}` } }))).toBeNull();
  });
  it("preserves legitimate legacy sessions but does not elevate them or route them into local tenants", async () => {
    account.authType = "oidc"; account.workspaceAdmin = true;
    account.company = { localAuthEnabled: false, oidcEnabled: false };
    expect(await resolveUserSession({ ...payload(), authType: undefined, sessionVersion: undefined })).toMatchObject({ workspaceAdmin: false });
    account.company.localAuthEnabled = true;
    expect(await resolveUserSession({ ...payload(), authType: undefined })).toBeNull();
  });
});

describe("central owned Agent key eligibility and permission preservation", () => {
  it.each(["missing", "cross-tenant", "invited", "disabled", "deleted"])("rejects %s owner for shared API-key and REST auth", async variant => {
    if (variant === "missing") db.user.findFirst.mockResolvedValue(null);
    if (variant === "cross-tenant") account.companyUuid = "other";
    if (["invited", "disabled", "deleted"].includes(variant)) account.status = variant;
    expect((await validateApiKey("cho_test")).valid).toBe(false);
    expect(await getAuthContext(new NextRequest("http://localhost", { headers: { authorization: "Bearer cho_test" } }))).toBeNull();
    expect(db.apiKey.update).not.toHaveBeenCalled();
  });
  it("retains ordinary owner's preset/custom business permissions without human admin privilege", async () => {
    const auth = await getAuthContext(new NextRequest("http://localhost", { headers: { authorization: "Bearer cho_test" } }));
    expect(auth).toMatchObject({ type: "agent", ownerUuid: userUuid });
    expect(auth && "permissions" in auth ? auth.permissions : []).toEqual(expect.arrayContaining(["idea:read", "task:write", "project:admin"]));
    expect(auth).not.toHaveProperty("workspaceAdmin");
    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { uuid: userUuid, companyUuid } }));
  });
  it("does not permanently destroy owner keys on password-only reset", async () => {
    account.sessionVersion++;
    expect((await validateApiKey("cho_test")).valid).toBe(true);
  });
  it("leaves unowned agents unchanged", async () => {
    const key = await db.apiKey.findUnique(); key.agent.ownerUuid = null;
    db.apiKey.findUnique.mockResolvedValue(key);
    expect((await validateApiKey("cho_test")).valid).toBe(true);
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("bounded authentication throttling", () => {
  it.each(["identify", "login", "accept"] as const)("limits repeated %s identities despite spoofed untrusted addresses", action => {
    const limit = action === "identify" ? 30 : 10;
    for (let i = 0; i < limit; i++) expect(throttleAuth(request({}, { "x-forwarded-for": `spoof-${i}` }), action, "same-identity")).toBeNull();
    const blocked = throttleAuth(request({}), action, "same-identity")!;
    expect(blocked.status).toBe(429); expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(throttleAuth(request({}), action, "another-identity")).toBeNull();
  });
  it("expires buckets and allows independent trusted-proxy clients", () => {
    vi.useFakeTimers(); vi.stubEnv("AUTH_TRUST_PROXY", "true");
    try {
      const a = request({}, { "x-forwarded-for": "198.51.100.1, 203.0.113.1" });
      for (let i = 0; i < 10; i++) expect(throttleAuth(a, "login", "alice")).toBeNull();
      expect(throttleAuth(a, "login", "alice")?.status).toBe(429);
      expect(throttleAuth(request({}, { "x-forwarded-for": "198.51.100.1, 203.0.113.2" }), "login", "alice")).toBeNull();
      vi.advanceTimersByTime(60_001);
      expect(throttleAuth(a, "login", "alice")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("bounds storage without denying unrelated trusted clients at capacity", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "true");
    for (let i = 0; i < 5000; i++) expect(throttleAuth(request({}, { "x-forwarded-for": `192.0.${Math.floor(i / 256)}.${i % 256}` }), "login", "alice")).toBeNull();
    expect(throttleAuth(request({}, { "x-forwarded-for": "203.0.113.1" }), "login", "alice")).toBeNull();
  });
});
