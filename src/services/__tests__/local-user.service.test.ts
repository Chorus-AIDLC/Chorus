import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperAdminAuthContext } from "@/types/auth";
import { localAuth, makeLocalTx, makeLocalUser, password, rawToken } from "./local-user.fixture";

const db = vi.hoisted(() => ({ $transaction: vi.fn(), user: { findFirst: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
const publishAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/account-access-events", () => ({ publishAccountAccessChanged: publishAccess }));
import * as service from "@/services/local-user.service";

let fixture: ReturnType<typeof makeLocalTx>;
const root: SuperAdminAuthContext = { type: "super_admin", email: "root@example.com" };
const account = { username: " ALICE ", email: " Alice@Example.COM ", name: " Alice " };
const bootstrap = { name: "New workspace", initialAdmin: account };
const accept = () => service.acceptLocalCredential({ token: rawToken, password });
const expectStatus = (promise: Promise<unknown>, status: number) => expect(promise).rejects.toMatchObject({ status });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_URL", "https://chorus.example.com/base-path");
  fixture = makeLocalTx();
  db.$transaction.mockImplementation(async (fn: (tx: typeof fixture.tx) => Promise<unknown>) => fn(fixture.tx));
});
afterEach(() => vi.unstubAllEnvs());

function expectLocked() {
  const { tx } = fixture;
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  const [sql, tenant] = tx.$queryRaw.mock.calls[0];
  expect(sql.join("?")).toContain('SELECT "uuid" FROM "Company" WHERE "uuid" = ? FOR UPDATE');
  expect(tenant).toBe(localAuth.companyUuid);
  expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.company.findUnique.mock.invocationCallOrder[0]);
  expect(tx.company.findUnique.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findFirst.mock.invocationCallOrder[0]);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15000 });
}
function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of ["passwordHash", "tokenHash", "oidcSub", "sessionVersion", "existing-secret-hash", password]) expect(serialized).not.toContain(secret);
}

describe("suspended invitation recovery", () => {
  it("re-enables a passwordless invitation safely and requires a fresh single-use link", async () => {
    const { tx, target, token } = fixture;
    Object.assign(target, { status: "invited", passwordHash: null });
    Object.assign(token, { purpose: "invite", tokenHash: createHash("sha256").update(rawToken).digest("hex") });
    let storedToken: (Omit<typeof token, "usedAt"> & { usedAt: Date | null }) | null = token;
    tx.user.update.mockImplementation(async ({ data }) => {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (key === "sessionVersion") target.sessionVersion += (value as { increment: number }).increment;
        else Object.assign(target, { [key]: value });
      }
      return { ...target };
    });
    tx.userCredentialToken.deleteMany.mockImplementation(async ({ where }) => {
      if (!where.uuid || storedToken?.uuid !== where.uuid.not) storedToken = null;
      return { count: 1 };
    });
    tx.userCredentialToken.create.mockImplementation(async ({ data }) => {
      storedToken = { ...data, uuid: "fresh-token", usedAt: null };
      return storedToken;
    });
    tx.userCredentialToken.findUnique.mockImplementation(async ({ where }) => storedToken?.tokenHash === where.tokenHash ? storedToken : null);
    tx.userCredentialToken.updateMany.mockImplementation(async () => {
      if (!storedToken || storedToken.usedAt) return { count: 0 };
      storedToken.usedAt = new Date();
      return { count: 1 };
    });

    expect((await service.updateLocalUser(localAuth, target.uuid, { status: "disabled" })).user.status).toBe("disabled");
    await expectStatus(accept(), 400);
    const recovered = await service.updateLocalUser(localAuth, target.uuid, { status: "active" });
    expect(recovered.user.status).toBe("invited");
    expect(target.passwordHash).toBeNull();
    const freshToken = new URL(recovered.credentialLink!.url, "https://browser.example").searchParams.get("token")!;
    expect(freshToken).not.toBe(rawToken);
    await expectStatus(accept(), 400);
    await expect(service.acceptLocalCredential({ token: freshToken, password })).resolves.toEqual({ accepted: true });
    expect(target.status).toBe("active");
    expect(await bcrypt.compare(password, target.passwordHash!)).toBe(true);
    await expectStatus(service.acceptLocalCredential({ token: freshToken, password }), 400);
  });
});

