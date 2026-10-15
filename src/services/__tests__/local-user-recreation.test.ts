import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@/generated/prisma/client";
import { localAuth, makeLocalUser, password, rawToken } from "./local-user.fixture";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(), user: { findFirst: vi.fn() },
  apiKey: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { acceptLocalCredential, createLocalUser, removeLocalUser } from "@/services/local-user.service";
import { createUserAccessToken, getUserSessionFromRequest } from "@/lib/user-session";
import { validateApiKey } from "@/lib/api-key";

type Token = { uuid: string; companyUuid: string; userUuid: string; tokenHash: string; purpose: string; sessionVersion: number; expiresAt: Date; usedAt: Date | null };
type Audit = { companyUuid: string; actorType: string; actorUuid: string; targetUuid: string; action: string };
let users: User[];
let tokens: Token[];
let audits: Audit[];
let target: User;

// Stateful persistence double: actual service writes drive subsequent reads and
// uniqueness checks. This is not a PostgreSQL locking/concurrency simulation.
function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (value && typeof value === "object") {
      if ("not" in value) return actual !== value.not;
      if ("gt" in value) return actual instanceof Date && actual > (value.gt as Date);
    }
    return actual === value;
  });
}
const tx = {
  $queryRaw: vi.fn(),
  company: { findUnique: vi.fn() },
  user: {
    findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(),
  },
  userCredentialToken: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  localUserAudit: { create: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_URL", "https://chorus.example.com");
  vi.stubEnv("NEXTAUTH_SECRET", "recreation-test-secret");
  target = makeLocalUser({ workspaceAdmin: true });
  users = [makeLocalUser({ uuid: localAuth.actorUuid, username: "admin", localEmail: "admin@example.com", workspaceAdmin: true }), target];
  tokens = [{ uuid: "old-token", companyUuid: target.companyUuid, userUuid: target.uuid, tokenHash: createHash("sha256").update(rawToken).digest("hex"), purpose: "reset", sessionVersion: target.sessionVersion, expiresAt: new Date(Date.now() + 60_000), usedAt: null }];
  audits = [];
  tx.$queryRaw.mockResolvedValue([]);
  tx.company.findUnique.mockResolvedValue({ uuid: localAuth.companyUuid, localAuthEnabled: true, oidcEnabled: false });
  tx.user.findFirst.mockImplementation(async ({ where }) => users.find(user => matches(user, where)) ?? null);
  tx.user.count.mockImplementation(async ({ where }) => users.filter(user => matches(user, where)).length);
  tx.user.create.mockImplementation(async ({ data }) => {
    if (users.some(user => user.companyUuid === data.companyUuid &&
      ((data.username !== null && user.username === data.username) || (data.localEmail !== null && user.localEmail === data.localEmail)))) throw { code: "P2002" };
    const user = makeLocalUser({ uuid: randomUUID(), passwordHash: null, sessionVersion: 0, ...data });
    users.push(user);
    return { ...user };
  });
  tx.user.update.mockImplementation(async ({ where, data }) => {
    const user = users.find(user => user.uuid === where.uuid)!;
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (key === "sessionVersion") user.sessionVersion += (value as { increment: number }).increment;
      else Object.assign(user, { [key]: value });
    }
    return { ...user };
  });
  tx.userCredentialToken.findUnique.mockImplementation(async ({ where }) => tokens.find(token => matches(token, where)) ?? null);
  tx.userCredentialToken.create.mockImplementation(async ({ data }) => {
    const token = { uuid: randomUUID(), usedAt: null, ...data };
    tokens.push(token);
    return token;
  });
  tx.userCredentialToken.deleteMany.mockImplementation(async ({ where }) => {
    const count = tokens.filter(token => matches(token, where)).length;
    tokens = tokens.filter(token => !matches(token, where));
    return { count };
  });
  tx.userCredentialToken.updateMany.mockImplementation(async ({ where, data }) => {
    const selected = tokens.filter(token => matches(token, where));
    selected.forEach(token => Object.assign(token, data));
    return { count: selected.length };
  });
  tx.localUserAudit.create.mockImplementation(async ({ data }) => { audits.push(data); return data; });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = structuredClone({ users, tokens, audits });
    try { return await fn(tx); }
    catch (error) { ({ users, tokens, audits } = before); throw error; }
  });
  db.user.findFirst.mockImplementation(async ({ where }) => {
    const user = users.find(user => matches(user, where));
    return user ? { ...user, company: { localAuthEnabled: true, oidcEnabled: false } } : null;
  });
  db.apiKey.findUnique.mockResolvedValue({ uuid: "old-key", revokedAt: null, expiresAt: null, agent: { uuid: "old-agent", name: "Old agent", companyUuid: target.companyUuid, ownerUuid: target.uuid, roles: ["developer_agent"], permissions: [] } });
  db.apiKey.update.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
