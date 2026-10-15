import { vi } from "vitest";
import type { User } from "@/generated/prisma/client";
import type { AuthContext } from "@/types/auth";

export const localAuth: AuthContext = { type: "user", companyUuid: "tenant-a", actorUuid: "admin-a" };
export const password = "a-valid-password-123";
export const rawToken = "A".repeat(43);
export function makeLocalUser(overrides: Partial<User> = {}): User {
  return {
    id: 1, uuid: "target-a", companyUuid: "tenant-a", oidcSub: "local_subject",
    email: "alice@example.com", name: "Alice", avatarUrl: null,
    authType: "local", username: "alice", localEmail: "alice@example.com",
    passwordHash: "existing-secret-hash", status: "active", workspaceAdmin: false,
    sessionVersion: 3, deletedAt: null, createdAt: new Date("2026-10-15T00:00:00Z"),
    ...overrides,
  };
}

// Deliberately does not emulate PostgreSQL locking. Tests assert the actual
// service's lock/query/transaction ordering; concurrency needs a real DB test.
export function makeLocalTx() {
  const actor = makeLocalUser({ uuid: localAuth.actorUuid, workspaceAdmin: true });
  const target = makeLocalUser();
  const token = {
    uuid: "token-a", companyUuid: "tenant-a", userUuid: target.uuid,
    tokenHash: "stored-token-hash", purpose: "reset", sessionVersion: 3,
    expiresAt: new Date(Date.now() + 60_000), usedAt: null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    company: {
      findUnique: vi.fn().mockResolvedValue({ uuid: "tenant-a", localAuthEnabled: true, oidcEnabled: false }),
      create: vi.fn().mockResolvedValue({ uuid: "tenant-new", name: "New workspace" }),
    },
    user: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { uuid: string } }) => where.uuid === actor.uuid ? actor : target),
      findMany: vi.fn().mockResolvedValue([target]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockImplementation(async ({ data }: { data: Partial<User> }) => makeLocalUser({ passwordHash: null, ...data })),
      update: vi.fn().mockImplementation(async ({ data }: { data: Omit<Partial<User>, "sessionVersion"> & { sessionVersion?: { increment: number } } }) => ({
        ...target, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
        sessionVersion: target.sessionVersion + (data.sessionVersion?.increment ?? 0),
      })),
    },
    userCredentialToken: {
      findUnique: vi.fn().mockResolvedValue(token),
      create: vi.fn().mockResolvedValue({ uuid: "token-new" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    localUserAudit: { create: vi.fn().mockResolvedValue({ uuid: "audit-a" }) },
  };
  return { tx, actor, target, token };
}