describe("committed lifecycle access-change publication", () => {
  it.each(["update", "remove", "reset", "accept"])("publishes %s only after the transaction commits", async operation => {
    let committed = false;
    db.$transaction.mockImplementation(async (fn: (tx: typeof fixture.tx) => Promise<unknown>) => {
      const result = await fn(fixture.tx);
      expect(publishAccess).not.toHaveBeenCalled();
      committed = true;
      return result;
    });
    publishAccess.mockImplementation(() => { expect(committed).toBe(true); });
    if (operation === "update") await service.updateLocalUser(localAuth, "target-a", { status: "disabled" });
    if (operation === "remove") await service.removeLocalUser(localAuth, "target-a");
    if (operation === "reset") await service.issueLocalUserCredential(localAuth, "target-a", { purpose: "reset" });
    if (operation === "accept") await accept();
    expect(publishAccess).toHaveBeenCalledExactlyOnceWith({ companyUuid: "tenant-a", userUuid: "target-a" });
  });
  it.each(["update", "remove", "reset", "accept"])("never publishes rolled-back %s", async operation => {
    fixture.tx.localUserAudit.create.mockRejectedValue(new Error("audit failed"));
    const work = operation === "update" ? service.updateLocalUser(localAuth, "target-a", { status: "disabled" }) :
      operation === "remove" ? service.removeLocalUser(localAuth, "target-a") :
      operation === "reset" ? service.issueLocalUserCredential(localAuth, "target-a", { purpose: "reset" }) : accept();
    await expectStatus(work, 500);
    expect(publishAccess).not.toHaveBeenCalled();
  });
});