const invite = () => createLocalUser(localAuth, { username: " ALICE ", email: " ALICE@EXAMPLE.COM " });

describe("deleted local identity reuse without inheritance", () => {
  it("releases both identifiers while retaining tombstone UUID, attribution and a fresh non-admin invitation", async () => {
    const original = { ...target };
    const removed = await removeLocalUser(localAuth, target.uuid);
    expect(removed.user).toMatchObject({ uuid: original.uuid, status: "deleted", username: "", email: original.email });
    expect(target).toMatchObject({ uuid: original.uuid, oidcSub: original.oidcSub, email: original.email, name: original.name, username: null, localEmail: null, status: "deleted", passwordHash: null, workspaceAdmin: false, sessionVersion: original.sessionVersion + 1 });
    expect(target.deletedAt).toBeInstanceOf(Date);
    expect(tokens).toEqual([]);
    const fresh = await invite();
    expect(fresh.user.uuid).not.toBe(original.uuid);
    expect(fresh.user).toMatchObject({ username: "alice", email: "alice@example.com", status: "invited", workspaceAdmin: false });
    const stored = users.find(user => user.uuid === fresh.user.uuid)!;
    expect(stored.oidcSub).not.toBe(original.oidcSub);
    expect(stored.passwordHash).toBeNull();
    expect(stored.sessionVersion).toBe(0);
    expect(users.find(user => user.uuid === original.uuid)).toBe(target);
    expect(audits.map(audit => [audit.action, audit.targetUuid])).toEqual([["local_user_removed", original.uuid], ["local_user_created", fresh.user.uuid]]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].userUuid).toBe(fresh.user.uuid);
    await expect(acceptLocalCredential({ token: rawToken, password })).rejects.toMatchObject({ status: 400 });
  });

  it.each(["active", "invited", "disabled"])("keeps normalized %s identities reserved", async status => {
    target.status = status;
    await expect(invite()).rejects.toMatchObject({ status: 409 });
    expect(users).toHaveLength(2);
    expect(audits).toEqual([]);
  });

  it.each(["username", "email"])("allows reuse of only the removed %s independently", async field => {
    await removeLocalUser(localAuth, target.uuid);
    const fresh = await createLocalUser(localAuth, {
      username: field === "username" ? "alice" : "another-user",
      email: field === "email" ? "alice@example.com" : "another@example.com",
    });
    expect(fresh.user.uuid).not.toBe(target.uuid);
  });

  it.each(["token", "audit"])("rolls back identity release and revocation on a late %s failure", async stage => {
    const before = structuredClone({ users, tokens, audits });
    if (stage === "token") tx.userCredentialToken.deleteMany.mockRejectedValueOnce(new Error("DB unavailable"));
    else tx.localUserAudit.create.mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(removeLocalUser(localAuth, target.uuid)).rejects.toMatchObject({ status: 500 });
    expect({ users, tokens, audits }).toEqual(before);
    await expect(invite()).rejects.toMatchObject({ status: 409 });
  });

  it("never resolves old cookies, Bearer tokens or owned Agent keys to the recreated active identity", async () => {
    const oldToken = await createUserAccessToken({ type: "user", userUuid: target.uuid, companyUuid: target.companyUuid, email: target.email!, oidcSub: target.oidcSub, authType: "local", sessionVersion: target.sessionVersion });
    expect((await validateApiKey("cho_old_key")).valid).toBe(true);
    await removeLocalUser(localAuth, target.uuid);
    const fresh = await invite();
    const token = new URL(fresh.credentialLink!.url).searchParams.get("token")!;
    await acceptLocalCredential({ token, password });
    const active = users.find(user => user.uuid === fresh.user.uuid)!;
    expect(active.status).toBe("active");
    expect(active.workspaceAdmin).toBe(false);
    const oldHeaders: Record<string, string>[] = [{ cookie: `user_session=${oldToken}` }, { authorization: `Bearer ${oldToken}` }];
    for (const headers of oldHeaders) {
      expect(await getUserSessionFromRequest(new NextRequest("https://chorus.example.com", { headers }))).toBeNull();
    }
    db.apiKey.update.mockClear();
    expect((await validateApiKey("cho_old_key")).valid).toBe(false);
    expect(db.apiKey.update).not.toHaveBeenCalled();
    const key = await db.apiKey.findUnique();
    expect(key.agent.ownerUuid).toBe(target.uuid);
    const freshSession = await createUserAccessToken({ type: "user", userUuid: active.uuid, companyUuid: active.companyUuid, email: active.email!, oidcSub: active.oidcSub, authType: "local", sessionVersion: active.sessionVersion });
    expect(await getUserSessionFromRequest(new NextRequest("https://chorus.example.com", { headers: { cookie: `user_session=${freshSession}` } }))).toMatchObject({ actorUuid: active.uuid, workspaceAdmin: false });
  });
});