describe("local identity and password contracts", () => {
  it("normalizes username/email and returns only an explicit public DTO", () => {
    expect(service.normalizeLocalUsername(account.username)).toBe("alice");
    expect(service.normalizeLocalEmail(account.email)).toBe("alice@example.com");
    const dto = service.publicLocalUser(makeLocalUser());
    expect(dto).toEqual({ uuid: "target-a", companyUuid: "tenant-a", username: "alice", email: "alice@example.com", name: "Alice", workspaceAdmin: false, status: "active", createdAt: "2026-10-15T00:00:00.000Z" });
    expectNoSecrets(dto);
  });
  it.each([null, "ab", "@alice", "alice@example.com", "汉字用户", "a".repeat(65), "-alice", "ali ce"])("rejects invalid username %j", value => {
    expect(() => service.normalizeLocalUsername(value)).toThrow();
  });
  it.each([null, "not-email", "a@", `${"a".repeat(250)}@example.com`])("rejects invalid email %j", value => {
    expect(() => service.normalizeLocalEmail(value)).toThrow();
  });
  it.each([null, "a".repeat(7), "a".repeat(73), "界".repeat(25), "😀".repeat(19), "😀".repeat(7)])("rejects unsafe password %j", value => {
    expect(() => service.validateLocalPassword(value)).toThrow();
  });
  it.each(["a".repeat(8), "a".repeat(72), "界".repeat(8), "界".repeat(24), "😀".repeat(8), "😀".repeat(18)])("allows safe UTF-8 password boundaries %j", value => {
    expect(() => service.validateLocalPassword(value)).not.toThrow();
  });
  it.each([{}, { ...account, password }, { ...account, username: "bad@user" }, { ...account, workspaceAdmin: "true" }])("invalid create input never starts a transaction %j", async input => {
    await expectStatus(service.createLocalUser(localAuth, input), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("eight-character credential acceptance", () => {
  it.each(["invite", "reset"])("accepts an eight-character password for %s without weakening token checks", async purpose => {
    fixture.token.purpose = purpose;
    if (purpose === "invite") Object.assign(fixture.target, { status: "invited", passwordHash: null });
    await expect(service.acceptLocalCredential({ token: rawToken, password: "aaaaaaaa" })).resolves.toEqual({ accepted: true });
    expect(fixture.tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "active", passwordHash: expect.any(String) }) }));
    const hash = fixture.tx.user.update.mock.calls[0][0].data.passwordHash;
    expect(await bcrypt.compare("aaaaaaaa", hash)).toBe(true);
  });
});

describe("bootstrap and tenant-scoped creation", () => {
  it.each([undefined, "", "   "])("accepts omitted/blank invitation name %j for bootstrap and ordinary invitations", async name => {
    const initialAdmin = { username: account.username, email: account.email, ...(name === undefined ? {} : { name }) };
    await service.bootstrapLocalCompany(root, { name: bootstrap.name, initialAdmin });
    await service.createLocalUser(localAuth, initialAdmin);
    for (const [args] of fixture.tx.user.create.mock.calls) expect(args.data.name).toBeUndefined();
  });
  it.each([undefined, "", "not a URL", "https://user:secret@example.com", "ftp://example.com"])("issues all credential links independently of APP_URL %j", async origin => {
    if (origin === undefined) delete process.env.APP_URL;
    else vi.stubEnv("APP_URL", origin);
    const results = [await service.bootstrapLocalCompany(root, bootstrap), await service.createLocalUser(localAuth, account), await service.issueLocalUserCredential(localAuth, "target-a", { purpose: "reset" })];
    Object.assign(fixture.target, { status: "invited", passwordHash: null });
    results.push(await service.updateLocalUser(localAuth, "target-a", { name: "Changed" }));
    for (const result of results) expect(result.credentialLink!.url).toMatch(/^\/login\/local\/accept\?token=[A-Za-z0-9_-]{43}$/);
  });
  it("atomically bootstraps invited first admin with explicit local-only flags and hashed relative link", async () => {
    const result = await service.bootstrapLocalCompany(root, bootstrap);
    const { tx } = fixture;
    expect(tx.company.create).toHaveBeenCalledWith({ data: { name: bootstrap.name, localAuthEnabled: true, oidcEnabled: false } });
    expect(tx.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ companyUuid: "tenant-new", authType: "local", username: "alice", email: "alice@example.com", localEmail: "alice@example.com", workspaceAdmin: true, status: "invited" }) });
    const url = new URL(result.credentialLink.url, "https://browser.example");
    const raw = url.searchParams.get("token")!;
    expect(result.credentialLink.url).toMatch(/^\/login\/local\/accept\?token=/);
    expect(url.origin).toBe("https://browser.example");
    expect(url.pathname).toBe("/login/local/accept");
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.userCredentialToken.create).toHaveBeenCalledWith({ data: {
      companyUuid: "tenant-new", userUuid: "target-a", tokenHash: createHash("sha256").update(raw).digest("hex"),
      purpose: "invite", sessionVersion: 3, expiresAt: new Date(result.credentialLink.expiresAt),
    } });
    expect(new Date(result.credentialLink.expiresAt).getTime() - Date.now()).toBeGreaterThan(service.CREDENTIAL_LINK_TTL_MS - 5000);
    expect(tx.localUserAudit.create).toHaveBeenCalledWith({ data: { companyUuid: "tenant-new", actorType: "super_admin", actorUuid: root.email, targetUuid: "target-a", action: "local_workspace_bootstrapped" } });
    expect(JSON.stringify(tx.localUserAudit.create.mock.calls)).not.toContain(raw);
    expectNoSecrets(result.user);
  });
  it("rejects non-superadmin and invalid bootstrap before writes", async () => {
    await expectStatus(service.bootstrapLocalCompany({ ...root, type: "user" } as unknown as SuperAdminAuthContext, bootstrap), 403);
    await expectStatus(service.bootstrapLocalCompany(root, { ...bootstrap, initialAdmin: { username: "@bad", email: "bad" } }), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(["user", "token", "audit"])("%s failure rejects whole bootstrap transaction without a committed orphan or leaking error secrets", async stage => {
    const pending: string[] = [];
    const committed: string[] = [];
    fixture.tx.company.create.mockImplementation(async () => { pending.push("company"); return { uuid: "tenant-new", name: "New workspace" }; });
    const failure = new Error(`database query leaked ${password} and ${rawToken}`);
    if (stage === "user") fixture.tx.user.create.mockRejectedValue(failure);
    if (stage === "token") fixture.tx.userCredentialToken.create.mockRejectedValue(failure);
    if (stage === "audit") fixture.tx.localUserAudit.create.mockRejectedValue(failure);
    // Model commit/rollback, not database correctness: all bootstrap writes must
    // occur in the same callback, and a late failure must escape that callback.
    db.$transaction.mockImplementation(async (fn: (tx: typeof fixture.tx) => Promise<unknown>) => {
      try { const result = await fn(fixture.tx); committed.push(...pending); return result; }
      catch (error) { pending.length = 0; throw error; }
    });
    await expect(service.bootstrapLocalCompany(root, bootstrap)).rejects.toMatchObject({ status: 500, message: "Local account operation failed" });
    expect(committed).toEqual([]);
    expect(pending).toEqual([]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
  it("normalizes invited creation and invalidates prior links before token issue", async () => {
    const result = await service.createLocalUser(localAuth, account);
    expectLocked();
    expect(result.user).toMatchObject({ username: "alice", email: "alice@example.com", status: "invited", workspaceAdmin: false });
    expect(fixture.tx.userCredentialToken.deleteMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", userUuid: "target-a" } });
    expect(fixture.tx.userCredentialToken.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(fixture.tx.userCredentialToken.create.mock.invocationCallOrder[0]);
    expectNoSecrets(result.user);
  });
  it.each(["username", "localEmail"])("maps same-tenant %s unique collisions to sanitized conflict", async field => {
    fixture.tx.user.create.mockRejectedValue({ code: "P2002", meta: { target: ["companyUuid", field], secret: password } });
    await expect(service.createLocalUser(localAuth, account)).rejects.toMatchObject({ status: 409, message: "Username or email already exists in this workspace" });
    expect(fixture.tx.userCredentialToken.create).not.toHaveBeenCalled();
  });
  it("does not impose global uniqueness: same identifiers are inserted under each authenticated tenant", async () => {
    await service.createLocalUser(localAuth, account);
    await service.createLocalUser({ ...localAuth, companyUuid: "tenant-b" }, account);
    expect(fixture.tx.user.create.mock.calls.map(([args]) => args.data.companyUuid)).toEqual(["tenant-a", "tenant-b"]);
    expect(fixture.tx.user.create.mock.calls.map(([args]) => args.data.username)).toEqual(["alice", "alice"]);
  });
});

describe("admin, tenant, state, and last-admin guards", () => {
  it.each(["agent", "super_admin"] as const)("rejects %s without even opening management transaction", async type => {
    await expectStatus(service.listLocalUsers({ ...localAuth, type }), 403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([{ workspaceAdmin: false }, { authType: "oidc" }, { status: "invited" }, { status: "disabled" }, { status: "deleted" }, { deletedAt: new Date() }, { passwordHash: null }])("revalidates actor inside lock and rejects ineligible admin %j", async patch => {
    Object.assign(fixture.actor, patch);
    await expectStatus(service.listLocalUsers(localAuth), 403);
    expectLocked();
    expect(fixture.tx.user.findMany).not.toHaveBeenCalled();
  });
  it.each([null, { localAuthEnabled: false, oidcEnabled: false }, { localAuthEnabled: true, oidcEnabled: true }])("rejects missing/nonlocal/SSO company %j", async company => {
    fixture.tx.company.findUnique.mockResolvedValue(company);
    await expectStatus(service.listLocalUsers(localAuth), 403);
    expect(fixture.tx.user.findFirst).not.toHaveBeenCalled();
  });
  it("rejects missing actor and scopes admin lookup to current tenant", async () => {
    fixture.tx.user.findFirst.mockResolvedValue(null);
    await expectStatus(service.listLocalUsers(localAuth), 403);
    expect(fixture.tx.user.findFirst).toHaveBeenCalledWith({ where: { uuid: "admin-a", companyUuid: "tenant-a" } });
  });
  it("lists only nondeleted local users with safe DTO and pagination", async () => {
    expect(await service.listLocalUsers(localAuth, 2, 10)).toEqual({ users: [service.publicLocalUser(fixture.target)], total: 1 });
    expect(fixture.tx.user.findMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", authType: "local", deletedAt: null, status: { not: "deleted" } }, skip: 10, take: 10, orderBy: [{ createdAt: "desc" }, { uuid: "asc" }] });
  });
  it.each([[0, 20], [1.5, 20], [1, 101], [1, 0], [NaN, 20], [Number.MAX_SAFE_INTEGER, 100]])("rejects invalid pagination %j %j", async (page, size) => {
    await expectStatus(service.listLocalUsers(localAuth, page, size), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(["edit", "remove", "credential"])("rejects cross-tenant/SSO/deleted target for %s", async operation => {
    fixture.tx.user.findFirst.mockResolvedValueOnce(fixture.actor).mockResolvedValueOnce(null);
    const work = operation === "edit" ? service.updateLocalUser(localAuth, "foreign-uuid", { name: "Changed" }) : operation === "remove" ? service.removeLocalUser(localAuth, "foreign-uuid") : service.issueLocalUserCredential(localAuth, "foreign-uuid", { purpose: "reset" });
    await expectStatus(work, 404);
    expect(fixture.tx.user.findFirst).toHaveBeenLastCalledWith({ where: { companyUuid: "tenant-a", uuid: "foreign-uuid", authType: "local", deletedAt: null, status: { not: "deleted" } } });
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(["disable", "demote", "remove", "invited-demote"])("preserves last effective/bootstrap admin on %s", async operation => {
    Object.assign(fixture.target, { workspaceAdmin: true }, operation === "invited-demote" ? { status: "invited", passwordHash: null } : {});
    fixture.tx.user.count.mockResolvedValue(0);
    const work = operation === "remove" ? service.removeLocalUser(localAuth, "target-a") : service.updateLocalUser(localAuth, "target-a", operation === "disable" ? { status: "disabled" } : { workspaceAdmin: false });
    await expectStatus(work, 409);
    expectLocked();
    expect(fixture.tx.user.count).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", uuid: { not: "target-a" }, authType: "local", workspaceAdmin: true, status: "active", passwordHash: { not: null }, deletedAt: null } });
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
    expect(fixture.tx.userCredentialToken.deleteMany).not.toHaveBeenCalled();
  });
  it("allows removal with another effective admin but tombstones UUID, clears credentials and revokes links", async () => {
    fixture.target.workspaceAdmin = true;
    const result = await service.removeLocalUser(localAuth, "target-a");
    expectLocked();
    expect(fixture.tx.user.update).toHaveBeenCalledWith({ where: { uuid: "target-a" }, data: { status: "deleted", deletedAt: expect.any(Date), username: null, localEmail: null, passwordHash: null, workspaceAdmin: false, sessionVersion: { increment: 1 } } });
    expect(fixture.tx.userCredentialToken.deleteMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", userUuid: "target-a" } });
    expect(result.user.uuid).toBe("target-a");
    expect(result.user.status).toBe("deleted");
    expectNoSecrets(result);
    expect(fixture.tx.localUserAudit.create).toHaveBeenCalledWith({ data: { companyUuid: "tenant-a", actorType: "user", actorUuid: "admin-a", targetUuid: "target-a", action: "local_user_removed" } });
  });
  it.each([{}, { passwordHash: "injected" }, { status: "deleted" }, { authType: "local" }])("rejects forbidden update input %j", async input => {
    await expectStatus(service.updateLocalUser(localAuth, "target-a", input), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("never activates an invitation through admin edit", async () => {
    Object.assign(fixture.target, { status: "invited", passwordHash: null });
    await expectStatus(service.updateLocalUser(localAuth, "target-a", { status: "active" }), 400);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("every edit normalizes identity and increments version while invalidating stale credentials", async () => {
    await service.updateLocalUser(localAuth, "target-a", { username: " New-User ", email: " NEW@example.com ", status: "disabled" });
    expect(fixture.tx.user.update).toHaveBeenCalledWith({ where: { uuid: "target-a" }, data: expect.objectContaining({ username: "new-user", email: "new@example.com", localEmail: "new@example.com", status: "disabled", sessionVersion: { increment: 1 } }) });
    expect(fixture.tx.userCredentialToken.deleteMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", userUuid: "target-a" } });
    expect(fixture.tx.userCredentialToken.create).not.toHaveBeenCalled();
  });
  it("editing invited identity returns a replacement invite bound to incremented version", async () => {
    Object.assign(fixture.target, { status: "invited", passwordHash: null });
    const result = await service.updateLocalUser(localAuth, "target-a", { name: "Changed" });
    expect(result.credentialLink?.purpose).toBe("invite");
    expect(fixture.tx.userCredentialToken.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sessionVersion: 4, purpose: "invite" }) });
    expectNoSecrets(fixture.tx.localUserAudit.create.mock.calls);
  });
  it.each(["disabled", "deleted", "invited"])("does not issue reset for %s user", async status => {
    fixture.target.status = status;
    await expectStatus(service.issueLocalUserCredential(localAuth, "target-a", { purpose: "reset" }), 400);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("reset reissue revokes sessions and replaces older links with new version binding", async () => {
    const result = await service.issueLocalUserCredential(localAuth, "target-a", { purpose: "reset" });
    expect(result.credentialLink?.purpose).toBe("reset");
    expect(fixture.tx.user.update).toHaveBeenCalledWith({ where: { uuid: "target-a" }, data: { sessionVersion: { increment: 1 } } });
    expect(fixture.tx.userCredentialToken.create).toHaveBeenCalledWith({ data: expect.objectContaining({ companyUuid: "tenant-a", userUuid: "target-a", sessionVersion: 4 }) });
    expectNoSecrets(fixture.tx.localUserAudit.create.mock.calls);
  });
});

describe("credential acceptance", () => {
  it.each(["missing", "expired", "used", "disabled", "stale"])("rejects %s credentials before expensive password hashing", async reason => {
    const hash = vi.spyOn(bcrypt, "hash");
    try {
      if (reason === "missing") fixture.tx.userCredentialToken.findUnique.mockResolvedValue(null);
      if (reason === "expired") fixture.token.expiresAt = new Date(0);
      if (reason === "used") Object.assign(fixture.token, { usedAt: new Date() });
      if (reason === "disabled") fixture.target.status = "disabled";
      if (reason === "stale") fixture.target.sessionVersion++;
      await expectStatus(accept(), 400);
      expect(hash).not.toHaveBeenCalled();
      expect(fixture.tx.user.update).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
  });
  it.each(["short", "a".repeat(73), "界".repeat(25)])("invalid password never consumes token or opens transaction %j", async unsafe => {
    await expectStatus(service.acceptLocalCredential({ token: rawToken, password: unsafe }), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(fixture.tx.userCredentialToken.updateMany).not.toHaveBeenCalled();
  });
  it.each([{}, { token: "bad", password }, { token: rawToken, password, companyUuid: "foreign" }])("rejects malformed/extra acceptance fields %j", async input => {
    await expectStatus(service.acceptLocalCredential(input), 400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "used", "purpose", "vanished-after-lock"])("rejects %s link without changing account", async reason => {
    if (reason === "missing") fixture.tx.userCredentialToken.findUnique.mockResolvedValue(null);
    if (reason === "expired") fixture.token.expiresAt = new Date(0);
    if (reason === "used") Object.assign(fixture.token, { usedAt: new Date() });
    if (reason === "purpose") fixture.token.purpose = "unexpected";
    if (reason === "vanished-after-lock") fixture.tx.userCredentialToken.findUnique.mockResolvedValueOnce(fixture.token).mockResolvedValueOnce(null);
    await expectStatus(accept(), 400);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
    expect(fixture.tx.userCredentialToken.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ status: "disabled" }, { status: "deleted" }, { deletedAt: new Date() }, { sessionVersion: 4 }, { passwordHash: null }])("reset cannot revive ineligible/stale account %j", async patch => {
    Object.assign(fixture.target, patch);
    await expectStatus(accept(), 400);
    expect(fixture.tx.userCredentialToken.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ status: "active" }, { status: "invited", passwordHash: "already-set" }])("invite rejects already activated/credentialed account %j", async patch => {
    fixture.token.purpose = "invite";
    Object.assign(fixture.target, patch);
    await expectStatus(accept(), 400);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
  });
  it("nonlocal company fails as generic invalid link", async () => {
    fixture.tx.company.findUnique.mockResolvedValue({ localAuthEnabled: false, oidcEnabled: true });
    await expect(service.acceptLocalCredential({ token: rawToken, password })).rejects.toMatchObject({ status: 400, message: "Invalid or expired credential link" });
  });
  it("atomic compare-and-consume failure prevents replay account mutation", async () => {
    fixture.tx.userCredentialToken.updateMany.mockResolvedValue({ count: 0 });
    await expectStatus(accept(), 400);
    expect(fixture.tx.user.update).not.toHaveBeenCalled();
    expect(fixture.tx.localUserAudit.create).not.toHaveBeenCalled();
  });
  it.each(["invite", "reset"])("accepts %s with bcrypt, hashed lookup, locked re-read, version binding and no implicit login", async purpose => {
    fixture.token.purpose = purpose;
    if (purpose === "invite") Object.assign(fixture.target, { status: "invited", passwordHash: null });
    expect(await accept()).toEqual({ accepted: true });
    expectLocked();
    const hash = createHash("sha256").update(rawToken).digest("hex");
    expect(fixture.tx.userCredentialToken.findUnique).toHaveBeenCalledTimes(2);
    expect(fixture.tx.userCredentialToken.findUnique).toHaveBeenNthCalledWith(2, { where: { tokenHash: hash } });
    expect(fixture.tx.userCredentialToken.findUnique.mock.invocationCallOrder[0]).toBeLessThan(fixture.tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(fixture.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(fixture.tx.userCredentialToken.findUnique.mock.invocationCallOrder[1]);
    expect(fixture.tx.user.findFirst).toHaveBeenCalledWith({ where: { uuid: "target-a", companyUuid: "tenant-a", authType: "local" } });
    expect(fixture.tx.userCredentialToken.updateMany).toHaveBeenCalledWith({ where: { uuid: "token-a", tokenHash: hash, companyUuid: "tenant-a", userUuid: "target-a", sessionVersion: 3, usedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { usedAt: expect.any(Date) } });
    const data = fixture.tx.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "active", sessionVersion: { increment: 1 } });
    expect(data.passwordHash).toMatch(/^\$2[ab]\$12\$/);
    expect(await bcrypt.compare(password, data.passwordHash)).toBe(true);
    expect(fixture.tx.userCredentialToken.deleteMany).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", userUuid: "target-a", uuid: { not: "token-a" } } });
    expect(fixture.tx.localUserAudit.create).toHaveBeenCalledWith({ data: { companyUuid: "tenant-a", actorType: "user", actorUuid: "target-a", targetUuid: "target-a", action: `local_${purpose}_accepted` } });
    expectNoSecrets(fixture.tx.localUserAudit.create.mock.calls);
    Object.assign(fixture.token, { usedAt: new Date() });
    await expectStatus(accept(), 400);
    expect(fixture.tx.user.update).toHaveBeenCalledTimes(1);
  });
});

describe("local credential verification", () => {
  it("uses tenant/normalized identity and returns safe version-bound identity only for valid eligible user", async () => {
    const hash = await bcrypt.hash(password, 4);
    db.user.findFirst.mockResolvedValue(makeLocalUser({ passwordHash: hash }));
    const result = await service.verifyLocalLoginCredentials("tenant-a", " ALICE@EXAMPLE.COM ", password);
    expect(result).toMatchObject({ uuid: "target-a", authType: "local", sessionVersion: 3 });
    expect(result).not.toHaveProperty("passwordHash");
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { companyUuid: "tenant-a", authType: "local", localEmail: "alice@example.com", company: { localAuthEnabled: true, oidcEnabled: false } } });
    expect(await service.verifyLocalLoginCredentials("tenant-a", "alice", "wrong-password-123")).toBeNull();
  });
  it.each([null, makeLocalUser({ status: "disabled" }), makeLocalUser({ status: "invited" }), makeLocalUser({ deletedAt: new Date() }), makeLocalUser({ passwordHash: null })])("rejects missing/ineligible user without exposing credentials", async user => {
    db.user.findFirst.mockResolvedValue(user);
    expect(await service.verifyLocalLoginCredentials("tenant-a", "alice", password)).toBeNull();
  });
  it("unsafe passwords bypass identity lookup while still returning generic failure", async () => {
    expect(await service.verifyLocalLoginCredentials("tenant-a", "alice", "short")).toBeNull();
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});
